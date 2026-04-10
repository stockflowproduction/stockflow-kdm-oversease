type LogCategory = 'userActions' | 'apiCalls' | 'stateChanges' | 'errors';

type TabName = 'Customer' | 'Seller' | 'Delivery' | 'Admin' | 'Inventory' | 'POS' | 'Reports' | 'Finance' | 'Unknown';

interface BaseLogEntry {
  id: string;
  tab: TabName;
  time: string;
}

interface UserActionLog extends BaseLogEntry {
  actionName: string;
  element: string;
  metadata?: Record<string, unknown>;
}

interface ApiCallLog extends BaseLogEntry {
  method: string;
  url: string;
  status: number;
  duration: number;
  request?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  count?: number;
}

interface StateChangeLog extends BaseLogEntry {
  type: string;
  from?: string;
  to?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

interface ErrorLog extends BaseLogEntry {
  type: 'API_ERROR' | 'UI_ERROR';
  message: string;
  stack?: string;
  metadata?: Record<string, unknown>;
}

interface AppLogsStore {
  userActions: UserActionLog[];
  apiCalls: ApiCallLog[];
  stateChanges: StateChangeLog[];
  errors: ErrorLog[];
}

declare global {
  interface Window {
    __APP_LOGS__?: AppLogsStore;
    generateSessionSummary?: () => string;
    exportLogs?: (download?: boolean) => AppLogsStore;
  }
}

const LOG_THROTTLE_MS = 700;
const API_DEDUPE_WINDOW_MS = 2000;
const MAX_LOGS_PER_BUCKET = 1500;
const USER_ACTION_EVENT = 'app-user-action';
const STATE_CHANGE_EVENT = 'app-state-change';

const throttleRegistry = new Map<string, number>();
const apiDedupeRegistry = new Map<string, { at: number; index: number }>();
let isInitialized = false;
const apiBatchQueue: ApiCallLog[] = [];
let apiBatchTimer: number | null = null;

const getCurrentPath = () => {
  const hashPath = window.location.hash?.replace(/^#/, '');
  if (hashPath && hashPath !== '/') return hashPath;
  return window.location.pathname || '/';
};

const getCurrentTab = (): TabName => {
  const path = getCurrentPath().toLowerCase();
  if (path.includes('customer')) return 'Customer';
  if (path.includes('seller')) return 'Seller';
  if (path.includes('delivery')) return 'Delivery';
  if (path.includes('admin')) return 'Admin';
  if (path.includes('sales')) return 'POS';
  if (path.includes('pdf') || path.includes('report')) return 'Reports';
  if (path.includes('finance')) return 'Finance';
  if (path.includes('/') || path.includes('inventory')) return 'Inventory';
  return 'Unknown';
};

const getLogsStore = (): AppLogsStore => {
  if (!window.__APP_LOGS__) {
    window.__APP_LOGS__ = {
      userActions: [],
      apiCalls: [],
      stateChanges: [],
      errors: [],
    };
  }
  return window.__APP_LOGS__;
};

const boundedPush = <T>(arr: T[], item: T) => {
  arr.push(item);
  if (arr.length > MAX_LOGS_PER_BUCKET) {
    arr.splice(0, arr.length - MAX_LOGS_PER_BUCKET);
  }
};

const shouldThrottle = (key: string, ms = LOG_THROTTLE_MS) => {
  const now = Date.now();
  const previous = throttleRegistry.get(key);
  throttleRegistry.set(key, now);
  return typeof previous === 'number' && now - previous < ms;
};

const summarizePayload = async (response: Response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return { contentType, body: '[non-json]' };
  }

  try {
    const clone = response.clone();
    const body = await clone.json();
    if (Array.isArray(body)) return { contentType, kind: 'array', size: body.length };
    if (body && typeof body === 'object') return { contentType, kind: 'object', keys: Object.keys(body).slice(0, 8) };
    return { contentType, value: typeof body };
  } catch {
    return { contentType, body: '[unreadable-json]' };
  }
};

export const logUserAction = (actionName: string, element: string, metadata?: Record<string, unknown>) => {
  const key = `${actionName}:${element}:${getCurrentTab()}`;
  if (shouldThrottle(key)) return;

  const entry: UserActionLog = {
    id: crypto.randomUUID(),
    actionName,
    element,
    tab: getCurrentTab(),
    metadata,
    time: new Date().toISOString(),
  };

  boundedPush(getLogsStore().userActions, entry);
};

export const logStateChange = (type: string, payload: Omit<StateChangeLog, 'id' | 'time' | 'tab' | 'type'> = {}) => {
  const entry: StateChangeLog = {
    id: crypto.randomUUID(),
    type,
    tab: getCurrentTab(),
    time: new Date().toISOString(),
    ...payload,
  };
  boundedPush(getLogsStore().stateChanges, entry);
};

export const logError = (type: ErrorLog['type'], message: string, stack?: string, metadata?: Record<string, unknown>) => {
  const entry: ErrorLog = {
    id: crypto.randomUUID(),
    type,
    message,
    stack,
    metadata,
    tab: getCurrentTab(),
    time: new Date().toISOString(),
  };
  boundedPush(getLogsStore().errors, entry);
  console.error(`[ERROR] ${type} | ${message} | tab: ${entry.tab}`);
};

const flushApiBatch = () => {
  if (!apiBatchQueue.length) return;
  const batch = apiBatchQueue.splice(0, apiBatchQueue.length);
  batch.forEach((entry) => {
    appendApiLog(entry);
  });
  apiBatchTimer = null;
};

const queueApiLog = (entry: ApiCallLog) => {
  apiBatchQueue.push(entry);
  if (apiBatchTimer !== null) return;
  apiBatchTimer = window.setTimeout(flushApiBatch, 350);
};

const appendApiLog = (entry: ApiCallLog) => {
  const logs = getLogsStore().apiCalls;
  const key = `${entry.method}:${entry.url}:${entry.status}`;
  const found = apiDedupeRegistry.get(key);
  const now = Date.now();

  if (found && now - found.at <= API_DEDUPE_WINDOW_MS && logs[found.index]) {
    const existing = logs[found.index];
    existing.count = (existing.count || 1) + 1;
    existing.duration = Math.round((existing.duration + entry.duration) / 2);
    apiDedupeRegistry.set(key, { at: now, index: found.index });
    return;
  }

  boundedPush(logs, entry);
  apiDedupeRegistry.set(key, { at: now, index: logs.length - 1 });
};

const installFetchInterceptor = () => {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const startedAt = performance.now();

    try {
      const response = await originalFetch(input, init);
      const summary = await summarizePayload(response);
      queueApiLog({
        id: crypto.randomUUID(),
        tab: getCurrentTab(),
        time: new Date().toISOString(),
        method,
        url,
        status: response.status,
        duration: Math.round(performance.now() - startedAt),
        request: {
          hasBody: Boolean(init?.body),
          mode: init?.mode || (input instanceof Request ? input.mode : undefined),
        },
        responseSummary: summary,
      });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown fetch failure';
      const duration = Math.round(performance.now() - startedAt);
      queueApiLog({
        id: crypto.randomUUID(),
        tab: getCurrentTab(),
        time: new Date().toISOString(),
        method,
        url,
        status: 0,
        duration,
        request: { hasBody: Boolean(init?.body) },
        responseSummary: { error: message },
      });
      logError('API_ERROR', `${method} ${url} failed: ${message}`);
      throw error;
    }
  };
};

