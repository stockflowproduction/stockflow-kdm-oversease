const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const PORT = process.env.PORT || 3100;
const stateFile = path.join(__dirname, 'data', 'whatsapp-state.json');

app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use((req, _res, next) => { console.log(req.method, req.path); next(); });

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  }
}));

const clients = new Map();
const qrCodes = new Map();
const sessionStatus = new Map();
const initializingUsers = new Set();
const explicitLogoutUsers = new Set();
let state = loadState();

function requireApiKey(req, res, next) {
  const expected = process.env.WHATSAPP_API_KEY;
  if (!expected) return next();
  const got = req.header('x-api-key');
  if (got !== expected) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  next();
}

function loadState() {
  try {
    if (!fs.existsSync(stateFile)) return {};
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[state] save failed', e?.message || e);
  }
}

function getMetric(userId) {
  if (!state[userId]) {
    state[userId] = {
      userId,
      connected: false,
      connectedNumber: null,
      sessionStartedAt: null,
      sessionReadyAt: null,
      lastDisconnectedAt: null,
      lastQrGeneratedAt: null,
      totalInvoicesSent: 0,
      totalLedgersSent: 0,
      totalSendFailures: 0,
      lastInvoiceSentAt: null,
      lastLedgerSentAt: null,
      lastError: null,
    };
  }
  return state[userId];
}

function updateMetric(userId, patch) {
  const row = getMetric(userId);
  Object.assign(row, patch || {});
  saveState();
  return row;
}

function getMissingFields(fields = {}) {
  return Object.entries(fields).filter(([, value]) => !String(value || '').trim()).map(([key]) => key);
}

function normalizeIndianPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length >= 12) return digits;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function getClientOrThrow(userId) {
  const client = clients.get(userId);
  if (!client) throw new Error(`No active client for userId=${userId}`);
  return client;
}

async function downloadMediaFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Media download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = String(res.headers.get('content-type') || '').split(';')[0] || 'application/octet-stream';
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(contentType)) {
    throw new Error(`Unsupported content-type: ${contentType}`);
  }
  const ext = mime.extension(contentType) || (contentType.includes('pdf') ? 'pdf' : 'bin');
  const filename = `attachment.${ext}`;
  return new MessageMedia(contentType, buf.toString('base64'), filename);
}

async function sendDocumentToWhatsApp({ userId, customerPhone, customerName, documentNo, pdfUrl, type, mediaOverride }) {
  const client = getClientOrThrow(userId);
  const normalized = normalizeIndianPhone(customerPhone);
  if (!normalized) throw new Error('Invalid phone');
  if (!mediaOverride && !pdfUrl) throw new Error('pdfUrl or file required');
  const caption = type === 'ledger'
    ? `Ledger / Account Statement ${documentNo || ''} for ${customerName || 'Customer'}`.trim()
    : `Invoice ${documentNo || ''} for ${customerName || 'Customer'}`.trim();
  const media = mediaOverride || await downloadMediaFromUrl(pdfUrl);
  const msg = await client.sendMessage(`${normalized}@c.us`, media, { caption });
  return { messageId: msg?.id?._serialized || null, sentAt: new Date().toISOString() };
}

async function buildMediaFromRequest(req) {
  if (req.file?.buffer) {
    return new MessageMedia(
      req.file.mimetype || 'application/pdf',
      Buffer.from(req.file.buffer).toString('base64'),
      req.file.originalname || 'document.pdf',
    );
  }
  const pdfUrl = String(req.body?.pdfUrl || '').trim();
  return pdfUrl ? await downloadMediaFromUrl(pdfUrl) : null;
}

async function safeDestroySession(userId, opts = { explicitLogout: false }) {
  const client = clients.get(userId);
  if (!client) return;
  try {
    if (opts.explicitLogout) {
      try { await client.logout(); } catch (e) { updateMetric(userId, { lastError: e?.message || String(e) }); }
    }
    await client.destroy();
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes('EBUSY')) {
      updateMetric(userId, { lastError: 'Session logout hit locked auth file. Close Chrome/Node process and retry if needed.' });
    } else {
      updateMetric(userId, { lastError: msg });
    }
  } finally {
    clients.delete(userId);
    qrCodes.delete(userId);
    sessionStatus.set(userId, opts.explicitLogout ? 'logged_out' : 'disconnected');
    updateMetric(userId, { connected: false, lastDisconnectedAt: new Date().toISOString() });
  }
}

