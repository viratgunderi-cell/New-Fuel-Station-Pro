'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { authenticateSuperAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateSuperAdmin);

// ── All Stations ──────────────────────────────────────────────────────────
router.get('/stations', async (req, res) => {
  const stations = await db.all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM users WHERE station_id=s.id) as user_count,
      (SELECT COUNT(*) FROM sales WHERE station_id=s.id AND date(sale_time)=date('now')) as today_sales,
      (SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE station_id=s.id AND date(sale_time)=date('now')) as today_revenue
    FROM stations s ORDER BY s.created_at DESC`);
  res.json({ success: true, data: stations });
});

router.post('/stations', [
  body('stationCode').trim().notEmpty().isLength({min:4,max:10}).matches(/^[A-Z0-9]+$/i).escape(),
  body('stationName').trim().notEmpty().escape(),
  body('ownerUsername').trim().notEmpty().isLength({min:4,max:30}).escape(),
  body('ownerPassword').isLength({min:8}).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/),
  body('ownerFullName').trim().notEmpty().escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  const { stationCode, stationName, ownerUsername, ownerPassword, ownerFullName, mobile, gstin, plan } = req.body;
  const exists = await db.get('SELECT id FROM stations WHERE station_code=? COLLATE NOCASE', [stationCode.toUpperCase()]);
  if (exists) return res.status(409).json({ success: false, error: 'Station code already exists.' });
  let stationId;
  await db.transaction(async t => {
    const r = await t.run(`INSERT INTO stations (station_code,station_name,gstin,mobile,plan,trial_ends_at) VALUES (?,?,?,?,?,date('now','+30 days'))`,
      [stationCode.toUpperCase(), stationName, gstin||null, mobile||null, plan||'trial']);
    stationId = r.lastInsertRowid;
    await t.run('INSERT INTO users (station_id,username,password_hash,full_name,role) VALUES (?,?,?,?,?)',
      [stationId, ownerUsername, bcrypt.hashSync(ownerPassword,12), ownerFullName, 'owner']);
    const ms = await t.run('INSERT INTO tanks (station_id,tank_name,fuel_type,capacity,current_stock,min_alert) VALUES (?,?,?,?,?,?)',[stationId,'MS Tank 1','MS',20000,0,2000]);
    const hsd = await t.run('INSERT INTO tanks (station_id,tank_name,fuel_type,capacity,current_stock,min_alert) VALUES (?,?,?,?,?,?)',[stationId,'HSD Tank 1','HSD',20000,0,2000]);
    await t.run('INSERT INTO nozzles (station_id,tank_id,nozzle_name) VALUES (?,?,?)',[stationId,ms.lastInsertRowid,'MS-1']);
    await t.run('INSERT INTO nozzles (station_id,tank_id,nozzle_name) VALUES (?,?,?)',[stationId,hsd.lastInsertRowid,'HSD-1']);
  });
  res.status(201).json({ success: true, message: 'Station created.', stationId, stationCode: stationCode.toUpperCase() });
});

router.put('/stations/:id', async (req, res) => {
  const { stationName, msPrice, hsdPrice, cngPrice, plan, isActive, trialEndsAt } = req.body;
  await db.run(`UPDATE stations SET station_name=COALESCE(?,station_name), ms_price=COALESCE(?,ms_price), hsd_price=COALESCE(?,hsd_price), cng_price=COALESCE(?,cng_price), plan=COALESCE(?,plan), is_active=COALESCE(?,is_active), trial_ends_at=COALESCE(?,trial_ends_at), updated_at=datetime('now') WHERE id=?`,
    [stationName||null, msPrice||null, hsdPrice||null, cngPrice||null, plan||null, isActive!=null?isActive:null, trialEndsAt||null, req.params.id]);
  res.json({ success: true, message: 'Station updated.' });
});

router.delete('/stations/:id', async (req, res) => {
  await db.run('UPDATE stations SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ success: true, message: 'Station suspended.' });
});

// ── Platform Stats ────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const [totalStations, activeStations, totalUsers, todayRevenue, totalSales, planBreakdown] = await Promise.all([
    db.get('SELECT COUNT(*) as c FROM stations'),
    db.get('SELECT COUNT(*) as c FROM stations WHERE is_active=1'),
    db.get('SELECT COUNT(*) as c FROM users'),
    db.get(`SELECT COALESCE(SUM(total_amount),0) as c FROM sales WHERE date(sale_time)=date('now') AND is_cancelled=0`),
    db.get(`SELECT COUNT(*) as c FROM sales WHERE is_cancelled=0`),
    db.all(`SELECT plan, COUNT(*) as count FROM stations GROUP BY plan`)
  ]);
  res.json({ success: true, data: {
    totalStations: totalStations.c, activeStations: activeStations.c,
    totalUsers: totalUsers.c, todayRevenue: todayRevenue.c,
    totalSales: totalSales.c, planBreakdown
  }});
});

// ── Station Detail ────────────────────────────────────────────────────────
router.get('/stations/:id/users', async (req, res) => {
  const users = await db.all('SELECT id,username,full_name,role,mobile,is_active,last_login FROM users WHERE station_id=?', [req.params.id]);
  res.json({ success: true, data: users });
});

router.get('/stations/:id/activity', async (req, res) => {
  const logs = await db.all('SELECT * FROM audit_log WHERE station_id=? ORDER BY created_at DESC LIMIT 100', [req.params.id]);
  res.json({ success: true, data: logs });
});

module.exports = router;