const installXhrInterceptor = () => {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function open(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    (this as XMLHttpRequest & { __telemetry?: Record<string, unknown> }).__telemetry = {
      method: (method || 'GET').toUpperCase(),
      url: String(url),
      startedAt: performance.now(),
    };
    return originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest & { __telemetry?: Record<string, unknown> };
    const telemetry = xhr.__telemetry || {};
    const onLoadEnd = () => {
      queueApiLog({
        id: crypto.randomUUID(),
        tab: getCurrentTab(),
        time: new Date().toISOString(),
        method: String(telemetry.method || 'GET'),
        url: String(telemetry.url || ''),
        status: xhr.status || 0,
        duration: Math.round(performance.now() - Number(telemetry.startedAt || performance.now())),
        request: { hasBody: Boolean(body) },
        responseSummary: { transport: 'xhr', responseType: xhr.responseType || 'text' },
      });
    };
    xhr.addEventListener('loadend', onLoadEnd, { once: true });
    return originalSend.call(this, body);
  };
};

const resolveActionElementLabel = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element?.closest) return '';
  const actionable = element.closest('button, a, [role="button"], [role="link"], input[type="submit"]') as HTMLElement | null;
  if (!actionable) return '';

  const text = actionable.textContent?.trim();
  const aria = actionable.getAttribute('aria-label');
  const title = actionable.getAttribute('title');
  const id = actionable.id;
  return text || aria || title || id || actionable.tagName.toLowerCase();
};