async function createWhatsAppSession(userId) {
  if (clients.has(userId) || initializingUsers.has(userId)) {
    return { success: true, userId, status: sessionStatus.get(userId) || 'initializing', alreadyRunning: true };
  }
  initializingUsers.add(userId);
  explicitLogoutUsers.delete(userId);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });
  clients.set(userId, client);
  sessionStatus.set(userId, 'initializing');
  updateMetric(userId, { sessionStartedAt: new Date().toISOString(), connected: false, lastError: null });

  client.on('qr', (qr) => {
    qrCodes.set(userId, qr);
    sessionStatus.set(userId, 'qr_ready');
    updateMetric(userId, { lastQrGeneratedAt: new Date().toISOString(), lastError: null, connected: false });
  });

  client.on('authenticated', () => console.log(`[WA:${userId}] AUTHENTICATED`));

  client.on('ready', () => {
    console.log(`[WA:${userId}] READY`);
    initializingUsers.delete(userId);
    sessionStatus.set(userId, 'connected');
    const connectedNumber = client.info?.wid?.user ? String(client.info.wid.user) : null;
    updateMetric(userId, { sessionReadyAt: new Date().toISOString(), connected: true, connectedNumber, lastError: null });
  });

  client.on('auth_failure', (msg) => {
    initializingUsers.delete(userId);
    sessionStatus.set(userId, 'auth_failure');
    updateMetric(userId, { lastError: String(msg || 'auth_failure'), connected: false });
  });

  client.on('disconnected', async (reason) => {
    const reasonText = String(reason || 'disconnected');
    console.log(`[WA:${userId}] DISCONNECTED: ${reasonText}`);
    sessionStatus.set(userId, 'disconnected');
    updateMetric(userId, { connected: false, lastDisconnectedAt: new Date().toISOString(), lastError: reasonText });
    await safeDestroySession(userId, { explicitLogout: false });
    if (reasonText !== 'LOGOUT' && !explicitLogoutUsers.has(userId)) {
      setTimeout(() => {
        if (!clients.has(userId) && !initializingUsers.has(userId)) {
          void createWhatsAppSession(userId);
        }
      }, 5000);
    }
  });

  client.initialize().catch((e) => {
    initializingUsers.delete(userId);
    sessionStatus.set(userId, 'error');
    updateMetric(userId, { lastError: e?.message || String(e), connected: false });
  });
  return { success: true, userId, status: 'initializing' };
}

app.get('/', (_req, res) => res.json({ success: true, service: 'whatsapp-server' }));
app.get('/healthz', (_req, res) => res.json({ success: true, uptime: process.uptime(), memory: process.memoryUsage() }));
app.get('/routes', (_req, res) => {
  res.json({
    success: true,
    routes: [
      'GET /healthz',
      'POST /create-session',
      'GET /qr/:userId',
      'GET /status/:userId',
      'GET /metrics/:userId',
      'POST /send-invoice',
      'POST /send-ledger',
      'POST /restart-session/:userId',
      'POST /logout/:userId',
    ],
  });
});

app.post('/create-session', requireApiKey, async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
  if (clients.has(userId) || initializingUsers.has(userId)) {
    const status = sessionStatus.get(userId) || 'initializing';
    return res.json({ success: true, userId, status, alreadyRunning: true, reconnectPath: status === 'disconnected' ? `/restart-session/${userId}` : null });
  }
  const result = await createWhatsAppSession(userId);
  return res.json(result);
});

app.get('/qr/:userId', requireApiKey, (req, res) => {
  const userId = String(req.params.userId || '');
  const qr = qrCodes.get(userId) || null;
  return res.json({ success: true, userId, qr, hasQr: Boolean(qr), status: sessionStatus.get(userId) || 'not_started' });
});

app.get('/status/:userId', requireApiKey, (req, res) => {
  const userId = String(req.params.userId || '');
  const m = getMetric(userId);
  const status = sessionStatus.get(userId) || 'not_started';
  res.json({ success: true, userId, connected: status === 'connected', status, connectedNumber: m.connectedNumber || null, initializing: initializingUsers.has(userId), hasQr: Boolean(qrCodes.get(userId)) });
});

