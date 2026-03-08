'use strict';
const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { sendWhatsApp, templates, PROVIDER } = require('../utils/whatsapp');

const router = express.Router();
router.use(authenticate);

// ── Helper: get or create notification settings ───────────────────────────
async function getOrCreateSettings(stationId) {
  let s = await db.get('SELECT * FROM notification_settings WHERE station_id=?', [stationId]);
  if (!s) {
    await db.run('INSERT OR IGNORE INTO notification_settings (station_id) VALUES (?)', [stationId]);
    s = await db.get('SELECT * FROM notification_settings WHERE station_id=?', [stationId]);
  }
  return s;
}

// ── Helper: log notification ──────────────────────────────────────────────
async function logNotification(stationId, type, recipient, message, status, provider, errorMsg, meta) {
  await db.run(
    `INSERT INTO notification_log (station_id,type,recipient,message,status,provider,error_msg,meta) VALUES (?,?,?,?,?,?,?,?)`,
    [stationId, type, recipient||null, message, status, provider||PROVIDER, errorMsg||null, meta?JSON.stringify(meta):null]
  ).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/notifications/settings
// ═══════════════════════════════════════════════════════════════════════════
router.get('/settings', async (req, res) => {
  try {
    const s = await getOrCreateSettings(req.user.stationId);
    // Don't expose full API keys — just whether they're set
    res.json({ success: true, data: { ...s, provider: PROVIDER } });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUT /api/notifications/settings
// ═══════════════════════════════════════════════════════════════════════════
router.put('/settings', authorize('owner'), [
  body('waNumber').optional().trim(),
  body('waEnabled').optional().isBoolean(),
  body('lowStockEnabled').optional().isBoolean(),
  body('lowStockThreshold').optional().isFloat({ min: 100, max: 100000 }),
  body('dayCloseEnabled').optional().isBoolean(),
  body('dayCloseTime').optional().matches(/^\d{2}:\d{2}$/),
  body('creditReminderEnabled').optional().isBoolean(),
  body('creditReminderDays').optional().isInt({ min: 1, max: 365 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const sid = req.user.stationId;
  const {
    waNumber, waEnabled, lowStockEnabled, lowStockThreshold,
    dayCloseEnabled, dayCloseTime, creditReminderEnabled, creditReminderDays
  } = req.body;

  await getOrCreateSettings(sid);
  await db.run(`
    UPDATE notification_settings SET
      wa_number        = COALESCE(?, wa_number),
      wa_enabled       = COALESCE(?, wa_enabled),
      low_stock_enabled   = COALESCE(?, low_stock_enabled),
      low_stock_threshold = COALESCE(?, low_stock_threshold),
      day_close_enabled   = COALESCE(?, day_close_enabled),
      day_close_time      = COALESCE(?, day_close_time),
      credit_reminder_enabled = COALESCE(?, credit_reminder_enabled),
      credit_reminder_days    = COALESCE(?, credit_reminder_days),
      updated_at = datetime('now')
    WHERE station_id=?`,
    [
      waNumber||null,
      waEnabled!=null ? (waEnabled?1:0) : null,
      lowStockEnabled!=null ? (lowStockEnabled?1:0) : null,
      lowStockThreshold||null,
      dayCloseEnabled!=null ? (dayCloseEnabled?1:0) : null,
      dayCloseTime||null,
      creditReminderEnabled!=null ? (creditReminderEnabled?1:0) : null,
      creditReminderDays||null,
      sid
    ]
  );
  res.json({ success: true, message: 'Notification settings saved.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/notifications/test  — send a test WA message
// ═══════════════════════════════════════════════════════════════════════════
router.post('/test', authorize('owner'), async (req, res) => {
  const sid = req.user.stationId;
  const settings = await getOrCreateSettings(sid);

  if (!settings.wa_number) {
    return res.status(400).json({ success: false, error: 'WhatsApp number not configured. Please save settings first.' });
  }

  const station = await db.get('SELECT station_name FROM stations WHERE id=?', [sid]);
  const msg = templates.testMessage(station.station_name);

  try {
    const result = await sendWhatsApp(settings.wa_number, msg);
    await logNotification(sid, 'test', settings.wa_number, msg, 'sent', result.provider, null, result);
    res.json({ success: true, message: 'Test message sent!', provider: result.provider, detail: result });
  } catch(e) {
    await logNotification(sid, 'test', settings.wa_number, msg, 'failed', PROVIDER, e.message, null);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/notifications/send-day-report  — manual day-close summary
// ═══════════════════════════════════════════════════════════════════════════
router.post('/send-day-report', authorize('owner', 'manager'), async (req, res) => {
  const sid = req.user.stationId;
  const date = req.body.date || new Date().toISOString().slice(0, 10);

  const settings = await getOrCreateSettings(sid);
  if (!settings.wa_number) return res.status(400).json({ success: false, error: 'WhatsApp number not configured.' });

  const [station, totals] = await Promise.all([
    db.get('SELECT station_name FROM stations WHERE id=?', [sid]),
    db.get(`SELECT
      COUNT(*) as txns,
      ROUND(COALESCE(SUM(total_amount),0),2) as revenue,
      ROUND(COALESCE(SUM(quantity),0),2) as litres,
      ROUND(COALESCE(SUM(CASE WHEN payment_mode='cash' THEN total_amount ELSE 0 END),0),2) as cash,
      ROUND(COALESCE(SUM(CASE WHEN payment_mode IN ('upi','phonepe','gpay','paytm') THEN total_amount ELSE 0 END),0),2) as upi,
      ROUND(COALESCE(SUM(CASE WHEN payment_mode='card' THEN total_amount ELSE 0 END),0),2) as card,
      ROUND(COALESCE(SUM(CASE WHEN payment_mode='credit' THEN total_amount ELSE 0 END),0),2) as credit
      FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid, date])
  ]);

  const msg = templates.dayClose(station.station_name, date, totals);
  try {
    const result = await sendWhatsApp(settings.wa_number, msg);
    await logNotification(sid, 'day_close', settings.wa_number, msg, 'sent', result.provider, null, { date, ...result });
    res.json({ success: true, message: 'Day report sent!', provider: result.provider });
  } catch(e) {
    await logNotification(sid, 'day_close', settings.wa_number, msg, 'failed', PROVIDER, e.message, { date });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/notifications/send-credit-reminders  — manual credit reminders
// ═══════════════════════════════════════════════════════════════════════════
router.post('/send-credit-reminders', authorize('owner', 'manager'), async (req, res) => {
  const sid = req.user.stationId;
  const settings = await getOrCreateSettings(sid);
  if (!settings.wa_number) return res.status(400).json({ success: false, error: 'Station WhatsApp number not configured.' });

  const overdueDays = req.body.overdueDays != null ? req.body.overdueDays : (settings.credit_reminder_days || 30);
  const station = await db.get('SELECT station_name, mobile FROM stations WHERE id=?', [sid]);

  const overdueCustomers = await db.all(`
    SELECT c.company_name, c.mobile, c.outstanding,
      (SELECT MAX(payment_date) FROM credit_payments WHERE customer_id=c.id AND station_id=c.station_id) as last_payment
    FROM credit_customers c
    WHERE c.station_id=? AND c.outstanding > 0 AND c.is_active=1
      AND (
        c.mobile IS NOT NULL AND c.mobile != ''
      )
    ORDER BY c.outstanding DESC`, [sid]);

  const today = new Date();
  const results = [];

  for (const cust of overdueCustomers) {
    let days = 999;
    if (cust.last_payment) {
      days = Math.floor((today - new Date(cust.last_payment)) / 86400000);
    }
    if (days < overdueDays) continue;

    const msg = templates.creditReminder(station.station_name, cust.company_name, cust.outstanding, days, station.mobile);
    try {
      const result = await sendWhatsApp(cust.mobile, msg);
      await logNotification(sid, 'credit_reminder', cust.mobile, msg, 'sent', result.provider, null, { company: cust.company_name });
      results.push({ company: cust.company_name, mobile: cust.mobile, status: 'sent' });
    } catch(e) {
      await logNotification(sid, 'credit_reminder', cust.mobile, msg, 'failed', PROVIDER, e.message, { company: cust.company_name });
      results.push({ company: cust.company_name, mobile: cust.mobile, status: 'failed', error: e.message });
    }
  }

  res.json({ success: true, sent: results.filter(r => r.status === 'sent').length, failed: results.filter(r => r.status === 'failed').length, results });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/notifications/log  — notification history
// ═══════════════════════════════════════════════════════════════════════════
router.get('/log', authorize('owner', 'manager'), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const type = req.query.type;
  let sql = `SELECT * FROM notification_log WHERE station_id=?`;
  const params = [req.user.stationId];
  if (type) { sql += ' AND type=?'; params.push(type); }
  sql += ' ORDER BY sent_at DESC LIMIT ?';
  params.push(limit);
  const data = await db.all(sql, params);
  res.json({ success: true, data });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/notifications/stats  — counts for dashboard badge
// ═══════════════════════════════════════════════════════════════════════════
router.get('/stats', async (req, res) => {
  const sid = req.user.stationId;
  const [sent, failed, settings] = await Promise.all([
    db.get(`SELECT COUNT(*) as c FROM notification_log WHERE station_id=? AND status='sent' AND date(sent_at)=date('now')`, [sid]),
    db.get(`SELECT COUNT(*) as c FROM notification_log WHERE station_id=? AND status='failed' AND date(sent_at)=date('now')`, [sid]),
    getOrCreateSettings(sid)
  ]);
  res.json({ success: true, data: { sentToday: sent.c, failedToday: failed.c, waEnabled: !!settings.wa_enabled, waConfigured: !!settings.wa_number } });
});

module.exports = router;

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL: Trigger functions (called by other routes, not HTTP endpoints)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Called by shifts.js after closing a shift — sends day-close summary if enabled
 */
async function triggerDayCloseSummary(stationId, date) {
  try {
    const settings = await db.get('SELECT * FROM notification_settings WHERE station_id=?', [stationId]);
    if (!settings || !settings.wa_enabled || !settings.day_close_enabled || !settings.wa_number) return;

    // Check if there are still open shifts today — only send after ALL shifts closed
    const openShift = await db.get(`SELECT id FROM shifts WHERE station_id=? AND status='open'`, [stationId]);
    if (openShift) return; // still shifts open

    const [station, totals] = await Promise.all([
      db.get('SELECT station_name FROM stations WHERE id=?', [stationId]),
      db.get(`SELECT
        COUNT(*) as txns,
        ROUND(COALESCE(SUM(total_amount),0),2) as revenue,
        ROUND(COALESCE(SUM(quantity),0),2) as litres,
        ROUND(COALESCE(SUM(CASE WHEN payment_mode='cash' THEN total_amount ELSE 0 END),0),2) as cash,
        ROUND(COALESCE(SUM(CASE WHEN payment_mode IN ('upi','phonepe','gpay','paytm') THEN total_amount ELSE 0 END),0),2) as upi,
        ROUND(COALESCE(SUM(CASE WHEN payment_mode='card' THEN total_amount ELSE 0 END),0),2) as card,
        ROUND(COALESCE(SUM(CASE WHEN payment_mode='credit' THEN total_amount ELSE 0 END),0),2) as credit
        FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0`, [stationId, date])
    ]);

    const msg = templates.dayClose(station.station_name, date, totals);
    const result = await sendWhatsApp(settings.wa_number, msg);
    await logNotification(stationId, 'day_close', settings.wa_number, msg, 'sent', result.provider, null, { date, auto: true });
  } catch(e) {
    console.error('[WA] Day close trigger failed:', e.message);
  }
}

/**
 * Called by sales/purchases after stock changes — checks low stock threshold
 */
async function triggerLowStockCheck(stationId) {
  try {
    const settings = await db.get('SELECT * FROM notification_settings WHERE station_id=?', [stationId]);
    if (!settings || !settings.wa_enabled || !settings.low_stock_enabled || !settings.wa_number) return;

    const tanks = await db.all('SELECT * FROM tanks WHERE station_id=? AND is_active=1', [stationId]);
    const station = await db.get('SELECT station_name FROM stations WHERE id=?', [stationId]);

    const lowTanks = tanks.filter(t => {
      const threshold = settings.low_stock_threshold || t.min_alert || 2000;
      return t.current_stock <= threshold;
    });

    if (!lowTanks.length) return;

    // Check if we already sent a low stock alert for these tanks in the last 4 hours
    const recentAlert = await db.get(
      `SELECT id FROM notification_log WHERE station_id=? AND type='low_stock' AND status='sent' AND sent_at >= datetime('now','-4 hours')`,
      [stationId]
    );
    if (recentAlert) return; // throttle: max 1 alert per 4 hours

    let msg;
    if (lowTanks.length === 1) {
      const t = lowTanks[0];
      const threshold = settings.low_stock_threshold || t.min_alert || 2000;
      msg = templates.lowStock(station.station_name, t.tank_name, t.fuel_type, t.current_stock, threshold);
    } else {
      msg = templates.lowStockMultiple(station.station_name, lowTanks.map(t => ({
        tankName: t.tank_name, fuelType: t.fuel_type, stock: t.current_stock
      })));
    }

    const result = await sendWhatsApp(settings.wa_number, msg);
    await logNotification(stationId, 'low_stock', settings.wa_number, msg, 'sent', result.provider, null, { tanks: lowTanks.map(t=>t.tank_name) });
  } catch(e) {
    console.error('[WA] Low stock check failed:', e.message);
  }
}

/**
 * Cron job: send credit reminders to all stations that have it enabled
 */
async function runCreditReminderCron() {
  try {
    const stations = await db.all(`
      SELECT ns.*, s.station_name, s.mobile
      FROM notification_settings ns
      JOIN stations s ON s.id = ns.station_id
      WHERE ns.wa_enabled=1 AND ns.credit_reminder_enabled=1 AND ns.wa_number IS NOT NULL`, []);

    for (const ns of stations) {
      const overdueDays = ns.credit_reminder_days || 30;
      const customers = await db.all(`
        SELECT c.company_name, c.mobile, c.outstanding,
          (SELECT MAX(payment_date) FROM credit_payments WHERE customer_id=c.id) as last_payment
        FROM credit_customers c
        WHERE c.station_id=? AND c.outstanding > 500 AND c.is_active=1
          AND c.mobile IS NOT NULL AND c.mobile != ''`, [ns.station_id]);

      const today = new Date();
      for (const cust of customers) {
        let days = 999;
        if (cust.last_payment) days = Math.floor((today - new Date(cust.last_payment)) / 86400000);
        if (days < overdueDays) continue;
        const msg = templates.creditReminder(ns.station_name, cust.company_name, cust.outstanding, days, ns.mobile);
        try {
          const result = await sendWhatsApp(cust.mobile, msg);
          await logNotification(ns.station_id, 'credit_reminder', cust.mobile, msg, 'sent', result.provider, null, { company: cust.company_name, auto: true });
        } catch(e) {
          await logNotification(ns.station_id, 'credit_reminder', cust.mobile, msg, 'failed', PROVIDER, e.message, { company: cust.company_name });
        }
      }
    }
  } catch(e) {
    console.error('[WA] Credit reminder cron failed:', e.message);
  }
}

module.exports.triggerDayCloseSummary = triggerDayCloseSummary;
module.exports.triggerLowStockCheck = triggerLowStockCheck;
module.exports.runCreditReminderCron = runCreditReminderCron;
module.exports.logNotification = logNotification;

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 6: METER MISMATCH ALERT
// Called by shifts.js after close when meter delta ≠ system sales
// ═══════════════════════════════════════════════════════════════════════════
async function triggerMeterMismatch(stationId, shiftName, alerts) {
  try {
    const settings = await db.get('SELECT * FROM notification_settings WHERE station_id=?', [stationId]);
    if (!settings || !settings.wa_enabled || !settings.wa_number) return;

    const station = await db.get('SELECT station_name FROM stations WHERE id=?', [stationId]);
    const msg = templates.meterMismatch(station.station_name, shiftName, alerts);
    const result = await sendWhatsApp(settings.wa_number, msg);
    await logNotification(stationId, 'meter_mismatch', settings.wa_number, msg, 'sent', result.provider, null, { shiftName, alerts });
  } catch(e) {
    console.error('[WA] Meter mismatch trigger failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 6: CREDIT SALE BILL — send bill to customer WhatsApp after credit sale
// ═══════════════════════════════════════════════════════════════════════════
async function triggerCreditSaleBill(stationId, saleData) {
  // saleData: { customerId, invoiceNo, fuelType, quantity, rate, amount }
  try {
    const settings = await db.get('SELECT * FROM notification_settings WHERE station_id=?', [stationId]);
    if (!settings || !settings.wa_enabled) return;

    const [station, customer] = await Promise.all([
      db.get('SELECT station_name, mobile FROM stations WHERE id=?', [stationId]),
      db.get('SELECT company_name, mobile, outstanding FROM credit_customers WHERE id=? AND station_id=?',
        [saleData.customerId, stationId])
    ]);
    if (!customer?.mobile) return; // no number to send to

    const msg = templates.creditSaleBill(
      station.station_name, customer.company_name, saleData.invoiceNo,
      saleData.fuelType, saleData.quantity, saleData.rate, saleData.amount,
      customer.outstanding, station.mobile
    );
    const result = await sendWhatsApp(customer.mobile, msg);
    await logNotification(stationId, 'credit_sale_bill', customer.mobile, msg, 'sent', result.provider, null, { invoiceNo: saleData.invoiceNo });
  } catch(e) {
    console.error('[WA] Credit sale bill trigger failed:', e.message);
  }
}

module.exports.triggerMeterMismatch   = triggerMeterMismatch;
module.exports.triggerCreditSaleBill  = triggerCreditSaleBill;

// ═══════════════════════════════════════════════════════════════════════════
// SPRINT 7: PRODUCT EXPIRY ALERT CRON
// Runs daily at 08:00 IST — alerts owner about expired/expiring lubes
// ═══════════════════════════════════════════════════════════════════════════
async function runExpiryAlertCron() {
  try {
    const stations = await db.all(`
      SELECT ns.station_id, ns.wa_number, ns.wa_enabled,
        COALESCE(ns.expiry_alert_enabled, 1) as expiry_alert_enabled,
        COALESCE(ns.expiry_alert_days, 30) as expiry_alert_days,
        s.station_name
      FROM notification_settings ns
      JOIN stations s ON s.id = ns.station_id
      WHERE ns.wa_enabled=1 AND ns.wa_number IS NOT NULL`, []);

    for (const ns of stations) {
      if (!ns.expiry_alert_enabled) continue;

      const products = await db.all(`
        SELECT product_name, stock_qty, unit, expiry_date,
          CAST(julianday(expiry_date) - julianday('now') AS INTEGER) as days_to_expiry
        FROM products WHERE station_id=? AND is_active=1 AND expiry_date IS NOT NULL
          AND expiry_date <= date('now', '+' || ? || ' days')
        ORDER BY expiry_date ASC`, [ns.station_id, ns.expiry_alert_days]);

      if (products.length === 0) continue;

      const expired  = products.filter(p => p.days_to_expiry <= 0);
      const expiring = products.filter(p => p.days_to_expiry > 0);

      // Don't spam — check if already sent today
      const sentToday = await db.get(
        `SELECT id FROM notification_log WHERE station_id=? AND type='expiry_alert' AND date(sent_at)=date('now')`,
        [ns.station_id]);
      if (sentToday) continue;

      const msg = templates.expiryAlert(ns.station_name, expired, expiring);
      try {
        const result = await sendWhatsApp(ns.wa_number, msg);
        await logNotification(ns.station_id, 'expiry_alert', ns.wa_number, msg, 'sent', result.provider, null,
          { expired: expired.length, expiring: expiring.length, auto: true });
      } catch(e) {
        await logNotification(ns.station_id, 'expiry_alert', ns.wa_number, msg, 'failed', PROVIDER, e.message, null);
      }
    }
  } catch(e) {
    console.error('[WA] Expiry alert cron failed:', e.message);
  }
}

module.exports.runExpiryAlertCron = runExpiryAlertCron;