const installUIActionTracking = () => {
  document.addEventListener('click', (event) => {
    const label = resolveActionElementLabel(event.target);
    if (!label) return;
    logUserAction(`Click "${label}"`, label, { path: getCurrentPath() });
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!form) return;
    const name = form.getAttribute('name') || form.id || 'form_submit';
    logUserAction('Submit Form', name, { path: getCurrentPath() });
  }, true);

  window.addEventListener('hashchange', () => {
    logUserAction('Navigation', getCurrentPath(), { source: 'hashchange' });
  });

  window.addEventListener(USER_ACTION_EVENT, (event) => {
    const detail = (event as CustomEvent<{ actionName: string; element: string; metadata?: Record<string, unknown> }>).detail;
    if (!detail) return;
    logUserAction(detail.actionName, detail.element, detail.metadata);
  });
};

const installStateAndErrorTracking = () => {
  window.addEventListener(STATE_CHANGE_EVENT, (event) => {
    const detail = (event as CustomEvent<Omit<StateChangeLog, 'id' | 'time' | 'tab'>>).detail;
    if (!detail?.type) return;
    logStateChange(detail.type, detail);
  });

  window.addEventListener('data-op-status', (event) => {
    const detail = (event as CustomEvent<{ phase: string; op: string; entity?: string; error?: string; transactionId?: string }>).detail;
    if (!detail) return;

    if (detail.error) {
      logError('UI_ERROR', detail.error, undefined, { op: detail.op, entity: detail.entity, transactionId: detail.transactionId });
      return;
    }

    logStateChange('data_operation', {
      from: detail.phase === 'start' ? 'idle' : undefined,
      to: detail.phase,
      entityId: detail.transactionId,
      metadata: { op: detail.op, entity: detail.entity },
    });
  });

  window.addEventListener('error', (event) => {
    logError('UI_ERROR', event.message || 'Unhandled window error', event.error?.stack);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    logError('UI_ERROR', `Unhandled promise rejection: ${message}`, reason instanceof Error ? reason.stack : undefined);
  });
};

const buildSummary = () => {
  const logs = getLogsStore();
  const journey = logs.userActions
    .filter(item => item.actionName === 'Navigation')
    .map(item => item.element)
    .slice(0, 12);
  const actionCounts = new Map<string, number>();
  logs.userActions.forEach(action => {
    actionCounts.set(action.actionName, (actionCounts.get(action.actionName) || 0) + 1);
  });

  const apiCounts = new Map<string, number>();
  logs.apiCalls.forEach(call => {
    const key = call.url;
    apiCounts.set(key, (apiCounts.get(key) || 0) + (call.count || 1));
  });

  const errorLine = logs.errors.length === 0
    ? '- None'
    : logs.errors.slice(-5).map(err => `- ${err.type}: ${err.message}`).join('\n');

  return [
    'SESSION SUMMARY:',
    '',
    'User Journey:',
    ...(journey.length ? journey.map((step, idx) => `- ${idx + 1}. ${step}`) : ['- No route transitions captured']),
    '',
    'Key Actions:',
    ...(Array.from(actionCounts.entries()).slice(0, 10).map(([name, count]) => `- ${name} (${count})`) || ['- None']),
    '',
    'API Activity:',
    ...(Array.from(apiCounts.entries()).slice(0, 10).map(([url, count]) => `- ${url} (${count} calls)`) || ['- None']),
    '',
    'Errors:',
    errorLine,
  ].join('\n');
};

export const generateSessionSummary = () => buildSummary();

export const exportLogs = (download = false) => {
  const logs = getLogsStore();
  if (download) {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `app-logs-${new Date().toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  return logs;
};

export const initializeBehaviorTracking = () => {
  if (isInitialized) return;
  isInitialized = true;
  getLogsStore();
  installFetchInterceptor();
  installXhrInterceptor();
  installUIActionTracking();
  installStateAndErrorTracking();
  window.generateSessionSummary = generateSessionSummary;
  window.exportLogs = exportLogs;
  logStateChange('session_initialized', { metadata: { path: getCurrentPath() } });
};

export const emitUserActionEvent = (actionName: string, element: string, metadata?: Record<string, unknown>) => {
  window.dispatchEvent(new CustomEvent(USER_ACTION_EVENT, { detail: { actionName, element, metadata } }));
};

export const emitStateChangeEvent = (type: string, payload: Omit<StateChangeLog, 'id' | 'time' | 'tab' | 'type'> = {}) => {
  window.dispatchEvent(new CustomEvent(STATE_CHANGE_EVENT, { detail: { type, ...payload } }));
};
