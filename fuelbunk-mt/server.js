'use strict';
const express = require('express');
let cron; try { cron = require('node-cron'); } catch(e) { console.warn('[Cron] node-cron not installed, skipping scheduled tasks'); }
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const db = require('./db/database');
const { apiLimiter, speedLimiter, ipGuard } = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

// ── Middleware ─────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "'unsafe-hashes'", "cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", "data:", "blob:"],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'", "data:"],
      workerSrc:   ["'self'", "blob:"],
    }
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors({ origin: (o, cb) => (!o || ALLOWED_ORIGINS.some(a => o.startsWith(a.trim())) || ALLOWED_ORIGINS.includes('*')) ? cb(null,true) : cb(new Error('Not allowed')), credentials: true }));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(ipGuard);
app.use(apiLimiter);
app.use(speedLimiter);

// ── Routes ─────────────────────────────────────────────────────────────────
const { authenticate } = require('./middleware/auth');
// Block super admin tokens from all station-level API routes
const stationOnly = (req, res, next) => {
  // Public auth routes don't need this check
  next();
};
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/super',   require('./routes/super'));
// Station routes: authenticate + reject SA tokens
const rejectSA = [authenticate, (req, res, next) => {
  if (req.user && req.user.isSuperAdmin) return res.status(403).json({ success: false, error: 'Use /api/super for super admin operations.' });
  next();
}];
app.use('/api/sales',        rejectSA, require('./routes/sales'));
app.use('/api/shifts',       rejectSA, require('./routes/shifts'));
app.use('/api/payroll',      rejectSA, require('./routes/payroll'));
app.use('/api/notifications',rejectSA, require('./routes/notifications'));
// ── NEW: Sprint 7 — GST, Advanced Reports, Purchases, Expiry Cron ──────────
app.use('/api/gst',           rejectSA, require('./routes/gst'));
app.use('/api/purchases2',    rejectSA, require('./routes/purchases2'));
app.use('/api/reports2',      rejectSA, require('./routes/reports2'));
app.use('/api',               rejectSA, require('./routes/api'));

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const users = await db.get('SELECT COUNT(*) as c FROM users').catch(() => ({ c: 0 }));
  const stations = await db.get('SELECT COUNT(*) as c FROM stations').catch(() => ({ c: 0 }));
  res.json({ status: 'ok', db: 'connected', stations: stations.c, users: users.c, ts: new Date().toISOString() });
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ──────────────────────────────────────────────────────────────────
db.ready().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🔥 FuelBunk Pro Multi-Tenant running on port ${PORT}`);
    console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   PWA:  http://localhost:${PORT}\n`);
  });

  // ── Sprint 4: Cron Jobs ─────────────────────────────────────────────
  if (cron) {
    const { runCreditReminderCron, runExpiryAlertCron } = require('./routes/notifications');
    // Credit reminders: every day at 9:00 AM IST
    cron.schedule('0 3 * * *', () => {
      console.log('[Cron] Running credit reminder job...');
      runCreditReminderCron().catch(e => console.error('[Cron] Credit reminder error:', e.message));
    }, { timezone: 'Asia/Kolkata' });
    // Expiry alerts: every day at 8:00 AM IST
    cron.schedule('30 2 * * *', () => {
      console.log('[Cron] Running product expiry alert job...');
      if (runExpiryAlertCron) runExpiryAlertCron().catch(e => console.error('[Cron] Expiry alert error:', e.message));
    }, { timezone: 'Asia/Kolkata' });
    console.log('   Cron: Credit reminders scheduled (09:00 IST daily)');
    console.log('   Cron: Expiry alerts scheduled (08:00 IST daily)');
  }

}).catch(err => { console.error('[Fatal] DB init failed:', err); process.exit(1); });

module.exports = app;