app.get('/metrics/:userId', requireApiKey, (req, res) => {
  const userId = String(req.params.userId || '');
  const m = getMetric(userId);
  const status = sessionStatus.get(userId) || 'not_started';
  res.json({
    success: true,
    userId,
    connected: status === 'connected',
    connectedNumber: m.connectedNumber,
    initializing: initializingUsers.has(userId),
    hasQr: Boolean(qrCodes.get(userId)),
    sessionStartedAt: m.sessionStartedAt,
    sessionReadyAt: m.sessionReadyAt,
    lastDisconnectedAt: m.lastDisconnectedAt,
    lastQrGeneratedAt: m.lastQrGeneratedAt,
    totalInvoicesSent: m.totalInvoicesSent,
    totalLedgersSent: m.totalLedgersSent,
    totalSendFailures: m.totalSendFailures,
    lastInvoiceSentAt: m.lastInvoiceSentAt,
    lastLedgerSentAt: m.lastLedgerSentAt,
    lastError: m.lastError,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

app.post('/send-invoice', requireApiKey, upload.single('pdf'), async (req, res) => {
  try {
    const { userId, customerPhone, customerName, invoiceNo, pdfUrl } = req.body || {};
    console.log(JSON.stringify({
      stage: 'whatsapp_request_received',
      route: '/send-invoice',
      bodyKeys: Object.keys(req.body || {}),
      file: req.file ? {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
      } : null,
      bodyPreview: {
        userId: req.body?.userId || null,
        customerPhone: req.body?.customerPhone || null,
        customerName: req.body?.customerName || null,
        invoiceNo: req.body?.invoiceNo || null,
        ledgerNo: req.body?.ledgerNo || null,
      },
    }, null, 2));
    const missingFields = getMissingFields({ userId, customerPhone, customerName });
    if (missingFields.length > 0) return res.status(400).json({ success: false, error: 'Missing required fields', missingFields });
    const media = await buildMediaFromRequest(req);
    if (!media && !String(pdfUrl || '').trim()) return res.status(400).json({ success: false, error: 'Missing required fields', missingFields: ['pdf'] });
    const sent = await sendDocumentToWhatsApp({ userId, customerPhone, customerName, documentNo: invoiceNo, pdfUrl, type: 'invoice', mediaOverride: media || undefined });
    const m = getMetric(String(userId));
    updateMetric(String(userId), { totalInvoicesSent: Number(m.totalInvoicesSent || 0) + 1, lastInvoiceSentAt: sent.sentAt, lastError: null });
    return res.json({ success: true, messageId: sent.messageId, sentAt: sent.sentAt });
  } catch (e) {
    const userId = String(req.body?.userId || '');
    if (userId) {
      const m = getMetric(userId);
      updateMetric(userId, { totalSendFailures: Number(m.totalSendFailures || 0) + 1, lastError: e?.message || String(e) });
    }
    return res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

app.post('/send-ledger', requireApiKey, upload.single('pdf'), async (req, res) => {
  try {
    const { userId, customerPhone, customerName, ledgerNo, pdfUrl } = req.body || {};
    console.log(JSON.stringify({
      stage: 'whatsapp_request_received',
      route: '/send-ledger',
      bodyKeys: Object.keys(req.body || {}),
      file: req.file ? {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
      } : null,
      bodyPreview: {
        userId: req.body?.userId || null,
        customerPhone: req.body?.customerPhone || null,
        customerName: req.body?.customerName || null,
        invoiceNo: req.body?.invoiceNo || null,
        ledgerNo: req.body?.ledgerNo || null,
      },
    }, null, 2));
    const missingFields = getMissingFields({ userId, customerPhone, customerName, ledgerNo });
    if (missingFields.length > 0) return res.status(400).json({ success: false, error: 'Missing required fields', missingFields });
    const media = await buildMediaFromRequest(req);
    if (!media && !String(pdfUrl || '').trim()) return res.status(400).json({ success: false, error: 'Missing required fields', missingFields: ['pdf'] });
    const sent = await sendDocumentToWhatsApp({ userId, customerPhone, customerName, documentNo: ledgerNo, pdfUrl, type: 'ledger', mediaOverride: media || undefined });
    const m = getMetric(String(userId));
    updateMetric(String(userId), { totalLedgersSent: Number(m.totalLedgersSent || 0) + 1, lastLedgerSentAt: sent.sentAt, lastError: null });
    return res.json({ success: true, messageId: sent.messageId, sentAt: sent.sentAt });
  } catch (e) {
    const userId = String(req.body?.userId || '');
    if (userId) {
      const m = getMetric(userId);
      updateMetric(userId, { totalSendFailures: Number(m.totalSendFailures || 0) + 1, lastError: e?.message || String(e) });
    }
    return res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

app.post('/restart-session/:userId', requireApiKey, async (req, res) => {
  const userId = String(req.params.userId || '');
  await safeDestroySession(userId, { explicitLogout: false });
  sessionStatus.set(userId, 'disconnected');
  await new Promise((r) => setTimeout(r, 1000));
  const created = await createWhatsAppSession(userId);
  return res.json({ success: true, userId, status: 'restarted', created });
});

app.post('/logout/:userId', requireApiKey, async (req, res) => {
  const userId = String(req.params.userId || '');
  explicitLogoutUsers.add(userId);
  await safeDestroySession(userId, { explicitLogout: true });
  await new Promise((r) => setTimeout(r, 1000));
  return res.json({ success: true, userId, status: 'logged_out' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  const latestUserId = Array.from(sessionStatus.keys()).at(-1);
  if (latestUserId) {
    updateMetric(latestUserId, { lastError: reason?.message || String(reason) });
  }
});

app.listen(PORT, async () => {
  console.log(`WhatsApp server listening on :${PORT}`);
  console.log('Registered send routes: /send-invoice, /send-ledger');
  const authRoot = path.join(process.cwd(), '.wwebjs_auth');
  try {
    if (!fs.existsSync(authRoot)) return;
    const sessions = fs.readdirSync(authRoot).filter((name) => name.startsWith('session-')).map((name) => name.replace(/^session-/, ''));
    for (const userId of sessions) {
      try { await createWhatsAppSession(userId); } catch (e) { console.error('[restore-failed]', userId, e?.message || e); }
    }
  } catch (e) {
    console.error('[restore-scan-failed]', e?.message || e);
  }
});
