import React, { useState, useEffect } from 'react';
import { HashRouter as Router, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import Admin from './pages/Admin';
import Sales from './pages/Sales';
import Reports from './pages/Reports';
import Transactions from './pages/Transactions';
import Customers from './pages/Customers';
import Settings from './pages/Settings';
import Finance from './pages/Finance';
import FreightBooking from './pages/FreightBooking';
import PurchasePanel from './pages/PurchasePanel';
import Auth from './pages/Auth';
import VerificationRequired from './pages/VerificationRequired';
import { getCurrentUser, logout } from './services/auth';
import { auth } from './services/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { loadData } from './services/storage';
import { LayoutDashboard, ShoppingCart, FileText, Package, ArrowRightLeft, Users, Menu, X, Settings as SettingsIcon, LogOut, Landmark, Truck, ClipboardList } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from './components/ui';

// --- Components ---

const NavItem = ({ to, icon: Icon, label }: { to: string, icon: any, label: string }) => {
  const location = useLocation();
  const isActive = location.pathname === to;
  return (
    <Link 
      to={to} 
      className={`flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg transition-colors ${
        isActive 
          ? 'bg-primary text-primary-foreground' 
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <Icon className="w-5 h-5" />
      {label}
    </Link>
  );
};

const QuickLink = ({ to, icon: Icon, label }: { to: string, icon: any, label: string }) => {
    return (
      <Link 
        to={to} 
        className="flex items-center gap-3 px-4 py-2 text-sm font-medium rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      >
        <Icon className="w-4 h-4" />
        {label}
      </Link>
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

export default function App() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<'loading' | 'authenticated' | 'unverified' | 'unauthenticated'>('loading');
  const [currentEmail, setCurrentEmail] = useState<string | null>(getCurrentUser());
  const [storeName, setStoreName] = useState('StockFlow');
  const [cloudStatus, setCloudStatus] = useState<{ status: string; message?: string }>({ status: navigator.onLine ? 'loading' : 'offline' });
  const [opStatus, setOpStatus] = useState<{ phase: 'start' | 'success' | 'error'; message: string; op?: string } | null>(null);

  useEffect(() => {
    if (!auth) {
      const cachedUser = getCurrentUser();
      setCurrentEmail(cachedUser);
      setAuthStatus(cachedUser ? 'authenticated' : 'unauthenticated');
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setCurrentEmail(null);
        setAuthStatus('unauthenticated');
        return;
      }

      setCurrentEmail(user.email || null);
      setAuthStatus(user.emailVerified ? 'authenticated' : 'unverified');
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
      if (authStatus === 'authenticated') {
          const data = loadData();
          setStoreName(data.profile.storeName || 'StockFlow');
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

  const handleLoginSuccess = () => {
      setAuthStatus('authenticated');
  };

  if (authStatus === 'loading') {
    return <div className="min-h-screen bg-background" />;
  }

  if (authStatus === 'unauthenticated') {
      return <Auth onLogin={handleLoginSuccess} />;
  }

  if (authStatus === 'unverified') {
      return <VerificationRequired email={currentEmail || undefined} />;
  }

  return (
    <Router>
      <MenuController setIsMenuOpen={setIsMenuOpen} />
      <div className="flex h-screen bg-background overflow-hidden">
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
            <NavItem to="/" icon={LayoutDashboard} label="Inventory" />
            <NavItem to="/sales" icon={ShoppingCart} label="POS System" />
            <NavItem to="/transactions" icon={ArrowRightLeft} label="Transactions" />
            <NavItem to="/customers" icon={Users} label="Customers" />
            <NavItem to="/pdf" icon={FileText} label="Reports" />
            <NavItem to="/settings" icon={SettingsIcon} label="Settings" />
            <NavItem to="/finance" icon={Landmark} label="Finance" />
            <NavItem to="/freight-booking" icon={Truck} label="Freight Booking" />
            <NavItem to="/purchase-panel" icon={ClipboardList} label="Purchase Panel" />

            <div className="pt-6">
                <p className="px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Quick Actions</p>
                <QuickLink to="/sales?mode=sale" icon={ShoppingCart} label="Quick Sale" />
                <QuickLink to="/sales?mode=return" icon={ArrowRightLeft} label="Quick Return" />
            </div>
          </nav>
          
          <div className="p-4 border-t flex flex-col gap-2">
             <div className="text-xs text-muted-foreground mt-2">
                <p>User: {currentEmail}</p>
             </div>
             <Button variant="ghost" size="sm" onClick={logout} className="w-full text-muted-foreground hover:text-destructive justify-start px-2">
                <LogOut className="w-4 h-4 mr-2" /> Logout
             </Button>
          </div>
        </div>

        {/* Mobile Navigation (Bottom) */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 bg-card border-t h-16 flex items-center justify-around px-2 z-50 safe-area-bottom shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
           <Link to="/" className="flex flex-col items-center justify-center w-14 h-full text-muted-foreground hover:text-primary active:text-primary/70">
              <LayoutDashboard className="w-5 h-5" />
              <span className="text-[10px] font-medium mt-1">Stock</span>
           </Link>
           <Link to="/sales" className="flex flex-col items-center justify-center w-14 h-full text-muted-foreground hover:text-primary active:text-primary/70">
              <ShoppingCart className="w-5 h-5" />
              <span className="text-[10px] font-medium mt-1">POS</span>
           </Link>

           <Link to="/customers" className="flex flex-col items-center justify-center w-14 h-full text-muted-foreground hover:text-primary active:text-primary/70">
              <Users className="w-5 h-5" />
              <span className="text-[10px] font-medium mt-1">Clients</span>
           </Link>

           <button onClick={() => setIsMenuOpen(true)} className="flex flex-col items-center justify-center w-14 h-full text-muted-foreground hover:text-primary active:text-primary/70">
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
                         <Link to="/transactions" className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20">
                              <div className="p-3 bg-blue-100 text-blue-600 rounded-full mb-2">
                                  <ArrowRightLeft className="w-6 h-6" />
                              </div>
                              <span className="font-medium text-sm">Transactions</span>
                         </Link>
                         <Link to="/pdf" className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20">
                              <div className="p-3 bg-purple-100 text-purple-600 rounded-full mb-2">
                                  <FileText className="w-6 h-6" />
                              </div>
                              <span className="font-medium text-sm">Reports</span>
                         </Link>
                         <Link to="/finance" className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20">
                              <div className="p-3 bg-emerald-100 text-emerald-600 rounded-full mb-2">
                                  <Landmark className="w-6 h-6" />
                              </div>
                              <span className="font-medium text-sm">Finance</span>
                         </Link>
                         <Link to="/freight-booking" className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20">
                              <div className="p-3 bg-orange-100 text-orange-600 rounded-full mb-2">
                                  <Truck className="w-6 h-6" />
                              </div>
                              <span className="font-medium text-sm">Freight Booking</span>
                         </Link>
                         <Link to="/purchase-panel" className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20">
                              <div className="p-3 bg-cyan-100 text-cyan-600 rounded-full mb-2">
                                  <ClipboardList className="w-6 h-6" />
                              </div>
                              <span className="font-medium text-sm">Purchase Panel</span>
                         </Link>
                         <Link to="/settings" className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl hover:bg-muted transition-colors border border-transparent hover:border-primary/20">
                              <div className="p-3 bg-gray-100 text-gray-600 rounded-full mb-2">
                                  <SettingsIcon className="w-6 h-6" />
                              </div>
                              <span className="font-medium text-sm">Settings</span>
                         </Link>
                         <button onClick={logout} className="flex flex-col items-center justify-center p-4 bg-red-50 rounded-xl hover:bg-red-100 transition-colors border border-red-200">
                              <div className="p-3 bg-white text-red-600 rounded-full mb-2 shadow-sm">
                                  <LogOut className="w-6 h-6" />
                              </div>
                              <span className="font-medium text-sm text-red-700">Logout</span>
                         </button>
                    </div>
                </div>
            </div>
        )}

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-background">
          <div className="h-full p-4 md:p-8 pb-20 md:pb-8 max-w-7xl mx-auto">
            <Routes>
              <Route path="/" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><Admin /></ProtectedRoute>} />
              <Route path="/transactions" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><Transactions /></ProtectedRoute>} />
              <Route path="/customers" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><Customers /></ProtectedRoute>} />
              <Route path="/pdf" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><Reports /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><Settings /></ProtectedRoute>} />
              <Route path="/finance" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><Finance /></ProtectedRoute>} />
              <Route path="/freight-booking" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><FreightBooking /></ProtectedRoute>} />
              <Route path="/purchase-panel" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><PurchasePanel /></ProtectedRoute>} />
              
              {/* Unprotected Route (POS) */}
              <Route path="/sales" element={<ProtectedRoute isVerified={authStatus === "authenticated"}><Sales /></ProtectedRoute>} />
              
              <Route path="/verify-email" element={<VerificationRequired email={currentEmail || undefined} />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </div>
        </main>
      </div>
    </Router>
  );
}
