'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { authenticate, authenticateSuperAdmin } = require('../middleware/auth');
const { authLimiter } = require('../middleware/security');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';

// ── Station Login ──────────────────────────────────────────────────────────
router.post('/login', authLimiter,
  [body('stationCode').trim().notEmpty().isLength({max:20}).escape(),
   body('username').trim().notEmpty().isLength({max:50}).escape(),
   body('password').notEmpty().isLength({max:128})],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { stationCode, username, password } = req.body;
    try {
      // Validate station
      const station = await db.get('SELECT * FROM stations WHERE station_code=? COLLATE NOCASE', [stationCode]);
      if (!station) { bcrypt.compareSync('dummy','$2a$12$invalidhashpadding000000000000000000000000000000000000'); return res.status(401).json({ success: false, error: 'Invalid station code, username or password.' }); }
      if (!station.is_active) return res.status(403).json({ success: false, error: 'Station account suspended.' });

      // Validate user
      const user = await db.get('SELECT * FROM users WHERE station_id=? AND username=? COLLATE NOCASE', [station.id, username]);
      if (!user) { bcrypt.compareSync('dummy','$2a$12$invalidhashpadding000000000000000000000000000000000000'); return res.status(401).json({ success: false, error: 'Invalid station code, username or password.' }); }
      if (user.locked_until && new Date(user.locked_until) > new Date()) return res.status(423).json({ success: false, error: 'Account locked. Try again later.' });
      if (!user.is_active) return res.status(403).json({ success: false, error: 'Account deactivated.' });

      const valid = bcrypt.compareSync(password, user.password_hash);
      if (!valid) {
        const newFailed = (user.failed_logins || 0) + 1;
        const lockUntil = newFailed >= 5 ? new Date(Date.now() + 15*60000).toISOString() : null;
        await db.run('UPDATE users SET failed_logins=?,locked_until=? WHERE id=?', [newFailed, lockUntil, user.id]);
        return res.status(401).json({ success: false, error: newFailed >= 5 ? 'Too many attempts. Account locked 15 min.' : 'Invalid station code, username or password.' });
      }

      await db.run(`UPDATE users SET failed_logins=0,locked_until=NULL,last_login=datetime('now') WHERE id=?`, [user.id]);
      const accessToken = jwt.sign({ userId: user.id, username: user.username, role: user.role, stationId: station.id, stationCode: station.station_code, isSuperAdmin: false }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, issuer: 'fuelbunk-pro' });
      const refreshToken = crypto.randomBytes(64).toString('hex');
      const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await db.run('DELETE FROM refresh_tokens WHERE user_id=? AND id NOT IN (SELECT id FROM refresh_tokens WHERE user_id=? ORDER BY created_at DESC LIMIT 4)', [user.id, user.id]);
      await db.run('INSERT INTO refresh_tokens (user_id,station_id,token_hash,expires_at,ip_address) VALUES (?,?,?,?,?)', [user.id, station.id, refreshHash, new Date(Date.now()+7*24*60*60000).toISOString(), req.ip]);
      await db.logAudit(station.id, user.id, user.username, 'LOGIN', 'auth', user.id, null, null, req.ip, req.get('user-agent'));
      return res.json({ success: true, accessToken, refreshToken, expiresIn: JWT_EXPIRES_IN,
        user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role },
        station: { id: station.id, code: station.station_code, name: station.station_name, msPrice: station.ms_price, hsdPrice: station.hsd_price, cngPrice: station.cng_price, xpPrice: station.xp_price, idleTimeout: station.idle_timeout, plan: station.plan }
      });
    } catch(e) { console.error('[auth/login]', e.message); return res.status(500).json({ success: false, error: 'Server error.' }); }
  }
);

