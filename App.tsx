import React, { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom';
import Auth from './pages/Auth';
import VerificationRequired from './pages/VerificationRequired';
import { getCurrentUser, logout } from './services/auth';
import { auth } from './services/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { loadData } from './services/storage';
import { emitFinanceSnapshot } from './utils/financeDebugLogger';
import { LayoutDashboard, ShoppingCart, FileText, Package, ArrowRightLeft, Users, Menu, X, Settings as SettingsIcon, LogOut, Landmark, ClipboardList, BarChart3, Send } from 'lucide-react';
import { Button, LightweightLoader } from './components/ui';
import { useVersionCheck } from './src/hooks/useVersionCheck';
import { perfLog } from './services/perf';
import { RouteReadyProvider } from './src/routing/routeReady';
import Settings from './pages/Settings';
import PrivacyPolicy from './pages/PrivacyPolicy';
import Terms from './pages/Terms';
import DataDeletion from './pages/DataDeletion';
import RoleLoginModal from './components/auth/RoleLoginModal';
import { RestrictedPage } from './components/auth/PermissionGuard';
import { can, clearAccessSession, type SimplePermission } from './src/auth/simplePermissions';
import { getStoredRoleSession, RoleSessionProvider, useRoleSession } from './src/auth/roleSession';
import { getCanonicalCustomerBalanceResult } from './services/customerBalanceView';
import { buildPurchasePartyLedger } from './services/purchaseLedger';
import { formatDateDisplay } from './src/utils/dateFormat';

const loadWhatsAppLogs = () => import('./pages/WhatsAppLogs');
const loadAdmin = () => import('./pages/Admin');
const loadSales = () => import('./pages/Sales');
const loadReports = () => import('./pages/Reports');
const loadTransactions = () => import('./pages/Transactions');
const loadCustomers = () => import('./pages/Customers');
const loadFinance = () => import('./pages/Finance');
const loadExpenseRepair = () => import('./pages/ExpenseRepair');
const loadPurchasePanel = () => import('./pages/PurchasePanel');
const loadProductAnalytics = () => import('./pages/ProductAnalytics');
const loadDashboard = () => import('./pages/Dashboard');
const loadCashbook = () => import('./pages/Cashbook');
const loadTelegramPosts = () => import('./pages/TelegramPosts');
const loadCustomerView = () => import('./pages/CustomerView');

const WhatsAppLogs = lazy(loadWhatsAppLogs);
const Admin = lazy(loadAdmin);
const Sales = lazy(loadSales);
const Reports = lazy(loadReports);
const Transactions = lazy(loadTransactions);
const Customers = lazy(loadCustomers);
const Finance = lazy(loadFinance);
const ExpenseRepair = lazy(loadExpenseRepair);
const PurchasePanel = lazy(loadPurchasePanel);
const ProductAnalytics = lazy(loadProductAnalytics);
const Dashboard = lazy(loadDashboard);
const Cashbook = lazy(loadCashbook);
const TelegramPosts = lazy(loadTelegramPosts);
const CustomerView = lazy(loadCustomerView);
const ADMIN_REMINDER_START_DATE = '2026-07-19T00:00:00';
const ADMIN_REMINDER_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_REMINDER_STORAGE_KEY = 'stockflow:admin-reminder:last-shown';
const NAVIGATION_SAFETY_TIMEOUT_MS = 10000;
const AUTH_BOOT_TIMEOUT_MS = 4000;

const ROUTE_PRELOADERS: Partial<Record<string, () => Promise<unknown>>> = {
  '/': loadAdmin,
  '/sales': loadSales,
  '/transactions': loadTransactions,
  '/dashboard': loadDashboard,
  '/finance': loadFinance,
  '/purchase-panel': loadPurchasePanel,
};

type PersistentRouteConfig = {
  path: string;
  label: string;
  component: React.ComponentType;
  permission?: SimplePermission;
};

const PERSISTENT_ROUTE_CONFIGS: PersistentRouteConfig[] = [
  { path: '/', label: 'Inventory', component: Admin },
  { path: '/transactions', label: 'Transactions', component: Transactions },
  { path: '/finance', label: 'Finance', component: Finance },
  { path: '/customers', label: 'Customers', component: Customers },
  { path: '/dashboard', label: 'Dashboard', component: Dashboard },
];

const getPersistentPageInstanceId = (path: string) => path === '/' ? 'persistent:inventory' : `persistent:${path.slice(1)}`;
const getRouteContainerClass = (path: string) => (
  path === '/customer-view'
    ? 'min-h-full p-0'
    : path === '/finance'
    ? 'min-h-full pb-20 md:pb-8'
    : 'min-h-full p-4 md:p-8 pb-20 md:pb-8 max-w-7xl mx-auto'
);

type AdminReminderSummary = {
  customerDueTotal: number;
  customerDueCount: number;
  supplierPayableTotal: number;
  supplierPayableCount: number;
  generatedAt: string;
};

// --- Components ---

type AppNavItemProps = {
  to: string;
  icon: any;
  label: string;
  labelClassName?: string;
  onNavigate?: (path: string, label: string) => void;
  onPreload?: (path: string) => void;
  isNavigating?: boolean;
};

const NavItem = ({ to, icon: Icon, label, labelClassName = '', onNavigate, onPreload, isNavigating = false }: AppNavItemProps) => {
  const location = useLocation();
  const isActive = location.pathname === to;
  return (
    <button
      type="button"
      onClick={() => {
        if (isNavigating) return;
        onNavigate?.(to, label);
      }}
      onMouseEnter={() => onPreload?.(to)}
      onFocus={() => onPreload?.(to)}
      disabled={isNavigating}
      aria-current={isActive ? 'page' : undefined}
      aria-label={label}
      className={`flex w-full items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg transition-colors ${
        isActive 
          ? 'bg-primary text-primary-foreground' 
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      } ${isNavigating ? 'cursor-progress' : ''}`}
    >
      <Icon className="w-5 h-5" />
      <span className={labelClassName}>{label}</span>
    </button>
  );
};

const MobileNavButton = ({
  to,
  label,
  icon: Icon,
  className,
  onNavigate,
  onPreload,
  isNavigating = false,
}: {
  to: string;
  label: string;
  icon: any;
  className: string;
  onNavigate?: (path: string, label: string) => void;
  onPreload?: (path: string) => void;
  isNavigating?: boolean;
}) => {
  const location = useLocation();
  const isActive = location.pathname === to;

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (isNavigating) return;
        onNavigate?.(to, label);
      }}
      onMouseEnter={() => onPreload?.(to)}
      onFocus={() => onPreload?.(to)}
      disabled={isNavigating}
      aria-current={isActive ? 'page' : undefined}
      aria-label={label}
    >
      <Icon className="w-5 h-5" />
      <span className="text-[10px] font-medium mt-1">{label}</span>
    </button>
  );
};


