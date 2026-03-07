'use strict';
const express = require('express');
const db = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const data = await db.all(`SELECT sh.*,u1.full_name as opened_by_name,u2.full_name as closed_by_name FROM shifts sh LEFT JOIN users u1 ON u1.id=sh.opened_by LEFT JOIN users u2 ON u2.id=sh.closed_by WHERE sh.station_id=? ORDER BY sh.open_time DESC LIMIT 30`, [req.user.stationId]);
  res.json({ success: true, data });
});

router.get('/current', async (req, res) => {
  const data = await db.get(`SELECT sh.*,u.full_name as opened_by_name FROM shifts sh LEFT JOIN users u ON u.id=sh.opened_by WHERE sh.station_id=? AND sh.status='open' ORDER BY sh.open_time DESC LIMIT 1`, [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/open', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const open = await db.get(`SELECT id FROM shifts WHERE station_id=? AND status='open'`, [sid]);
  if (open) return res.status(409).json({ success: false, error: 'A shift is already open.' });
  const tanks = await db.all('SELECT id,tank_name,fuel_type,current_stock FROM tanks WHERE station_id=? AND is_active=1', [sid]);
  const readings = {};
  tanks.forEach(t => { readings[t.id] = t.current_stock; });
  const { shiftName = 'Day Shift' } = req.body;
  const r = await db.run(`INSERT INTO shifts (station_id,shift_name,opened_by,opening_readings) VALUES (?,?,?,?)`,
    [sid, shiftName, req.user.id, JSON.stringify(readings)]);
  await db.logAudit(sid, req.user.id, req.user.username, 'SHIFT_OPEN', 'shifts', r.lastInsertRowid, null, {shiftName}, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, shiftId: r.lastInsertRowid, message: 'Shift opened.' });
});

router.put('/:id/close', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const shift = await db.get(`SELECT * FROM shifts WHERE id=? AND station_id=? AND status='open'`, [req.params.id, sid]);
  if (!shift) return res.status(404).json({ success: false, error: 'Open shift not found.' });
  const { cashPhysical = 0, notes = '' } = req.body;
  const variance = cashPhysical - (shift.cash_collected || 0);
  await db.run(`UPDATE shifts SET status='closed',closed_by=?,close_time=datetime('now'),cash_physical=?,cash_variance=?,notes=?,closing_readings='{}' WHERE id=?`,
    [req.user.id, cashPhysical, variance, notes, shift.id]);
  res.json({ success: true, message: 'Shift closed.', variance, cashCollected: shift.cash_collected });
});

module.exports = router;