// ── Super Admin Login ──────────────────────────────────────────────────────
router.post('/super/login', authLimiter,
  [body('username').trim().notEmpty().escape(), body('password').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { username, password } = req.body;
    try {
      const sa = await db.get('SELECT * FROM super_admins WHERE username=? COLLATE NOCASE', [username]);
      if (!sa || !bcrypt.compareSync(password, sa.password_hash)) return res.status(401).json({ success: false, error: 'Invalid credentials.' });
      if (!sa.is_active) return res.status(403).json({ success: false, error: 'Account deactivated.' });
      await db.run(`UPDATE super_admins SET last_login=datetime('now') WHERE id=?`, [sa.id]);
      const accessToken = jwt.sign({ userId: sa.id, username: sa.username, role: 'super_admin', isSuperAdmin: true }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, issuer: 'fuelbunk-pro' });
      const refreshToken = crypto.randomBytes(64).toString('hex');
      const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await db.run('INSERT INTO refresh_tokens (super_admin_id,token_hash,expires_at,ip_address) VALUES (?,?,?,?)', [sa.id, refreshHash, new Date(Date.now()+7*24*60*60000).toISOString(), req.ip]);
      return res.json({ success: true, accessToken, refreshToken, isSuperAdmin: true, user: { id: sa.id, username: sa.username, fullName: sa.full_name } });
    } catch(e) { return res.status(500).json({ success: false, error: 'Server error.' }); }
  }
);

// ── Station Registration ───────────────────────────────────────────────────
router.post('/register',
  [body('stationCode').trim().notEmpty().isLength({min:2,max:10}).matches(/^[A-Z0-9]+$/i).escape(),
   body('stationName').trim().notEmpty().isLength({max:100}).escape(),
   body('ownerUsername').trim().notEmpty().isLength({min:2,max:30}).escape(),
   body('ownerPassword').isLength({min:8,max:128}).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/),
   body('ownerFullName').trim().notEmpty().escape(),
   body('mobile').optional().isMobilePhone('en-IN')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { stationCode, stationName, ownerUsername, ownerPassword, ownerFullName, mobile, gstin, address } = req.body;
    try {
      const exists = await db.get('SELECT id FROM stations WHERE station_code=? COLLATE NOCASE', [stationCode.toUpperCase()]);
      if (exists) return res.status(409).json({ success: false, error: 'Station code already taken. Choose another.' });
      let stationId;
      await db.transaction(async t => {
        const r = await t.run(`INSERT INTO stations (station_code,station_name,gstin,address,mobile,plan,trial_ends_at) VALUES (?,?,?,?,?,'trial',date('now','+30 days'))`,
          [stationCode.toUpperCase(), stationName, gstin||null, address||null, mobile||null]);
        stationId = r.lastInsertRowid;
        const hash = bcrypt.hashSync(ownerPassword, 12);
        await t.run('INSERT INTO users (station_id,username,password_hash,full_name,role,mobile) VALUES (?,?,?,?,?,?)',
          [stationId, ownerUsername, hash, ownerFullName, 'owner', mobile||null]);
        // Seed default tanks
        const ms = await t.run('INSERT INTO tanks (station_id,tank_name,fuel_type,capacity,current_stock,min_alert) VALUES (?,?,?,?,?,?)',[stationId,'MS Tank 1','MS',20000,0,2000]);
        const hsd = await t.run('INSERT INTO tanks (station_id,tank_name,fuel_type,capacity,current_stock,min_alert) VALUES (?,?,?,?,?,?)',[stationId,'HSD Tank 1','HSD',20000,0,2000]);
        await t.run('INSERT INTO nozzles (station_id,tank_id,nozzle_name) VALUES (?,?,?)',[stationId,ms.lastInsertRowid,'MS Nozzle 1']);
        await t.run('INSERT INTO nozzles (station_id,tank_id,nozzle_name) VALUES (?,?,?)',[stationId,hsd.lastInsertRowid,'HSD Nozzle 1']);
        await t.run('INSERT INTO suppliers (station_id,name) VALUES (?,?)',[stationId,'Default Supplier']);
      });
      await db.logAudit(stationId, null, ownerUsername, 'STATION_REGISTER', 'stations', stationId, null, {stationCode}, req.ip, req.get('user-agent'));
      return res.status(201).json({ success: true, message: `Station ${stationCode.toUpperCase()} registered! 30-day free trial started.`, stationCode: stationCode.toUpperCase() });
    } catch(e) { console.error('[auth/register]', e.message); return res.status(500).json({ success: false, error: 'Server error.' }); }
  }
);

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ success: false, error: 'Refresh token required.' });
  const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const stored = await db.get(`SELECT rt.*,u.username,u.role,u.is_active,u.station_id,s.station_code,s.station_name,s.ms_price,s.hsd_price,s.cng_price,s.xp_price,sa.username as sa_username,sa.is_active as sa_active FROM refresh_tokens rt LEFT JOIN users u ON u.id=rt.user_id LEFT JOIN stations s ON s.id=rt.station_id LEFT JOIN super_admins sa ON sa.id=rt.super_admin_id WHERE rt.token_hash=? AND rt.expires_at>datetime('now')`, [hash]);
  if (!stored) return res.status(401).json({ success: false, error: 'Invalid refresh token.' });
  let accessToken;
  if (stored.super_admin_id) {
    if (!stored.sa_active) return res.status(401).json({ success: false, error: 'Account deactivated.' });
    accessToken = jwt.sign({ userId: stored.super_admin_id, username: stored.sa_username, role: 'super_admin', isSuperAdmin: true }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, issuer: 'fuelbunk-pro' });
  } else {
    if (!stored.is_active) return res.status(401).json({ success: false, error: 'Account deactivated.' });
    accessToken = jwt.sign({ userId: stored.user_id, username: stored.username, role: stored.role, stationId: stored.station_id, stationCode: stored.station_code, isSuperAdmin: false }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, issuer: 'fuelbunk-pro' });
  }
  return res.json({ success: true, accessToken });
});