const RouteReadyBoundary = ({
  routePath,
  routeLabel,
  pageInstanceId,
  isActive,
  transitionId,
  onReady,
  children,
}: {
  routePath: string;
  routeLabel: string;
  pageInstanceId: string;
  isActive: boolean;
  transitionId: number | null;
  onReady: (routePath: string, routeLabel: string) => void;
  children: React.ReactElement;
}) => {
  const [shellPainted, setShellPainted] = React.useState(false);

  useEffect(() => {
    if (!isActive) return;
    setShellPainted(false);
  }, [isActive, routeLabel, routePath, transitionId]);

  useEffect(() => {
    if (!isActive) return;
    perfLog('navigation.route.render', {
      routePath,
      routeLabel,
      pageInstanceId,
      transitionId,
    });
  }, [isActive, pageInstanceId, routeLabel, routePath, transitionId]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    let didEmit = false;
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;

    perfLog('navigation.route.first_paint.schedule', {
      routePath,
      routeLabel,
      pageInstanceId,
      transitionId,
    });

    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null;
        if (cancelled) return;
        didEmit = true;
        perfLog('navigation.route.first_paint.emit', {
          routePath,
          routeLabel,
          pageInstanceId,
          transitionId,
        });
        perfLog('navigation.route.first_paint', {
          routePath,
          routeLabel,
          pageInstanceId,
          transitionId,
          source: 'boundary',
        });
        setShellPainted(true);
        onReady(routePath, routeLabel);
      });
    });

    return () => {
      cancelled = true;
      if (firstFrame !== null) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
      if (!didEmit) {
        perfLog('navigation.route.first_paint.cancel', {
          routePath,
          routeLabel,
          pageInstanceId,
          transitionId,
        });
      }
    };
  }, [isActive, onReady, pageInstanceId, routeLabel, routePath, transitionId]);

  return (
    <RouteReadyProvider value={{ routePath, routeLabel, transitionId, shellPainted, isRouteActive: isActive, pageInstanceId }}>
      {children}
    </RouteReadyProvider>
  );
};

const PersistentRouteSlot = ({
  config,
  isActive,
  transitionId,
  onReady,
}: {
  config: PersistentRouteConfig;
  isActive: boolean;
  transitionId: number | null;
  onReady: (routePath: string, routeLabel: string) => void;
}) => {
  const Component = config.component;
  const pageInstanceId = getPersistentPageInstanceId(config.path);
  return (
    <section
      key={config.path}
      className={getRouteContainerClass(config.path)}
      hidden={!isActive}
      aria-hidden={!isActive}
      data-route-path={config.path}
      data-route-active={isActive ? 'true' : 'false'}
    >
      <Suspense fallback={isActive ? <LightweightLoader label="Loading page..." className="min-h-[320px]" /> : null}>
        <RouteReadyBoundary
          routePath={config.path}
          routeLabel={config.label}
          pageInstanceId={pageInstanceId}
          isActive={isActive}
          transitionId={transitionId}
          onReady={onReady}
        >
          <Component />
        </RouteReadyBoundary>
      </Suspense>
    </section>
  );
};

const MenuController = ({ setIsMenuOpen }: { setIsMenuOpen: (open: boolean) => void }) => {
    const location = useLocation();
    useEffect(() => {
        setIsMenuOpen(false);
    }, [location]);
    return null;
};

const ProtectedRoute = ({ isVerified, children }: { isVerified: boolean; children: React.ReactElement }) => {
  if (!isVerified) {
    return <Navigate to="/verify-email" replace />;
  }
  return children;
};

const AccessControlledRoute = ({
  isVerified,
  children,
  permission,
  label,
}: {
  isVerified: boolean;
  children: React.ReactElement;
  permission?: SimplePermission;
  label?: string;
}) => {
  if (!isVerified) {
    return <Navigate to="/verify-email" replace />;
  }
  if (permission && !can(permission)) {
    return <RestrictedPage permission={permission} label={label || 'This page'} />;
  }
  return children;
};

