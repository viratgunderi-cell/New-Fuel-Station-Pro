'use strict';
const express = require('express');
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
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc:["'self'"], scriptSrc:["'self'","'unsafe-inline'"], styleSrc:["'self'","'unsafe-inline'"], imgSrc:["'self'","data:","blob:"], connectSrc:["'self'"] }}}));
app.use(compression());
app.use(cors({ origin: (o, cb) => (!o || ALLOWED_ORIGINS.some(a => o.startsWith(a.trim())) || ALLOWED_ORIGINS.includes('*')) ? cb(null,true) : cb(new Error('Not allowed')), credentials: true }));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(ipGuard);
app.use(apiLimiter);
app.use(speedLimiter);

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/sales',   require('./routes/sales'));
app.use('/api/shifts',  require('./routes/shifts'));
app.use('/api/super',   require('./routes/super'));
app.use('/api',         require('./routes/api'));

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
}).catch(err => { console.error('[Fatal] DB init failed:', err); process.exit(1); });

module.exports = app;
