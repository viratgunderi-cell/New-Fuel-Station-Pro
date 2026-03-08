'use strict';
const express = require('express');
let triggerDayCloseSummary; try { triggerDayCloseSummary = require('./notifications').triggerDayCloseSummary; } catch(e) {}
let triggerMeterMismatch;   try { triggerMeterMismatch   = require('./notifications').triggerMeterMismatch;   } catch(e) {}
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

// ── GET /api/shifts/nozzles — nozzles with last meter reading for this station ──
router.get('/nozzles', async (req, res) => {
  const data = await db.all(
    `SELECT n.id, n.nozzle_name, n.last_reading, t.fuel_type, t.tank_name
     FROM nozzles n JOIN tanks t ON t.id=n.tank_id
     WHERE n.station_id=? AND n.is_active=1
     ORDER BY t.fuel_type, n.nozzle_name`,
    [req.user.stationId]
  );
  res.json({ success: true, data });
});

router.post('/open', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const open = await db.get(`SELECT id FROM shifts WHERE station_id=? AND status='open'`, [sid]);
  if (open) return res.status(409).json({ success: false, error: 'A shift is already open.' });

  const tanks = await db.all('SELECT id,tank_name,fuel_type,current_stock FROM tanks WHERE station_id=? AND is_active=1', [sid]);
  const tankReadings = {};
  tanks.forEach(t => { tankReadings[t.id] = t.current_stock; });

  // Sprint 6: capture per-nozzle meter opening readings
  const { shiftName = 'Day Shift', meterReadings = {} } = req.body;

  // Build opening_readings: merge tank stock + nozzle meter readings
  const openingReadings = { tanks: tankReadings, nozzles: meterReadings };

  const r = await db.run(`INSERT INTO shifts (station_id,shift_name,opened_by,opening_readings) VALUES (?,?,?,?)`,
    [sid, shiftName, req.user.id, JSON.stringify(openingReadings)]);

  // Persist last_reading on each nozzle that was provided
  for (const [nozzleId, reading] of Object.entries(meterReadings)) {
    if (reading != null && !isNaN(reading)) {
      await db.run(`UPDATE nozzles SET last_reading=? WHERE id=? AND station_id=?`,
        [parseFloat(reading), parseInt(nozzleId), sid]);
    }
  }

  await db.logAudit(sid, req.user.id, req.user.username, 'SHIFT_OPEN', 'shifts', r.lastInsertRowid, null, { shiftName, meterReadings }, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, shiftId: r.lastInsertRowid, message: 'Shift opened.' });
});

router.put('/:id/close', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const shift = await db.get(`SELECT * FROM shifts WHERE id=? AND station_id=? AND status='open'`, [req.params.id, sid]);
  if (!shift) return res.status(404).json({ success: false, error: 'Open shift not found.' });

  const { cashPhysical = 0, notes = '', meterReadings = {} } = req.body;
  const variance = cashPhysical - (shift.cash_collected || 0);

  // Sprint 6: build closing_readings with nozzle meter readings
  const closingReadings = { nozzles: meterReadings };

  await db.run(
    `UPDATE shifts SET status='closed',closed_by=?,close_time=datetime('now'),cash_physical=?,cash_variance=?,notes=?,closing_readings=? WHERE id=?`,
    [req.user.id, cashPhysical, variance, notes, JSON.stringify(closingReadings), shift.id]
  );

  // Persist last_reading on each nozzle that was provided at close
  for (const [nozzleId, reading] of Object.entries(meterReadings)) {
    if (reading != null && !isNaN(reading)) {
      await db.run(`UPDATE nozzles SET last_reading=? WHERE id=? AND station_id=?`,
        [parseFloat(reading), parseInt(nozzleId), sid]);
    }
  }

  // Sprint 4: Trigger WhatsApp day-close summary
  const closeDate = new Date().toISOString().slice(0,10);
  if (triggerDayCloseSummary) triggerDayCloseSummary(sid, closeDate).catch(() => {});

  // Sprint 6: Trigger meter mismatch alert if readings were supplied
  let mismatchAlerts = [];
  if (Object.keys(meterReadings).length > 0) {
    let openingNozzles = {};
    try { openingNozzles = (JSON.parse(shift.opening_readings || '{}')).nozzles || {}; } catch {}

    // Per nozzle: meter delta vs actual sales qty through that nozzle
    const nozzles = await db.all(
      `SELECT n.id,n.nozzle_name,t.fuel_type,
        COALESCE((SELECT SUM(quantity) FROM sales WHERE nozzle_id=n.id AND shift_id=? AND is_cancelled=0),0) as sales_qty
       FROM nozzles n JOIN tanks t ON t.id=n.tank_id
       WHERE n.station_id=? AND n.is_active=1`,
      [shift.id, sid]
    );

    for (const n of nozzles) {
      const opening = parseFloat(openingNozzles[n.id] || 0);
      const closing = parseFloat(meterReadings[n.id]);
      if (!closing || opening === 0) continue;
      const meterSold = closing - opening;
      if (meterSold < 0) continue; // counter reset / not entered at open
      const diff = Math.abs(meterSold - n.sales_qty);
      const pct  = meterSold > 0 ? (diff / meterSold) * 100 : 0;
      if (pct >= 2 || diff >= 5) { // flag if ≥2% or ≥5L absolute
        mismatchAlerts.push({ nozzleName: n.nozzle_name, fuelType: n.fuel_type, meterSold: +meterSold.toFixed(2), systemSold: +n.sales_qty.toFixed(2), diff: +diff.toFixed(2), pct: +pct.toFixed(1) });
      }
    }

    if (mismatchAlerts.length > 0 && triggerMeterMismatch) {
      triggerMeterMismatch(sid, shift.shift_name, mismatchAlerts).catch(() => {});
    }
  }

  res.json({
    success: true,
    message: 'Shift closed.',
    variance,
    cashCollected: shift.cash_collected,
    mismatchAlerts,
    summary: {
      totalSales: shift.total_sales || 0,
      cashCollected: shift.cash_collected || 0,
      upiCollected: shift.upi_collected || 0,
      cardCollected: shift.card_collected || 0,
      creditSales: shift.credit_sales || 0,
      cashPhysical: cashPhysical,
      variance: variance,
      shiftName: shift.shift_name
    }
  });
});

module.exports = router;