function AppContent() {
  const location = useLocation();
  const navigate = useNavigate();
  const { session: roleSession, setSession: setRoleSession } = useRoleSession();
  const currentBuildId = typeof APP_BUILD_ID === 'string' ? APP_BUILD_ID : 'unknown';
  const { updateAvailable, latestVersionData, dismissUpdate } = useVersionCheck(currentBuildId);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<'loading' | 'authenticated' | 'unverified' | 'unauthenticated'>('loading');
  const [currentEmail, setCurrentEmail] = useState<string | null>(getCurrentUser());
  const [storeName, setStoreName] = useState('StockFlow');
  const [cloudStatus, setCloudStatus] = useState<{ status: string; message?: string }>({ status: navigator.onLine ? 'loading' : 'offline' });
  const [opStatus, setOpStatus] = useState<{ phase: 'start' | 'success' | 'error'; message: string; op?: string } | null>(null);
  const [salesCartCount, setSalesCartCount] = useState(0);
  const [showAdminReminder, setShowAdminReminder] = useState(false);
  const [adminReminderSummary, setAdminReminderSummary] = useState<AdminReminderSummary | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);
  const [navigationLabel, setNavigationLabel] = useState<string | null>(null);
  const navigationSafetyTimeoutRef = React.useRef<number | null>(null);
  const navigationSequenceRef = React.useRef(0);
  const navigationTraceRef = React.useRef<{ fromPath: string; targetPath: string; label: string; startedAt: number; transitionId: number } | null>(null);
  const previousPersistentActivePathRef = React.useRef<string | null>(null);
  const persistentRouteConfigByPath = React.useMemo(() => new Map(PERSISTENT_ROUTE_CONFIGS.map((config) => [config.path, config])), []);
  const activePersistentRouteConfig = persistentRouteConfigByPath.get(location.pathname) || null;
  const isPersistentRouteAllowed = React.useCallback((config: PersistentRouteConfig | null) => {
    if (!config) return false;
    if (authStatus !== 'authenticated') return false;
    if (config.permission && !can(config.permission)) return false;
    return true;
  }, [authStatus]);
  const isPersistentRouteActive = isPersistentRouteAllowed(activePersistentRouteConfig);
  const renderedPersistentPaths = React.useMemo(() => {
    // Unmount inactive pages so their datasets, workers, and listeners are released.
    return isPersistentRouteActive && activePersistentRouteConfig ? [activePersistentRouteConfig.path] : [];
  }, [activePersistentRouteConfig, isPersistentRouteActive]);

  const preloadRoute = React.useCallback((path: string) => {
    const preload = ROUTE_PRELOADERS[path];
    if (!preload) return;
    void preload();
  }, []);

  const clearNavigationState = React.useCallback((reason: 'route_ready' | 'timeout', routePath?: string, routeLabel?: string) => {
    if (navigationSafetyTimeoutRef.current !== null) {
      window.clearTimeout(navigationSafetyTimeoutRef.current);
      navigationSafetyTimeoutRef.current = null;
    }
    const trace = navigationTraceRef.current;
    if (trace && reason === 'route_ready' && routePath && trace.targetPath !== routePath) {
      perfLog('navigation.loader.end_ignored', {
        reason,
        routePath,
        routeLabel: routeLabel || null,
        transitionId: trace.transitionId,
        expectedTargetPath: trace.targetPath,
      });
      return;
    }
    if (trace) {
      const durationMs = Math.round((performance.now() - trace.startedAt) * 100) / 100;
      perfLog('navigation.loader.end', {
        fromPath: trace.fromPath,
        targetPath: trace.targetPath,
        targetLabel: trace.label,
        transitionId: trace.transitionId,
        routePath: routePath || null,
        readyRouteLabel: routeLabel || null,
        reason,
        durationMs,
      });
      navigationTraceRef.current = null;
    }
    setIsNavigating(false);
    setNavigationLabel(null);
  }, []);

  const startRouteNavigation = React.useCallback((path: string, label: string) => {
    if (path === location.pathname || isNavigating) return;
    const startedAt = performance.now();
    const transitionId = ++navigationSequenceRef.current;
    navigationTraceRef.current = {
      fromPath: location.pathname,
      targetPath: path,
      label,
      startedAt,
      transitionId,
    };
    perfLog('navigation.click', {
      fromPath: location.pathname,
      toPath: path,
      targetLabel: label,
      transitionId,
      startedAtMs: Math.round(startedAt * 100) / 100,
    });
    perfLog('navigation.loader.start', {
      fromPath: location.pathname,
      toPath: path,
      targetLabel: label,
      transitionId,
      startedAtMs: Math.round(startedAt * 100) / 100,
    });
    setIsNavigating(true);
    setNavigationLabel(`Opening ${label}...`);
    if (navigationSafetyTimeoutRef.current !== null) {
      window.clearTimeout(navigationSafetyTimeoutRef.current);
    }
    navigationSafetyTimeoutRef.current = window.setTimeout(() => {
      navigationSafetyTimeoutRef.current = null;
      clearNavigationState('timeout');
    }, NAVIGATION_SAFETY_TIMEOUT_MS);
    window.requestAnimationFrame(() => {
      perfLog('navigation.navigate.dispatch', {
        fromPath: location.pathname,
        toPath: path,
        targetLabel: label,
        transitionId,
      });
      navigate(path);
    });
  }, [clearNavigationState, isNavigating, location.pathname, navigate]);

  useEffect(() => {
    if (authStatus === 'authenticated') return;
    previousPersistentActivePathRef.current = null;
  }, [authStatus]);

  useEffect(() => {
    const nextActivePath = isPersistentRouteActive && activePersistentRouteConfig ? activePersistentRouteConfig.path : null;
    const previousActivePath = previousPersistentActivePathRef.current;

    if (previousActivePath && previousActivePath !== nextActivePath) {
      const previousConfig = persistentRouteConfigByPath.get(previousActivePath);
      if (previousConfig) {
        perfLog('route.cache.deactivate', {
          routePath: previousConfig.path,
          routeLabel: previousConfig.label,
          pageInstanceId: getPersistentPageInstanceId(previousConfig.path),
        });
      }
    }

    if (nextActivePath && activePersistentRouteConfig) {
      if (previousActivePath !== nextActivePath) {
        perfLog('route.cache.activate', {
          routePath: activePersistentRouteConfig.path,
          routeLabel: activePersistentRouteConfig.label,
          pageInstanceId: getPersistentPageInstanceId(activePersistentRouteConfig.path),
        });
      }
    }

    previousPersistentActivePathRef.current = nextActivePath;
  }, [activePersistentRouteConfig, isPersistentRouteActive, persistentRouteConfigByPath]);

  useEffect(() => {
    if (!auth) {
      const cachedUser = getCurrentUser();
      setCurrentEmail(cachedUser);
      setAuthStatus(cachedUser ? 'authenticated' : 'unauthenticated');
      return;
    }

    // Always preserve the real Firebase identity. The test-bypass flag is
    // handled by the access-role/OTP UI; it must never replace auth.currentUser.
    const resolveAuthStatus = (user: typeof auth.currentUser) => {
      if (!user) {
        clearAccessSession();
        setCurrentEmail(null);
        setAuthStatus('unauthenticated');
        return;
      }

      setCurrentEmail(user.email || null);
      setAuthStatus(user.emailVerified ? 'authenticated' : 'unverified');
    };

    const bootstrapFallback = window.setTimeout(() => {
      const fallbackUser = auth.currentUser;
      perfLog('auth.bootstrap.timeout_fallback', {
        hasCurrentUser: Boolean(fallbackUser),
        emailVerified: fallbackUser?.emailVerified ?? null,
      });
      resolveAuthStatus(fallbackUser);
    }, AUTH_BOOT_TIMEOUT_MS);

    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        window.clearTimeout(bootstrapFallback);
        resolveAuthStatus(user);
      },
      (error) => {
        window.clearTimeout(bootstrapFallback);
        perfLog('auth.bootstrap.error', {
          message: error instanceof Error ? error.message : String(error),
        });
        resolveAuthStatus(auth.currentUser);
      }
    );

    return () => {
      window.clearTimeout(bootstrapFallback);
      unsubscribe();
    };
  }, []);


  useEffect(() => {
      if (authStatus === 'authenticated') {
          const data = loadData();
          setStoreName(data.profile.storeName || 'StockFlow');
          emitFinanceSnapshot('app_load', data, { type: 'app_load', source: 'app' });
      }

      const handleStorageUpdate = () => {
         const data = loadData();
          setStoreName(data.profile.storeName || 'StockFlow');
      };

      window.addEventListener('local-storage-update', handleStorageUpdate);
      const handleCloudStatus = (event: Event) => {
        const detail = (event as CustomEvent<{ status: string; message?: string }>).detail;
        if (detail) setCloudStatus(detail);
      };
      const handleOpStatus = (event: Event) => {
        const detail = (event as CustomEvent<{ phase: 'start' | 'success' | 'error'; message?: string; error?: string; op?: string }>).detail;
        if (!detail) return;
        const message = detail.error || detail.message || (detail.phase === 'start' ? 'Saving…' : detail.phase === 'success' ? 'Saved.' : 'Operation failed.');
        setOpStatus({ phase: detail.phase, message, op: detail.op });
      };
      window.addEventListener('cloud-sync-status', handleCloudStatus as EventListener);
      window.addEventListener('data-op-status', handleOpStatus as EventListener);
      return () => {
        window.removeEventListener('local-storage-update', handleStorageUpdate);
        window.removeEventListener('cloud-sync-status', handleCloudStatus as EventListener);
        window.removeEventListener('data-op-status', handleOpStatus as EventListener);
      };
  }, [authStatus]);

  useEffect(() => {
    if (!opStatus || opStatus.phase === 'start') return;
    const t = setTimeout(() => setOpStatus(null), 3000);
    return () => clearTimeout(t);
  }, [opStatus]);

  useEffect(() => {
    const handleSalesCartState = (event: Event) => {
      const detail = (event as CustomEvent<{ count?: number }>).detail;
      setSalesCartCount(Number(detail?.count || 0));
    };
    window.addEventListener('sales-cart-state', handleSalesCartState as EventListener);
    return () => window.removeEventListener('sales-cart-state', handleSalesCartState as EventListener);
  }, []);

  const handleUpdate = () => {
    const currentHashPath = window.location.hash.replace('#', '') || '/';
    if (currentHashPath === '/sales' && salesCartCount > 0) {
      const shouldContinue = window.confirm('Unsaved transaction will be lost. Continue?');
      if (!shouldContinue) return;
    }
    const targetUrl = (latestVersionData?.targetUrl || '').trim();
    if (targetUrl) {
      window.location.assign(targetUrl);
      return;
    }
    window.location.reload();
  };

  const updateReleaseNotes = latestVersionData?.notes?.length ? latestVersionData.notes : [
    'Cancelled invoices no longer appear in Transaction Credit Received totals.',
    'Finance cash-session closing now handles cancelled cash invoices in the correct shift chronology.',
    'Same-shift invoice cancellations now net sale cash and refund cash to zero.',
    'Later-shift invoice cancellations now reduce only the refund shift instead of changing the original sale shift.',
    'Cashbook, Finance, Admin, and cash availability now ignore stale active copies of deleted invoices.',
  ];
  const updateVersionLabel = latestVersionData?.version ? `Version ${latestVersionData.version}` : null;
  const updateDateLabel = latestVersionData?.deployedAt
    ? formatDateDisplay(latestVersionData.deployedAt)
    : null;
  const updateToast = updateAvailable ? (
    <div className="fixed inset-0 z-[260] flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-title"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-800 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="app-update-title" className="text-lg font-bold text-slate-950">Update available</h2>
              {(updateVersionLabel || updateDateLabel) && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                  {[updateVersionLabel, updateDateLabel].filter(Boolean).join(' • ')}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-600">A new version is ready. Update now to load the latest fixes, or choose later to continue your current work.</p>
          </div>
          <button
            type="button"
            className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            onClick={dismissUpdate}
            aria-label="Remind me later"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-700">What changed</div>
          <ul className="mt-2 space-y-1.5 pl-4 text-xs leading-5 text-slate-600">
            {updateReleaseNotes.map((note) => (
              <li key={note} className="list-disc">{note}</li>
            ))}
          </ul>
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button size="sm" variant="outline" className="h-9 border-slate-200 px-4 text-slate-700 hover:bg-slate-50" onClick={dismissUpdate}>Later</Button>
          <Button size="sm" className="h-9 bg-slate-900 px-4 text-white hover:bg-slate-800" onClick={handleUpdate}>Update Now</Button>
        </div>
      </div>
    </div>
  ) : null;

  const handleLoginSuccess = () => {
    const user = auth?.currentUser;
    setCurrentEmail(user?.email || null);
    setAuthStatus(user?.emailVerified ? 'authenticated' : 'unverified');
  };

  const accessRoleLabel = roleSession?.role === 'operator' ? (roleSession.operatorName || 'Staff') : 'Admin';

  const handleFullLogout = () => {
    clearAccessSession();
    setRoleSession(null);
    void logout();
  };

  const handleAccessLogin = (session: { role: 'admin' | 'operator'; operatorId?: string; operatorName?: string; loginAt: string }) => {
    setRoleSession(session);
  };

  useEffect(() => {
    return () => {
      if (navigationSafetyTimeoutRef.current !== null) {
        window.clearTimeout(navigationSafetyTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated' || roleSession?.role !== 'admin') return;
    const reminderStartMs = new Date(ADMIN_REMINDER_START_DATE).getTime();
    const nowMs = Date.now();
    if (!Number.isFinite(reminderStartMs) || nowMs < reminderStartMs) return;
    const lastShownMs = Number(window.localStorage.getItem(ADMIN_REMINDER_STORAGE_KEY) || 0);
    if (Number.isFinite(lastShownMs) && lastShownMs > 0 && (nowMs - lastShownMs) < ADMIN_REMINDER_REPEAT_MS) return;

    const data = loadData();
    const customerDueEntries = (data.customers || [])
      .map((customer) => getCanonicalCustomerBalanceResult(customer, data.transactions || [], data.upfrontOrders || []))
      .filter((balance) => balance.status === 'ok' && balance.currentDue > 0.01);
    const customerDueTotal = customerDueEntries.reduce((sum, balance) => sum + Number(balance.currentDue || 0), 0);

    const supplierSummaries = (data.purchaseParties || [])
      .filter((party) => !(party as { isDeleted?: boolean }).isDeleted)
      .map((party) => buildPurchasePartyLedger({
        partyId: party.id,
        purchaseOrders: data.purchaseOrders || [],
        supplierPayments: data.supplierPayments || [],
        partyCreditLedger: data.partyCreditLedger || [],
      }).summary)
      .filter((summary) => summary.netPayable > 0.01);
    const supplierPayableTotal = supplierSummaries.reduce((sum, summary) => sum + Number(summary.netPayable || 0), 0);

    if (customerDueTotal <= 0.01 && supplierPayableTotal <= 0.01) return;

    setAdminReminderSummary({
      customerDueTotal,
      customerDueCount: customerDueEntries.length,
      supplierPayableTotal,
      supplierPayableCount: supplierSummaries.length,
      generatedAt: new Date().toISOString(),
    });
    setShowAdminReminder(true);
    window.localStorage.setItem(ADMIN_REMINDER_STORAGE_KEY, String(nowMs));
  }, [authStatus, roleSession]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || roleSession) return;
    const storedSession = getStoredRoleSession();
    if (storedSession) setRoleSession(storedSession);
  }, [authStatus, roleSession, setRoleSession]);

  const publicPaths = new Set(['/privacy-policy', '/terms', '/data-deletion']);
  const isPublicRoute = publicPaths.has(location.pathname);
  const isCustomerViewRoute = location.pathname === '/customer-view';

  if (authStatus === 'loading') {
    if (isPublicRoute) {
      return (
        <>
          <Routes>
            <Route path="/privacy-policy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/data-deletion" element={<DataDeletion />} />
            <Route path="*" element={<Navigate to="/privacy-policy" replace />} />
          </Routes>
          {updateToast}
        </>
      );
    }
    return (<><LightweightLoader label="Checking your session..." className="min-h-screen" />{updateToast}</>);
  }

  if (isPublicRoute) {
    return (
      <>
        <Routes>
          <Route path="/privacy-policy" element={<PrivacyPolicy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/data-deletion" element={<DataDeletion />} />
          <Route path="*" element={<Navigate to="/privacy-policy" replace />} />
        </Routes>
        {updateToast}
      </>
    );
  }

  if (authStatus === 'unauthenticated') {
      return (<><Auth onLogin={handleLoginSuccess} />{updateToast}</>);
  }

  if(authStatus==='unverified'){return(React.createElement(React.Fragment,null,React.createElement(VerificationRequired,{email:currentEmail?currentEmail:undefined}),updateToast));}if(!roleSession){return(React.createElement(React.Fragment,null,React.createElement(RoleLoginModal,{onLogin:handleAccessLogin}),updateToast));}return(
      <>
      <MenuController setIsMenuOpen={setIsMenuOpen} />
      <div className="flex h-screen bg-background overflow-hidden">
        {isNavigating && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/35 backdrop-blur-sm">
            <div className="rounded-xl border bg-background px-5 py-4 shadow-2xl">
              <LightweightLoader label={navigationLabel || 'Opening page...'} className="min-h-0 p-0" />
            </div>
          </div>
        )}
        {updateToast}
        {(cloudStatus.status === 'offline' || cloudStatus.status === 'missing_store' || cloudStatus.status === 'error') && (
          <div className="fixed top-0 left-0 right-0 z-[80] bg-red-600 text-white text-xs px-3 py-2 text-center">
            {cloudStatus.message || 'Live cloud data unavailable. Business data operations are blocked until connection is restored.'}
          </div>
        )}
        {opStatus && (
          <div className={`fixed bottom-4 right-4 z-[90] rounded-lg px-3 py-2 text-xs shadow-lg ${opStatus.phase === 'error' ? 'bg-red-600 text-white' : opStatus.phase === 'success' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-white'}`}>
            <div className="font-semibold">{opStatus.op || 'Data'}</div>
            <div>{opStatus.message}</div>
          </div>
        )}
        {!isCustomerViewRoute && (
        <>
        {/* Sidebar */}
        <div className="w-64 border-r bg-card flex flex-col hidden md:flex">
          <div className="p-6">
            <h1 className="text-xl font-bold flex items-center gap-2 truncate" title={storeName}>
              <Package className="w-8 h-8 text-primary shrink-0" />
              {storeName}
            </h1>
          </div>
          
          <nav className="flex-1 px-4 space-y-1">
            <p className="px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-2">Menu</p>
            <NavItem to="/dashboard" icon={LayoutDashboard} label="Dashboard" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />
            <NavItem to="/" icon={Package} label="Inventory" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />
            <NavItem to="/telegram-posts" icon={Send} label="Telegram Posts" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />
            <NavItem to="/sales" icon={ShoppingCart} label="Sales" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />
            <NavItem to="/transactions" icon={ArrowRightLeft} label="Transactions" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />
            {can('analytics') && <NavItem to="/product-analytics" icon={BarChart3} label="Product Analytics" onNavigate={startRouteNavigation} isNavigating={isNavigating} />}
            <NavItem to="/customers" icon={Users} label="Customers" onNavigate={startRouteNavigation} isNavigating={isNavigating} />
            {can('reports') && <NavItem to="/pdf" icon={FileText} label="Reports" onNavigate={startRouteNavigation} isNavigating={isNavigating} />}
            {can('settings') && <NavItem to="/settings" icon={SettingsIcon} label="Settings" onNavigate={startRouteNavigation} isNavigating={isNavigating} />}
            {can('cashbook') && <NavItem to="/cashbook" icon={Landmark} label="Cashbook" onNavigate={startRouteNavigation} isNavigating={isNavigating} />}
            <NavItem to="/finance" icon={Landmark} label="Finance" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />
            {can('purchases') && <NavItem to="/purchase-panel" icon={ClipboardList} label="Purchase Parties" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />}

          </nav>
          
          <div className="p-4 border-t flex flex-col gap-2">
             <div className="text-xs text-muted-foreground mt-2">
                <p>User: {currentEmail}</p>
                <p>Access: {accessRoleLabel}</p>
             </div>
             <Button variant="ghost" size="sm" onClick={handleFullLogout} className="w-full text-muted-foreground hover:text-destructive justify-start px-2">
                <LogOut className="w-4 h-4 mr-2" /> Logout
             </Button>
          </div>
        </div>

        {/* Mobile Navigation (Bottom) */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 bg-card border-t h-16 flex items-center justify-around px-2 z-50 safe-area-bottom shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
           <MobileNavButton to="/" label="Stock" icon={LayoutDashboard} className="flex flex-col items-center justify-center w-14 h-full text-muted-foreground hover:text-primary active:text-primary/70" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />
           <MobileNavButton to="/sales" label="Sales" icon={ShoppingCart} className="flex flex-col items-center justify-center w-14 h-full text-muted-foreground hover:text-primary active:text-primary/70" onNavigate={startRouteNavigation} onPreload={preloadRoute} isNavigating={isNavigating} />

           <MobileNavButton to="/customers" label="Clients" icon={Users} className="flex flex-col items-center justify-center w-14 h-full text-muted-foreground hover:text-primary active:text-primary/70" onNavigate={startRouteNavigation} isNavigating={isNavigating} />

           <button onClick={() => { if (!isNavigating) setIsMenuOpen(true); }} disabled={isNavigating} className="flex flex-col items-center justify-center w-14 h-full text-muted-foreground hover:text-primary active:text-primary/70 disabled:opacity-50">
               <Menu className="w-5 h-5" />
               <span className="text-[10px] font-medium mt-1">More</span>
            </button>
        </div>

        {/* Mobile Menu Overlay */}
        {isMenuOpen && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex flex-col justify-end animate-in slide-in-from-bottom-10" onClick={() => setIsMenuOpen(false)}>
                <div className="bg-card rounded-t-2xl p-6 space-y-4 pb-8" onClick={e => e.stopPropagation()}>
                     <div className="flex justify-between items-center mb-2">
                         <h3 className="font-bold text-lg">Menu</h3>
                         <Button variant="ghost" size="icon" onClick={() => setIsMenuOpen(false)}><X className="w-5 h-5" /></Button>
                     </div>
                     <div className="grid grid-cols-2 gap-4">
                         <button type="button" onClick={() => startRouteNavigation('/transactions', 'Transactions')} onMouseEnter={() => preloadRoute('/transactions')} onFocus={() => preloadRoute('/transactions')} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50">
                               <div className="p-3 bg-blue-100 text-blue-600 rounded-full mb-2">
                                   <ArrowRightLeft className="w-6 h-6" />
                               </div>
                               <span className="font-medium text-sm">Transactions</span>
                         </button>
                         {can('reports') && <button type="button" onClick={() => startRouteNavigation('/pdf', 'Reports')} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50">
                               <div className="p-3 bg-purple-100 text-purple-600 rounded-full mb-2">
                                   <FileText className="w-6 h-6" />
                               </div>
                               <span className="font-medium text-sm">Reports</span>
                         </button>}
                         <button type="button" onClick={() => startRouteNavigation('/dashboard', 'Dashboard')} onMouseEnter={() => preloadRoute('/dashboard')} onFocus={() => preloadRoute('/dashboard')} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50">
                               <div className="p-3 bg-indigo-100 text-indigo-600 rounded-full mb-2">
                                   <LayoutDashboard className="w-6 h-6" />
                               </div>
                               <span className="font-medium text-sm">Dashboard</span>
                         </button>
                         <button type="button" onClick={() => startRouteNavigation('/telegram-posts', 'Telegram Posts')} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50">
                               <div className="p-3 bg-sky-100 text-sky-700 rounded-full mb-2">
                                   <Send className="w-6 h-6" />
                               </div>
                               <span className="font-medium text-sm">Telegram Posts</span>
                         </button>
                         {can('analytics') && <button type="button" onClick={() => startRouteNavigation('/product-analytics', 'Product Analytics')} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50">
                               <div className="p-3 bg-cyan-100 text-cyan-600 rounded-full mb-2">
                                   <BarChart3 className="w-6 h-6" />
                               </div>
                               <span className="font-medium text-sm">Product Analytics</span>
                         </button>}
                         <button type="button" onClick={() => startRouteNavigation('/finance', 'Finance')} onMouseEnter={() => preloadRoute('/finance')} onFocus={() => preloadRoute('/finance')} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50">
                               <div className="p-3 bg-emerald-100 text-emerald-600 rounded-full mb-2">
                                   <Landmark className="w-6 h-6" />
                               </div>
                               <span className="font-medium text-sm">Finance</span>
                         </button>
                         {can('purchases') && <button type="button" onClick={() => startRouteNavigation('/purchase-panel', 'Purchase Parties')} onMouseEnter={() => preloadRoute('/purchase-panel')} onFocus={() => preloadRoute('/purchase-panel')} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50">
                               <div className="p-3 bg-cyan-100 text-cyan-600 rounded-full mb-2">
                                   <ClipboardList className="w-6 h-6" />
                               </div>
                               <span className="font-medium text-sm">Purchase Parties</span>
                         </button>}
                         {can('settings') && <button type="button" onClick={() => startRouteNavigation('/settings', 'Settings')} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50">
                               <div className="p-3 bg-gray-100 text-gray-600 rounded-full mb-2">
                                   <SettingsIcon className="w-6 h-6" />
                               </div>
                               <span className="font-medium text-sm">Settings</span>
                         </button>}
                         <button onClick={handleFullLogout} disabled={isNavigating} className="flex flex-col items-center justify-center p-4 bg-red-50 rounded-xl hover:bg-red-100 transition-colors border border-red-200 disabled:opacity-50">
                               <div className="p-3 bg-white text-red-600 rounded-full mb-2 shadow-sm">
                                   <LogOut className="w-6 h-6" />
                               </div>
                              <span className="font-medium text-sm text-red-700">Logout</span>
                         </button>
                    </div>
                </div>
            </div>
        )}

        </>
        )}

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-background">
          {renderedPersistentPaths.map((path) => {
            const config = persistentRouteConfigByPath.get(path);
            if (!config) return null;
            if (!isPersistentRouteAllowed(config) && location.pathname === config.path) return null;
            return (
              <PersistentRouteSlot
                key={config.path}
                config={config}
                isActive={location.pathname === config.path && isPersistentRouteAllowed(config)}
                transitionId={navigationTraceRef.current?.transitionId ?? null}
                onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}
              />
            );
          })}
          {!isPersistentRouteActive && (
            <div className={getRouteContainerClass(location.pathname)}>
              <Suspense fallback={<LightweightLoader label="Loading page..." className="min-h-[320px]" />}>
              <Routes>
                <Route path="/" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><RouteReadyBoundary routePath="/" routeLabel="Inventory" pageInstanceId={getPersistentPageInstanceId('/')} isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Admin /></RouteReadyBoundary></ProtectedRoute>} />
                <Route path="/telegram-posts" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><RouteReadyBoundary routePath="/telegram-posts" routeLabel="Telegram Posts" pageInstanceId="route:telegram-posts" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><TelegramPosts /></RouteReadyBoundary></ProtectedRoute>} />
                <Route path="/transactions" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><RouteReadyBoundary routePath="/transactions" routeLabel="Transactions" pageInstanceId={getPersistentPageInstanceId('/transactions')} isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Transactions /></RouteReadyBoundary></ProtectedRoute>} />
                <Route path="/dashboard" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><RouteReadyBoundary routePath="/dashboard" routeLabel="Dashboard" pageInstanceId={getPersistentPageInstanceId('/dashboard')} isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Dashboard /></RouteReadyBoundary></ProtectedRoute>} />
                <Route path="/product-analytics" element={<AccessControlledRoute isVerified={authStatus === "authenticated"} permission="analytics" label="Product Analytics"><RouteReadyBoundary routePath="/product-analytics" routeLabel="Product Analytics" pageInstanceId="route:product-analytics" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><ProductAnalytics /></RouteReadyBoundary></AccessControlledRoute>} />
                <Route path="/customers" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><RouteReadyBoundary routePath="/customers" routeLabel="Customers" pageInstanceId={getPersistentPageInstanceId('/customers')} isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Customers /></RouteReadyBoundary></ProtectedRoute>} />
                <Route path="/pdf" element={<AccessControlledRoute isVerified={authStatus === "authenticated"} permission="reports" label="Reports"><RouteReadyBoundary routePath="/pdf" routeLabel="Reports" pageInstanceId="route:pdf" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Reports /></RouteReadyBoundary></AccessControlledRoute>} />
                <Route path="/settings" element={<AccessControlledRoute isVerified={authStatus === "authenticated"} permission="settings" label="Settings"><RouteReadyBoundary routePath="/settings" routeLabel="Settings" pageInstanceId="route:settings" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Settings /></RouteReadyBoundary></AccessControlledRoute>} />
                <Route path="/whatsapp-logs" element={<AccessControlledRoute isVerified={authStatus === "authenticated"} permission="settings" label="WhatsApp Logs"><RouteReadyBoundary routePath="/whatsapp-logs" routeLabel="WhatsApp Logs" pageInstanceId="route:whatsapp-logs" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><WhatsAppLogs /></RouteReadyBoundary></AccessControlledRoute>} />
                <Route path="/cashbook" element={<AccessControlledRoute isVerified={authStatus === "authenticated"} permission="cashbook" label="Cashbook"><RouteReadyBoundary routePath="/cashbook" routeLabel="Cashbook" pageInstanceId="route:cashbook" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Cashbook /></RouteReadyBoundary></AccessControlledRoute>} />
                <Route path="/finance" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><RouteReadyBoundary routePath="/finance" routeLabel="Finance" pageInstanceId={getPersistentPageInstanceId('/finance')} isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Finance /></RouteReadyBoundary></ProtectedRoute>} />
                <Route path="/expense-repair" element={<AccessControlledRoute isVerified={authStatus === "authenticated"} permission="settings" label="Expense Repair"><RouteReadyBoundary routePath="/expense-repair" routeLabel="Expense Repair" pageInstanceId="route:expense-repair" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><ExpenseRepair /></RouteReadyBoundary></AccessControlledRoute>} />
                <Route path="/purchase-panel" element={<AccessControlledRoute isVerified={authStatus === "authenticated"} permission="purchases" label="Purchase Parties"><RouteReadyBoundary routePath="/purchase-panel" routeLabel="Purchase Parties" pageInstanceId="route:purchase-panel" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><PurchasePanel /></RouteReadyBoundary></AccessControlledRoute>} />
                
                {/* Unprotected Route (POS) */}
                <Route path="/sales" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><RouteReadyBoundary routePath="/sales" routeLabel="Sales" pageInstanceId="route:sales" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><Sales /></RouteReadyBoundary></ProtectedRoute>} />
                <Route path="/customer-view" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><RouteReadyBoundary routePath="/customer-view" routeLabel="Customer View" pageInstanceId="route:customer-view" isActive transitionId={navigationTraceRef.current?.transitionId ?? null} onReady={(routePath, routeLabel) => clearNavigationState('route_ready', routePath, routeLabel)}><CustomerView /></RouteReadyBoundary></ProtectedRoute>} />
                
                <Route path="/verify-email" element={<VerificationRequired email={currentEmail || undefined} />} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
              </Suspense>
            </div>
          )}
        </main>
      </div>
      {authStatus === 'authenticated' && !roleSession && <RoleLoginModal onLogin={handleAccessLogin} />}
      {showAdminReminder && adminReminderSummary && roleSession?.role === 'admin' && (
        <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-2xl border bg-white shadow-2xl">
            <div className="border-b px-5 py-4">
              <div className="text-lg font-semibold text-slate-950">Admin collections and payable reminder</div>
              <div className="mt-1 text-sm text-slate-500">
                This reminder will begin on 19-07-2026 and then reappear every 7 days after an admin login.
              </div>
            </div>
            <div className="grid gap-4 px-5 py-5 md:grid-cols-2">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Customer collections</div>
                <div className="mt-2 text-2xl font-bold text-emerald-900">Rs {adminReminderSummary.customerDueTotal.toFixed(2)}</div>
                <div className="mt-1 text-sm text-emerald-800">{adminReminderSummary.customerDueCount} customer account(s) have receivable due.</div>
              </div>
              <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-orange-700">Supplier payables</div>
                <div className="mt-2 text-2xl font-bold text-orange-900">Rs {adminReminderSummary.supplierPayableTotal.toFixed(2)}</div>
                <div className="mt-1 text-sm text-orange-800">{adminReminderSummary.supplierPayableCount} party account(s) need payment attention.</div>
              </div>
            </div>
            <div className="border-t px-5 py-4">
              <div className="mb-3 text-xs text-slate-500">Generated on {formatDateDisplay(adminReminderSummary.generatedAt)}.</div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowAdminReminder(false);
                    navigate('/customers');
                  }}
                >
                  Review collections
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowAdminReminder(false);
                    navigate('/purchase-panel');
                  }}
                >
                  Review payables
                </Button>
                <Button onClick={() => setShowAdminReminder(false)}>Dismiss</Button>
              </div>
            </div>
          </div>
        </div>
      )}
      </>
  );
}

export default function App() {
  return <RoleSessionProvider><Router><AppContent /></Router></RoleSessionProvider>;
}