router.post('/logout', authenticate, async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) { const h = crypto.createHash('sha256').update(refreshToken).digest('hex'); await db.run('DELETE FROM refresh_tokens WHERE token_hash=?', [h]); }
  await db.logAudit(req.user.stationId||null, req.user.id, req.user.username, 'LOGOUT', 'auth', req.user.id, null, null, req.ip, req.get('user-agent'));
  return res.json({ success: true, message: 'Logged out.' });
});

router.get('/me', authenticate, async (req, res) => {
  if (req.user.isSuperAdmin) {
    const sa = await db.get('SELECT id,username,full_name,last_login FROM super_admins WHERE id=?', [req.user.id]);
    return res.json({ success: true, user: sa, isSuperAdmin: true });
  }
  const user = await db.get('SELECT id,username,full_name,role,mobile,last_login FROM users WHERE id=? AND station_id=?', [req.user.id, req.user.stationId]);
  const s = await db.get('SELECT id,station_code,station_name,ms_price,hsd_price,cng_price,xp_price,idle_timeout,plan,is_active FROM stations WHERE id=?', [req.user.stationId]);
  const station = s ? { id:s.id, code:s.station_code, name:s.station_name, msPrice:s.ms_price, hsdPrice:s.hsd_price, cngPrice:s.cng_price, xpPrice:s.xp_price, idleTimeout:s.idle_timeout, plan:s.plan } : null;
  return res.json({ success: true, user, station });
});

router.post('/change-password', authenticate,
  [body('currentPassword').notEmpty(), body('newPassword').isLength({min:8}).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, error: 'Password must be 8+ chars with upper, lower, number and special char.' });
    const { currentPassword, newPassword } = req.body;
    const user = await db.get('SELECT password_hash FROM users WHERE id=? AND station_id=?', [req.user.id, req.user.stationId]);
    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(401).json({ success: false, error: 'Current password incorrect.' });
    await db.run(`UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?`, [bcrypt.hashSync(newPassword, 12), req.user.id]);
    await db.run('DELETE FROM refresh_tokens WHERE user_id=?', [req.user.id]);
    return res.json({ success: true, message: 'Password changed.' });
  }
);
router.put('/change-password', authenticate,
  [body('currentPassword').notEmpty(), body('newPassword').isLength({min:8}).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, error: 'Password must be 8+ chars with upper, lower, number and special char.' });
    const { currentPassword, newPassword } = req.body;
    const user = await db.get('SELECT password_hash FROM users WHERE id=? AND station_id=?', [req.user.id, req.user.stationId]);
    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(401).json({ success: false, error: 'Current password incorrect.' });
    await db.run(`UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?`, [bcrypt.hashSync(newPassword, 12), req.user.id]);
    await db.run('DELETE FROM refresh_tokens WHERE user_id=?', [req.user.id]);
    return res.json({ success: true, message: 'Password changed.' });
  }
);

module.exports = router;
