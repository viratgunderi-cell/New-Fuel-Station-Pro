'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// ── TANKS ─────────────────────────────────────────────────────────────────
router.get('/tanks', async (req, res) => {
  const data = await db.all(`SELECT t.*,(SELECT COUNT(*) FROM nozzles WHERE tank_id=t.id AND is_active=1) as nozzle_count FROM tanks t WHERE t.station_id=? ORDER BY t.fuel_type`, [req.user.stationId]);
  res.json({ success: true, data });
});

// ── TANK CRUD (Sprint 6 redesign) ─────────────────────────────────────────
router.post('/tanks', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const { tankName, fuelType, displayName, capacity, currentStock, minAlert } = req.body;
  if (!tankName || !fuelType || !capacity)
    return res.status(400).json({ success: false, error: 'tankName, fuelType, capacity required.' });
  if (!['MS','HSD','CNG'].includes(fuelType))
    return res.status(400).json({ success: false, error: 'fuelType must be MS, HSD or CNG.' });
  const r = await db.run(
    `INSERT INTO tanks (station_id,tank_name,fuel_type,display_name,capacity,current_stock,min_alert) VALUES (?,?,?,?,?,?,?)`,
    [sid, tankName, fuelType, displayName||null, parseFloat(capacity), parseFloat(currentStock||0), parseFloat(minAlert||2000)]
  );
  await db.logAudit(sid, req.user.id, req.user.username, 'TANK_ADD', 'tanks', r.lastInsertRowid, null,
    { tankName, fuelType, capacity }, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, tankId: r.lastInsertRowid, message: 'Tank added.' });
});

router.put('/tanks/:id', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const tank = await db.get('SELECT * FROM tanks WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  const { tankName, displayName, capacity, minAlert } = req.body;
  await db.run(
    `UPDATE tanks SET tank_name=COALESCE(?,tank_name), display_name=COALESCE(?,display_name),
     capacity=COALESCE(?,capacity), min_alert=COALESCE(?,min_alert), updated_at=datetime('now') WHERE id=?`,
    [tankName||null, displayName!==undefined?displayName:null, capacity?parseFloat(capacity):null,
     minAlert?parseFloat(minAlert):null, tank.id]
  );
  await db.logAudit(sid, req.user.id, req.user.username, 'TANK_EDIT', 'tanks', tank.id, tank, req.body, req.ip, req.get('user-agent'));
  res.json({ success: true, message: 'Tank updated.' });
});

router.delete('/tanks/:id', authorize('owner'), async (req, res) => {
  const sid = req.user.stationId;
  const tank = await db.get('SELECT * FROM tanks WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  // Guard: don't delete if has sales in last 30 days
  const recentSales = await db.get(
    `SELECT COUNT(*) as c FROM sales WHERE tank_id=? AND date(sale_time)>=date('now','-30 days')`, [tank.id]);
  if (recentSales?.c > 0)
    return res.status(409).json({ success: false, error: `Cannot delete — ${recentSales.c} sales recorded in last 30 days. Deactivate instead.` });
  await db.run(`UPDATE tanks SET is_active=0, updated_at=datetime('now') WHERE id=?`, [tank.id]);
  await db.logAudit(sid, req.user.id, req.user.username, 'TANK_DELETE', 'tanks', tank.id, tank, null, req.ip, req.get('user-agent'));
  res.json({ success: true, message: 'Tank deactivated.' });
});

router.post('/tanks/dip-reading', authorize('owner','manager'), async (req, res) => {
  const { tankId, calculatedLitres, dipMm, notes } = req.body;
  const tank = await db.get('SELECT * FROM tanks WHERE id=? AND station_id=?', [tankId, req.user.stationId]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  const variance = calculatedLitres - tank.current_stock;
  await db.run(`INSERT INTO dip_readings (station_id,tank_id,dip_mm,calculated_litres,actual_stock,variance,taken_by,notes) VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.stationId, tankId, dipMm||null, calculatedLitres, calculatedLitres, variance, req.user.id, notes||null]);
  await db.run(`UPDATE tanks SET current_stock=?,updated_at=datetime('now') WHERE id=?`, [calculatedLitres, tankId]);
  res.json({ success: true, message: 'Dip reading saved.', variance });
});

// ── PURCHASES ─────────────────────────────────────────────────────────────
router.get('/purchases', async (req, res) => {
  const data = await db.all(`SELECT p.*,t.tank_name,t.fuel_type,s.name as supplier_name FROM purchases p LEFT JOIN tanks t ON t.id=p.tank_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.station_id=? ORDER BY p.purchase_date DESC LIMIT 50`, [req.user.stationId]);
  res.json({ success: true, data });
});

router.get('/purchases/suppliers', async (req, res) => {
  const data = await db.all('SELECT * FROM suppliers WHERE station_id=? AND is_active=1', [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/purchases', authorize('owner','manager'), async (req, res) => {
  const { tankId, supplierId, quantity, rate, invoiceNo, purchaseDate, density } = req.body;
  const tank = await db.get('SELECT id FROM tanks WHERE id=? AND station_id=?', [tankId, req.user.stationId]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  const amount = +(quantity * rate).toFixed(2);
  await db.transaction(async t => {
    await t.run(`INSERT INTO purchases (station_id,tank_id,supplier_id,invoice_no,quantity,rate,amount,total_amount,density,purchase_date,received_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user.stationId, tankId, supplierId||null, invoiceNo||null, quantity, rate, amount, amount, density||null, purchaseDate||new Date().toISOString().slice(0,10), req.user.id]);
    await t.run(`UPDATE tanks SET current_stock=current_stock+?,updated_at=datetime('now') WHERE id=?`, [quantity, tankId]);
  });
  res.status(201).json({ success: true, message: 'Purchase recorded.' });
});

// ── EMPLOYEES ─────────────────────────────────────────────────────────────
router.get('/employees', async (req, res) => {
  const data = await db.all('SELECT * FROM employees WHERE station_id=? AND is_active=1 ORDER BY full_name', [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/employees', authorize('owner','manager'), [
  body('fullName').trim().notEmpty().escape(),
  body('role').notEmpty().escape(),
  body('salary').optional().isFloat({min:0})
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  const { fullName, role, mobile, salary, joinDate, empCode } = req.body;
  try {
    if (empCode) {
      const dup = await db.get('SELECT id FROM employees WHERE station_id=? AND emp_code=? AND is_active=1', [req.user.stationId, empCode]);
      if (dup) return res.status(409).json({ success: false, error: 'Employee code already exists.' });
    }
    const result = await db.run('INSERT INTO employees (station_id,full_name,role,mobile,salary,join_date,emp_code) VALUES (?,?,?,?,?,?,?)',
      [req.user.stationId, fullName, role, mobile||null, salary||0, joinDate||null, empCode||null]);
    res.status(201).json({ success: true, message: 'Employee added.', employeeId: result.lastInsertRowid||result.lastID });
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ success: false, error: 'Employee code already exists.' });
    console.error('[emp/post]', e.message);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ── CREDIT CUSTOMERS ──────────────────────────────────────────────────────
router.get('/customers', async (req, res) => {
  const data = await db.all('SELECT * FROM credit_customers WHERE station_id=? AND is_active=1 ORDER BY company_name', [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/customers', authorize('owner','manager'), [
  body('companyName').trim().notEmpty().escape(),
  body('creditLimit').isFloat({min:0})
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  const { companyName, contactName, mobile, email, gstin, creditLimit } = req.body;
  const result = await db.run('INSERT INTO credit_customers (station_id,company_name,contact_name,mobile,email,gstin,credit_limit) VALUES (?,?,?,?,?,?,?)',
    [req.user.stationId, companyName, contactName||null, mobile||null, email||null, gstin||null, creditLimit]);
  res.status(201).json({ success: true, message: 'Customer added.', customerId: result.lastInsertRowid||result.lastID });
});

router.get('/customers/:id/statement', async (req, res) => {
  const cust = await db.get('SELECT * FROM credit_customers WHERE id=? AND station_id=?', [req.params.id, req.user.stationId]);
  if (!cust) return res.status(404).json({ success: false, error: 'Customer not found.' });
  const sales = await db.all(`SELECT sale_time,invoice_no,fuel_type,quantity,total_amount FROM sales WHERE customer_id=? AND station_id=? AND is_cancelled=0 ORDER BY sale_time DESC LIMIT 100`, [req.params.id, req.user.stationId]);
  const payments = await db.all('SELECT payment_date,amount,payment_mode,reference_no FROM credit_payments WHERE customer_id=? AND station_id=? ORDER BY payment_date DESC LIMIT 100', [req.params.id, req.user.stationId]);
  res.json({ success: true, data: { customer: cust, sales, payments } });
});

router.post('/customers/:id/payment', authorize('owner','manager'), async (req, res) => {
  const { amount, paymentMode, referenceNo } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount.' });
  const cust = await db.get('SELECT * FROM credit_customers WHERE id=? AND station_id=?', [req.params.id, req.user.stationId]);
  if (!cust) return res.status(404).json({ success: false, error: 'Customer not found.' });
  await db.transaction(async t => {
    await t.run('INSERT INTO credit_payments (station_id,customer_id,amount,payment_mode,reference_no,received_by) VALUES (?,?,?,?,?,?)',
      [req.user.stationId, req.params.id, amount, paymentMode||'cash', referenceNo||null, req.user.id]);
    await t.run(`UPDATE credit_customers SET outstanding=MAX(0,outstanding-?),updated_at=datetime('now') WHERE id=?`, [amount, req.params.id]);
  });
  res.json({ success: true, message: 'Payment recorded.' });
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const sid = req.user.stationId;
  const today = new Date().toISOString().slice(0,10);
  const [todaySummary, topPayments, tanks, openShift, topCredit, weekTrend, recentSales, creditStats] = await Promise.all([
    db.get(`SELECT COUNT(*) as c, COALESCE(SUM(total_amount),0) as r, COALESCE(SUM(quantity),0) as litres, COALESCE(SUM(CASE WHEN payment_mode='cash' THEN total_amount ELSE 0 END),0) as cash FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid, today]),
    db.all(`SELECT payment_mode, COALESCE(SUM(total_amount),0) as amount, COUNT(*) as txns FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY payment_mode ORDER BY amount DESC`, [sid, today]),
    db.all('SELECT id,tank_name,fuel_type,current_stock,capacity,min_alert FROM tanks WHERE station_id=? AND is_active=1', [sid]),
    db.get(`SELECT sh.*,u.full_name as opened_by_name, (SELECT COUNT(*) FROM sales WHERE shift_id=sh.id AND is_cancelled=0) as sales_count FROM shifts sh LEFT JOIN users u ON u.id=sh.opened_by WHERE sh.station_id=? AND sh.status='open' LIMIT 1`, [sid]),
    db.all('SELECT company_name,outstanding FROM credit_customers WHERE station_id=? AND outstanding>0 AND is_active=1 ORDER BY outstanding DESC LIMIT 5', [sid]),
    db.all(`SELECT date(sale_time) as d, COALESCE(SUM(total_amount),0) as rev FROM sales WHERE station_id=? AND date(sale_time)>=date('now','-6 days') AND is_cancelled=0 GROUP BY d ORDER BY d`, [sid]),
    db.all(`SELECT invoice_no,fuel_type,quantity,total_amount,payment_mode,sale_time FROM sales WHERE station_id=? AND is_cancelled=0 ORDER BY sale_time DESC LIMIT 10`, [sid]),
    db.get(`SELECT COALESCE(SUM(outstanding),0) as total, COUNT(*) as accounts FROM credit_customers WHERE station_id=? AND outstanding>0 AND is_active=1`, [sid])
  ]);
  res.json({ success: true, data: {
    todaySales: todaySummary.c,
    todayRevenue: todaySummary.r,
    todayLitres: todaySummary.litres,
    cashToday: todaySummary.cash,
    totalCredit: creditStats.total,
    creditAccounts: creditStats.accounts,
    paymentBreakdown: topPayments,
    topPayments, tanks, openShift, topCredit, weekTrend, recentSales
  }});
});

// ── REPORTS ───────────────────────────────────────────────────────────────
router.get('/reports/daily', async (req, res) => {
  const sid = req.user.stationId;
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const [fuelWise, paymentWise, shiftWise, hourly] = await Promise.all([
    db.all(`SELECT fuel_type,COUNT(*) as txns,SUM(quantity) as qty,SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY fuel_type`, [sid,date]),
    db.all(`SELECT payment_mode,COUNT(*) as txns,SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY payment_mode`, [sid,date]),
    db.all(`SELECT sh.shift_name,sh.open_time,sh.close_time,sh.total_sales,sh.cash_collected,sh.upi_collected,sh.card_collected,sh.credit_sales,sh.cash_physical,sh.cash_variance FROM shifts sh WHERE sh.station_id=? AND date(sh.open_time)=?`, [sid,date]),
    db.all(`SELECT strftime('%H',sale_time) as hr,COUNT(*) as txns,SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY hr ORDER BY hr`, [sid,date])
  ]);
  res.json({ success: true, data: { date, fuelWise, paymentWise, shiftWise, hourly } });
});

router.get('/reports/stock', async (req, res) => {
  const sid = req.user.stationId;
  const tanks = await db.all('SELECT t.*,(SELECT quantity FROM purchases WHERE tank_id=t.id ORDER BY created_at DESC LIMIT 1) as last_purchase_qty FROM tanks t WHERE t.station_id=? AND t.is_active=1', [sid]);
  const recent = await db.all(`SELECT p.*,t.tank_name,t.fuel_type,s.name as supplier_name FROM purchases p LEFT JOIN tanks t ON t.id=p.tank_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.station_id=? ORDER BY p.purchase_date DESC LIMIT 20`, [sid]);
  res.json({ success: true, data: { tanks, recentPurchases: recent } });
});

router.get('/reports/upi', async (req, res) => {
  const sid = req.user.stationId;
  const { from, to } = req.query;
  const dateFrom = from || new Date().toISOString().slice(0,10);
  const dateTo = to || dateFrom;
  const data = await db.all(`SELECT payment_mode,COUNT(*) as txns,SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time) BETWEEN ? AND ? AND payment_mode IN ('phonepe','gpay','paytm') AND is_cancelled=0 GROUP BY payment_mode`, [sid, dateFrom, dateTo]);
  res.json({ success: true, data });
});

router.get('/reports/outstanding', async (req, res) => {
  const data = await db.all('SELECT company_name,contact_name,mobile,outstanding,credit_limit FROM credit_customers WHERE station_id=? AND outstanding>0 AND is_active=1 ORDER BY outstanding DESC', [req.user.stationId]);
  res.json({ success: true, data });
});

// ── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  const station = await db.get('SELECT * FROM stations WHERE id=?', [req.user.stationId]);
  res.json({ success: true, data: station });
});

router.put('/settings', authorize('owner'), async (req, res) => {
  const { stationName, msPrice, hsdPrice, cngPrice, xpPrice, idleTimeout, gstin, address, mobile, email } = req.body;
  await db.run(`UPDATE stations SET station_name=COALESCE(?,station_name),ms_price=COALESCE(?,ms_price),hsd_price=COALESCE(?,hsd_price),cng_price=COALESCE(?,cng_price),xp_price=COALESCE(?,xp_price),idle_timeout=COALESCE(?,idle_timeout),gstin=COALESCE(?,gstin),address=COALESCE(?,address),mobile=COALESCE(?,mobile),email=COALESCE(?,email),updated_at=datetime('now') WHERE id=?`,
    [stationName||null, msPrice||null, hsdPrice||null, cngPrice||null, xpPrice||null, idleTimeout||null, gstin||null, address||null, mobile||null, email||null, req.user.stationId]);
  res.json({ success: true, message: 'Settings updated.' });
});

router.get('/settings/users', authorize('owner'), async (req, res) => {
  const data = await db.all('SELECT id,username,full_name,role,mobile,is_active,last_login FROM users WHERE station_id=? ORDER BY role,username', [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/settings/users', authorize('owner'), [
  body('username').trim().notEmpty().isLength({min:4,max:30}).escape(),
  body('password').isLength({min:8}).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/),
  body('fullName').trim().notEmpty().escape(),
  body('role').isIn(['manager','cashier','attendant'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  const { username, password, fullName, role, mobile } = req.body;
  const exists = await db.get('SELECT id FROM users WHERE station_id=? AND username=? COLLATE NOCASE', [req.user.stationId, username]);
  if (exists) return res.status(409).json({ success: false, error: 'Username already exists.' });
  await db.run('INSERT INTO users (station_id,username,password_hash,full_name,role,mobile) VALUES (?,?,?,?,?,?)',
    [req.user.stationId, username, bcrypt.hashSync(password,12), fullName, role, mobile||null]);
  res.status(201).json({ success: true, message: 'User created.' });
});

router.get('/settings/audit', authorize('owner','manager'), async (req, res) => {
  const data = await db.all('SELECT * FROM audit_log WHERE station_id=? ORDER BY created_at DESC LIMIT 100', [req.user.stationId]);
  res.json({ success: true, data });
});

// Audit log top-level alias
router.get('/audit', authorize('owner','manager'), async (req, res) => {
  const data = await db.all('SELECT * FROM audit_log WHERE station_id=? ORDER BY created_at DESC LIMIT 200', [req.user.stationId]);
  res.json({ success: true, data });
});

// ── SPRINT 1: Enhanced Reports ────────────────────────────────────────────

// Stock Movement: opening → purchases → sales → closing per tank per date range
router.get('/reports/stock-movement', async (req, res) => {
  const sid = req.user.stationId;
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const tanks = await db.all('SELECT * FROM tanks WHERE station_id=? AND is_active=1', [sid]);
  const movements = await Promise.all(tanks.map(async t => {
    const sales = await db.get(`SELECT COALESCE(SUM(quantity),0) as sold FROM sales WHERE station_id=? AND tank_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid, t.id, date]);
    const purchases = await db.get(`SELECT COALESCE(SUM(quantity),0) as received FROM purchases WHERE station_id=? AND tank_id=? AND purchase_date=?`, [sid, t.id, date]);
    const sold = sales.sold || 0;
    const received = purchases.received || 0;
    const opening = t.current_stock + sold - received;
    const closing = t.current_stock;
    const variance = (opening + received - sold) - closing;
    return { tankId: t.id, tankName: t.tank_name, fuelType: t.fuel_type, capacity: t.capacity, opening: Math.max(0, opening), received, sold, closing, variance };
  }));
  res.json({ success: true, data: { date, movements } });
});

// Enhanced daily report with nozzle-wise breakdown
router.get('/reports/daily-enhanced', async (req, res) => {
  const sid = req.user.stationId;
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const [fuelWise, paymentWise, shiftWise, hourly, nozzleWise, totals] = await Promise.all([
    db.all(`SELECT fuel_type,COUNT(*) as txns,ROUND(SUM(quantity),2) as qty,ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY fuel_type`, [sid,date]),
    db.all(`SELECT payment_mode,COUNT(*) as txns,ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY payment_mode`, [sid,date]),
    db.all(`SELECT sh.shift_name,sh.open_time,sh.close_time,sh.total_sales,sh.cash_collected,sh.upi_collected,sh.card_collected,sh.credit_sales,sh.cash_physical,sh.cash_variance,u.full_name as opened_by FROM shifts sh LEFT JOIN users u ON u.id=sh.opened_by WHERE sh.station_id=? AND date(sh.open_time)=?`, [sid,date]),
    db.all(`SELECT strftime('%H',sale_time) as hr,COUNT(*) as txns,ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY hr ORDER BY hr`, [sid,date]),
    db.all(`SELECT n.nozzle_name,s.fuel_type,COUNT(*) as txns,ROUND(SUM(s.quantity),2) as qty,ROUND(SUM(s.total_amount),2) as amount FROM sales s LEFT JOIN nozzles n ON n.id=s.nozzle_id WHERE s.station_id=? AND date(s.sale_time)=? AND s.is_cancelled=0 GROUP BY s.nozzle_id ORDER BY n.nozzle_name`, [sid,date]),
    db.get(`SELECT COUNT(*) as txns, ROUND(SUM(total_amount),2) as revenue, ROUND(SUM(quantity),2) as litres FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid,date])
  ]);
  res.json({ success: true, data: { date, fuelBreakdown: fuelWise, paymentBreakdown: paymentWise, fuelWise, paymentWise, shiftWise, hourly, nozzleWise, totals } });
});

// Credit customers with overdue info
router.get('/customers/outstanding', async (req, res) => {
  const sid = req.user.stationId;
  const data = await db.all(`
    SELECT c.*,
      (SELECT MAX(payment_date) FROM credit_payments WHERE customer_id=c.id AND station_id=c.station_id) as last_payment_date,
      (SELECT COUNT(*) FROM sales WHERE customer_id=c.id AND station_id=c.station_id AND date(sale_time)>=date('now','-30 days') AND is_cancelled=0) as sales_30d
    FROM credit_customers c
    WHERE c.station_id=? AND c.is_active=1
    ORDER BY c.outstanding DESC`, [sid]);
  const today = new Date();
  const result = data.map(c => {
    let daysOverdue = 0;
    if (c.last_payment_date) {
      daysOverdue = Math.floor((today - new Date(c.last_payment_date)) / 86400000);
    } else if (c.outstanding > 0) {
      daysOverdue = 999;
    }
    const cycleLimit = c.billing_cycle === 'weekly' ? 7 : c.billing_cycle === 'fortnightly' ? 14 : 30;
    return { ...c, daysOverdue, isOverdue: daysOverdue > cycleLimit && c.outstanding > 0, cycleLimit };
  });
  res.json({ success: true, data: result });
});

// 7-day trend for dashboard chart
router.get('/reports/trend', async (req, res) => {
  const sid = req.user.stationId;
  const [daily, fuelSplit, paymentSplit] = await Promise.all([
    db.all(`SELECT date(sale_time) as d, ROUND(SUM(total_amount),2) as rev, ROUND(SUM(quantity),2) as litres, COUNT(*) as txns FROM sales WHERE station_id=? AND date(sale_time)>=date('now','-6 days') AND is_cancelled=0 GROUP BY d ORDER BY d`, [sid]),
    db.all(`SELECT fuel_type, ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)>=date('now','-6 days') AND is_cancelled=0 GROUP BY fuel_type`, [sid]),
    db.all(`SELECT payment_mode, ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)>=date('now','-6 days') AND is_cancelled=0 GROUP BY payment_mode`, [sid])
  ]);
  res.json({ success: true, data: { daily, fuelSplit, paymentSplit } });
});

// ═══════════════════════════════════════════════════════════════════════════
// SPRINT 5 — DIP CHART & PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════

// ── DIP CHART: GET calibration data for a tank ───────────────────────────
router.get('/tanks/:id/dip-chart', async (req, res) => {
  const sid = req.user.stationId;
  const tank = await db.get('SELECT * FROM tanks WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  const rows = await db.all('SELECT mm_level, litres_volume FROM dip_chart_data WHERE tank_id=? ORDER BY mm_level ASC', [req.params.id]);
  res.json({ success: true, data: { tank, rows } });
});

// ── DIP CHART: SAVE/REPLACE calibration rows for a tank ──────────────────
router.post('/tanks/:id/dip-chart', authorize('owner', 'manager'), async (req, res) => {
  const sid = req.user.stationId;
  const tank = await db.get('SELECT * FROM tanks WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  const { rows } = req.body; // [{mm, litres}, ...]
  if (!Array.isArray(rows) || rows.length < 2) return res.status(400).json({ success: false, error: 'Provide at least 2 calibration points.' });
  await db.transaction(async t => {
    await t.run('DELETE FROM dip_chart_data WHERE tank_id=?', [req.params.id]);
    for (const r of rows) {
      const mm = parseFloat(r.mm), litres = parseFloat(r.litres);
      if (isNaN(mm) || isNaN(litres) || mm < 0 || litres < 0) continue;
      await t.run('INSERT OR REPLACE INTO dip_chart_data (station_id,tank_id,mm_level,litres_volume) VALUES (?,?,?,?)', [sid, req.params.id, mm, litres]);
    }
  });
  const saved = await db.all('SELECT mm_level, litres_volume FROM dip_chart_data WHERE tank_id=? ORDER BY mm_level ASC', [req.params.id]);
  await db.logAudit(sid, req.user.id, req.user.username, 'update', 'dip_chart', tank.id, null, { points: saved.length }, req.ip, req.headers['user-agent']);
  res.json({ success: true, data: saved, message: `Dip chart saved (${saved.length} points).` });
});

// ── DIP CHART: Convert mm → litres via linear interpolation ───────────────
router.post('/tanks/mm-to-litres', async (req, res) => {
  const sid = req.user.stationId;
  const { tankId, mm } = req.body;
  if (!tankId || mm == null) return res.status(400).json({ success: false, error: 'tankId and mm required.' });
  const rows = await db.all('SELECT mm_level, litres_volume FROM dip_chart_data WHERE tank_id=? AND station_id=? ORDER BY mm_level ASC', [tankId, sid]);
  if (rows.length < 2) return res.status(404).json({ success: false, error: 'No dip chart configured for this tank.' });
  const dipMm = parseFloat(mm);
  // Clamp to chart range
  if (dipMm <= rows[0].mm_level) return res.json({ success: true, litres: rows[0].litres_volume, interpolated: false });
  if (dipMm >= rows[rows.length-1].mm_level) return res.json({ success: true, litres: rows[rows.length-1].litres_volume, interpolated: false });
  // Binary search for bracket
  let lo = 0, hi = rows.length - 1;
  while (hi - lo > 1) { const mid = Math.floor((lo+hi)/2); if (rows[mid].mm_level <= dipMm) lo = mid; else hi = mid; }
  const r0 = rows[lo], r1 = rows[hi];
  const t = (dipMm - r0.mm_level) / (r1.mm_level - r0.mm_level);
  const litres = Math.round((r0.litres_volume + t * (r1.litres_volume - r0.litres_volume)) * 10) / 10;
  res.json({ success: true, litres, interpolated: true, mm: dipMm, lo: r0, hi: r1 });
});

// ── DIP CHART: GET recent dip readings for a tank ─────────────────────────
router.get('/tanks/:id/dip-readings', async (req, res) => {
  const sid = req.user.stationId;
  const tank = await db.get('SELECT id,tank_name FROM tanks WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  const rows = await db.all(`SELECT dr.*,u.full_name as taken_by_name FROM dip_readings dr LEFT JOIN users u ON u.id=dr.taken_by WHERE dr.tank_id=? AND dr.station_id=? ORDER BY dr.reading_time DESC LIMIT 30`, [req.params.id, sid]);
  res.json({ success: true, data: rows });
});

// ── Recent dip readings across ALL tanks (for the new inventory page) ──────
router.get('/tanks/recent-dip-readings', async (req, res) => {
  const sid = req.user.stationId;
  const limit = Math.min(parseInt(req.query.limit)||50, 200);
  const rows = await db.all(
    `SELECT dr.*, t.tank_name, t.fuel_type, t.display_name, u.full_name as taken_by_name
     FROM dip_readings dr
     JOIN tanks t ON t.id=dr.tank_id
     LEFT JOIN users u ON u.id=dr.taken_by
     WHERE dr.station_id=?
     ORDER BY dr.reading_time DESC LIMIT ?`,
    [sid, limit]
  );
  res.json({ success: true, data: rows });
});

// ── DIP CHART: Submit a dip reading (mm → auto-convert if chart exists) ────
// Override the old endpoint with enhanced version
router.post('/tanks/dip-reading-v2', authorize('owner', 'manager'), async (req, res) => {
  const sid = req.user.stationId;
  const { tankId, dipMm, calculatedLitres, notes } = req.body;
  const tank = await db.get('SELECT * FROM tanks WHERE id=? AND station_id=?', [tankId, sid]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  let litres = calculatedLitres != null ? parseFloat(calculatedLitres) : null;
  let autoConverted = false;
  // If mm given but no litres, try dip chart interpolation
  if (dipMm != null && litres == null) {
    const rows = await db.all('SELECT mm_level, litres_volume FROM dip_chart_data WHERE tank_id=? ORDER BY mm_level ASC', [tankId]);
    if (rows.length >= 2) {
      const dm = parseFloat(dipMm);
      if (dm <= rows[0].mm_level) { litres = rows[0].litres_volume; }
      else if (dm >= rows[rows.length-1].mm_level) { litres = rows[rows.length-1].litres_volume; }
      else {
        let lo = 0, hi = rows.length - 1;
        while (hi - lo > 1) { const mid = Math.floor((lo+hi)/2); if (rows[mid].mm_level <= dm) lo = mid; else hi = mid; }
        const r0 = rows[lo], r1 = rows[hi];
        const t2 = (dm - r0.mm_level) / (r1.mm_level - r0.mm_level);
        litres = Math.round((r0.litres_volume + t2 * (r1.litres_volume - r0.litres_volume)) * 10) / 10;
      }
      autoConverted = true;
    }
  }
  if (litres == null || isNaN(litres)) return res.status(400).json({ success: false, error: 'Provide dipMm (with dip chart) or calculatedLitres directly.' });
  const variance = litres - tank.current_stock;
  await db.run(`INSERT INTO dip_readings (station_id,tank_id,dip_mm,calculated_litres,actual_stock,variance,taken_by,notes) VALUES (?,?,?,?,?,?,?,?)`,
    [sid, tankId, dipMm||null, litres, litres, variance, req.user.id, notes||null]);
  await db.run(`UPDATE tanks SET current_stock=?,updated_at=datetime('now') WHERE id=?`, [litres, tankId]);
  res.json({ success: true, litres, variance, autoConverted, message: `Dip reading saved. Stock updated to ${litres}L.` });
});

// ── PRODUCTS: List all products ───────────────────────────────────────────
router.get('/products', async (req, res) => {
  const sid = req.user.stationId;
  const data = await db.all(`SELECT p.*,
    COALESCE((SELECT SUM(quantity) FROM product_sales WHERE product_id=p.id AND station_id=p.station_id AND is_cancelled=0 AND date(sale_time)>=date('now','-30 days')),0) as sold_30d
    FROM products p WHERE p.station_id=? ORDER BY p.category,p.product_name`, [sid]);
  res.json({ success: true, data });
});

// ── PRODUCTS: Add product ─────────────────────────────────────────────────
router.post('/products', authorize('owner', 'manager'), async (req, res) => {
  const sid = req.user.stationId;
  const { productName, productCode, category, hsnCode, unit, mrp, salePrice, gstRate, stockQty, minStock, expiryDate } = req.body;
  if (!productName) return res.status(400).json({ success: false, error: 'Product name required.' });
  const r = await db.run(`INSERT INTO products (station_id,product_name,product_code,category,hsn_code,unit,mrp,sale_price,gst_rate,stock_qty,min_stock,expiry_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [sid, productName, productCode||null, category||'lubricant', hsnCode||null, unit||'litre', parseFloat(mrp||0), parseFloat(salePrice||0), parseFloat(gstRate||18), parseFloat(stockQty||0), parseFloat(minStock||5), expiryDate||null]);
  await db.logAudit(sid, req.user.id, req.user.username, 'create', 'product', r.lastInsertRowid, null, req.body, req.ip, req.headers['user-agent']);
  res.json({ success: true, productId: r.lastInsertRowid, message: 'Product added.' });
});

// ── PRODUCTS: Update product ──────────────────────────────────────────────
router.put('/products/:id', authorize('owner', 'manager'), async (req, res) => {
  const sid = req.user.stationId;
  const prod = await db.get('SELECT * FROM products WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!prod) return res.status(404).json({ success: false, error: 'Product not found.' });
  const { productName, productCode, category, hsnCode, unit, mrp, salePrice, gstRate, minStock, expiryDate } = req.body;
  const n = v => (v !== undefined && v !== '' ? v : null);
  const nf = v => (v != null && v !== '' ? parseFloat(v) : null);
  await db.run(`UPDATE products SET
    product_name=COALESCE(?,product_name),
    product_code=COALESCE(?,product_code),
    category=COALESCE(?,category),
    hsn_code=COALESCE(?,hsn_code),
    unit=COALESCE(?,unit),
    mrp=COALESCE(?,mrp),
    sale_price=COALESCE(?,sale_price),
    gst_rate=COALESCE(?,gst_rate),
    min_stock=COALESCE(?,min_stock),
    expiry_date=COALESCE(?,expiry_date)
    WHERE id=? AND station_id=?`,
    [n(productName), n(productCode), n(category), n(hsnCode), n(unit), nf(mrp), nf(salePrice), nf(gstRate), nf(minStock), n(expiryDate), req.params.id, sid]);
  res.json({ success: true, message: 'Product updated.' });
});

// ── PRODUCTS: Toggle active/inactive ─────────────────────────────────────
router.delete('/products/:id', authorize('owner'), async (req, res) => {
  const sid = req.user.stationId;
  await db.run('UPDATE products SET is_active=0 WHERE id=? AND station_id=?', [req.params.id, sid]);
  res.json({ success: true, message: 'Product deactivated.' });
});

// ── PRODUCTS: Stock-In ────────────────────────────────────────────────────
router.post('/products/:id/stock-in', authorize('owner', 'manager'), async (req, res) => {
  const sid = req.user.stationId;
  const prod = await db.get('SELECT * FROM products WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!prod) return res.status(404).json({ success: false, error: 'Product not found.' });
  const { quantity, rate, invoiceNo, supplierName, notes } = req.body;
  const qty = parseFloat(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ success: false, error: 'Quantity must be > 0.' });
  await db.transaction(async t => {
    await t.run(`INSERT INTO product_stock_in (station_id,product_id,quantity,rate,invoice_no,supplier_name,notes,received_by) VALUES (?,?,?,?,?,?,?,?)`,
      [sid, req.params.id, qty, parseFloat(rate||0), invoiceNo||null, supplierName||null, notes||null, req.user.id]);
    await t.run('UPDATE products SET stock_qty=stock_qty+? WHERE id=?', [qty, req.params.id]);
  });
  const updated = await db.get('SELECT stock_qty FROM products WHERE id=?', [req.params.id]);
  res.json({ success: true, newStock: updated.stock_qty, message: `Added ${qty} units. New stock: ${updated.stock_qty}.` });
});

// ── PRODUCTS: Record a sale ───────────────────────────────────────────────
router.post('/products/sale', async (req, res) => {
  const sid = req.user.stationId;
  const { productId, quantity, rate, paymentMode, customerName, vehicleNo, shiftId, discount } = req.body;
  const prod = await db.get('SELECT * FROM products WHERE id=? AND station_id=? AND is_active=1', [productId, sid]);
  if (!prod) return res.status(404).json({ success: false, error: 'Product not found.' });
  const qty = parseFloat(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ success: false, error: 'Quantity must be > 0.' });
  if (prod.stock_qty < qty) return res.status(400).json({ success: false, error: `Insufficient stock. Available: ${prod.stock_qty} ${prod.unit}.` });
  const saleRate = parseFloat(rate || prod.sale_price);
  const discAmt = parseFloat(discount || 0);
  const baseAmount = qty * saleRate - discAmt;
  const gstAmt = Math.round((baseAmount * prod.gst_rate / 100) * 100) / 100;
  const totalAmount = Math.round((baseAmount + gstAmt) * 100) / 100;
  const invoiceNo = db.generateInvoiceNo('PS');
  const openShift = shiftId ? await db.get('SELECT id FROM shifts WHERE id=? AND station_id=? AND status=?', [shiftId, sid, 'open']) : null;
  await db.transaction(async t => {
    await t.run(`INSERT INTO product_sales (station_id,invoice_no,product_id,shift_id,quantity,rate,mrp,discount,gst_rate,gst_amount,total_amount,payment_mode,customer_name,vehicle_no,served_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sid, invoiceNo, productId, openShift?.id||null, qty, saleRate, prod.mrp, discAmt, prod.gst_rate, gstAmt, totalAmount, paymentMode||'cash', customerName||null, vehicleNo||null, req.user.id]);
    await t.run('UPDATE products SET stock_qty=stock_qty-? WHERE id=?', [qty, productId]);
  });
  res.json({ success: true, invoiceNo, totalAmount, gstAmount: gstAmt, message: `Sale recorded. ₹${totalAmount}` });
});

// ── PRODUCTS: List recent sales ───────────────────────────────────────────
router.get('/products/sales', async (req, res) => {
  const sid = req.user.stationId;
  const { date, productId } = req.query;
  const filterDate = date || new Date().toISOString().slice(0,10);
  let sql = `SELECT ps.*,p.product_name,p.unit,p.category,u.full_name as served_by_name FROM product_sales ps JOIN products p ON p.id=ps.product_id LEFT JOIN users u ON u.id=ps.served_by WHERE ps.station_id=? AND ps.is_cancelled=0`;
  const params = [sid];
  if (date) { sql += ' AND date(ps.sale_time)=?'; params.push(date); }
  if (productId) { sql += ' AND ps.product_id=?'; params.push(productId); }
  sql += ' ORDER BY ps.sale_time DESC LIMIT 100';
  const data = await db.all(sql, params);
  // Summary
  const summary = await db.get(`SELECT COUNT(*) as txns, ROUND(SUM(total_amount),2) as revenue, ROUND(SUM(quantity),2) as qty FROM product_sales WHERE station_id=? AND is_cancelled=0 AND date(sale_time)=?`, [sid, filterDate]);
  res.json({ success: true, data, summary: summary || { txns: 0, revenue: 0, qty: 0 } });
});

// ── PRODUCTS: Stats (for dashboard widget) ────────────────────────────────
router.get('/products/stats', async (req, res) => {
  const sid = req.user.stationId;
  const [products, lowStock, todaySales, recentStockIn] = await Promise.all([
    db.get('SELECT COUNT(*) as total, SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) as active FROM products WHERE station_id=?', [sid]),
    db.all(`SELECT id,product_name,stock_qty,min_stock,unit,category FROM products WHERE station_id=? AND is_active=1 AND stock_qty<=min_stock ORDER BY stock_qty ASC LIMIT 5`, [sid]),
    db.get(`SELECT COUNT(*) as txns,ROUND(SUM(total_amount),2) as revenue FROM product_sales WHERE station_id=? AND date(sale_time)=date('now') AND is_cancelled=0`, [sid]),
    db.all(`SELECT psi.*,p.product_name FROM product_stock_in psi JOIN products p ON p.id=psi.product_id WHERE psi.station_id=? ORDER BY psi.created_at DESC LIMIT 5`, [sid])
  ]);
  res.json({ success: true, data: { products, lowStock, todaySales, recentStockIn } });
});

// ── PRODUCTS: Cancel a product sale ───────────────────────────────────────
router.put('/products/sale/:id/cancel', authorize('owner', 'manager'), async (req, res) => {
  const sid = req.user.stationId;
  const sale = await db.get('SELECT * FROM product_sales WHERE id=? AND station_id=? AND is_cancelled=0', [req.params.id, sid]);
  if (!sale) return res.status(404).json({ success: false, error: 'Sale not found.' });
  await db.transaction(async t => {
    await t.run('UPDATE product_sales SET is_cancelled=1,cancel_reason=? WHERE id=?', [req.body.reason||'Cancelled', req.params.id]);
    await t.run('UPDATE products SET stock_qty=stock_qty+? WHERE id=?', [sale.quantity, sale.product_id]);
  });
  res.json({ success: true, message: 'Sale cancelled and stock restored.' });
});

// ── DIP CHART: All tanks dip status ──────────────────────────────────────
router.get('/tanks/dip-status', async (req, res) => {
  const sid = req.user.stationId;
  const tanks = await db.all('SELECT * FROM tanks WHERE station_id=? AND is_active=1 ORDER BY fuel_type', [sid]);
  const result = await Promise.all(tanks.map(async t => {
    const chartCount = await db.get('SELECT COUNT(*) as cnt FROM dip_chart_data WHERE tank_id=?', [t.id]);
    const lastReading = await db.get('SELECT * FROM dip_readings WHERE tank_id=? ORDER BY reading_time DESC LIMIT 1', [t.id]);
    return { ...t, chartPoints: chartCount?.cnt || 0, lastReading };
  }));
  res.json({ success: true, data: result });
});


// ═══════════════════════════════════════════════════════════════════════════
// SPRINT 6 ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ── FEATURE 3: Vehicle-wise Fuel Report ──────────────────────────────────
// GET /api/reports/vehicles?from=YYYY-MM-DD&to=YYYY-MM-DD&vehicleNo=&fuelType=
router.get('/reports/vehicles', async (req, res) => {
  const sid = req.user.stationId;
  const to   = req.query.to   || new Date().toISOString().slice(0,10);
  const from = req.query.from || to;
  const { vehicleNo, fuelType, limit = 200 } = req.query;

  let sql = `
    SELECT
      UPPER(TRIM(s.vehicle_no)) as vehicle_no,
      s.fuel_type,
      COUNT(*) as txns,
      ROUND(SUM(s.quantity),2) as total_qty,
      ROUND(SUM(s.total_amount),2) as total_amount,
      MIN(date(s.sale_time)) as first_seen,
      MAX(date(s.sale_time)) as last_seen,
      s.payment_mode,
      c.company_name as credit_customer
    FROM sales s
    LEFT JOIN credit_customers c ON c.id=s.customer_id
    WHERE s.station_id=? AND s.is_cancelled=0
      AND date(s.sale_time) BETWEEN ? AND ?
      AND s.vehicle_no IS NOT NULL AND TRIM(s.vehicle_no) != ''`;
  const params = [sid, from, to];

  if (vehicleNo) { sql += ` AND UPPER(TRIM(s.vehicle_no)) LIKE ?`; params.push('%'+vehicleNo.toUpperCase()+'%'); }
  if (fuelType)  { sql += ` AND s.fuel_type=?`; params.push(fuelType); }

  sql += ` GROUP BY UPPER(TRIM(s.vehicle_no)), s.fuel_type ORDER BY total_amount DESC LIMIT ?`;
  params.push(Number(limit));

  const rows = await db.all(sql, params);

  // Summary
  const totalVehicles = new Set(rows.map(r => r.vehicle_no)).size;
  const totalQty    = rows.reduce((a,b) => a + (b.total_qty||0), 0);
  const totalAmount = rows.reduce((a,b) => a + (b.total_amount||0), 0);

  res.json({ success: true, data: { from, to, rows, summary: { totalVehicles, totalQty: +totalQty.toFixed(2), totalAmount: +totalAmount.toFixed(2) } } });
});

// ── FEATURE 4: Density Variance Analysis ─────────────────────────────────
// GET /api/reports/density-variance?from=&to=
// Standard IS-1460 density ranges: MS 0.720–0.775, HSD 0.820–0.870
const DENSITY_RANGES = {
  MS:  { min: 0.720, max: 0.775, label: 'MS (Petrol)' },
  HSD: { min: 0.820, max: 0.870, label: 'HSD (Diesel)' },
  XP:  { min: 0.720, max: 0.775, label: 'XP Premium' },
  CNG: { min: null,  max: null,  label: 'CNG' },
};

router.get('/reports/density-variance', async (req, res) => {
  const sid  = req.user.stationId;
  const to   = req.query.to   || new Date().toISOString().slice(0,10);
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);

  const purchases = await db.all(
    `SELECT p.id, p.invoice_no, p.purchase_date, p.quantity, p.rate, p.density,
            t.tank_name, t.fuel_type, s.name as supplier_name
     FROM purchases p
     JOIN tanks t ON t.id=p.tank_id
     LEFT JOIN suppliers s ON s.id=p.supplier_id
     WHERE p.station_id=? AND p.purchase_date BETWEEN ? AND ?
     ORDER BY p.purchase_date DESC`,
    [sid, from, to]
  );

  const withFlags = purchases.map(p => {
    const range = DENSITY_RANGES[p.fuel_type];
    let flag = 'ok', flagLabel = '';
    if (p.density == null) {
      flag = 'missing'; flagLabel = 'Not recorded';
    } else if (range?.min != null) {
      if (p.density < range.min) { flag = 'low'; flagLabel = `Below min (${range.min})`; }
      else if (p.density > range.max) { flag = 'high'; flagLabel = `Above max (${range.max})`; }
    }
    return { ...p, flag, flagLabel };
  });

  const stats = {
    total: withFlags.length,
    ok: withFlags.filter(r=>r.flag==='ok').length,
    missing: withFlags.filter(r=>r.flag==='missing').length,
    anomalies: withFlags.filter(r=>r.flag==='low'||r.flag==='high').length,
  };

  res.json({ success: true, data: { from, to, purchases: withFlags, stats, ranges: DENSITY_RANGES } });
});

// ── FEATURE 6: Bank Reconciliation ───────────────────────────────────────
// GET  /api/bank-recon?month=YYYY-MM
// POST /api/bank-recon         — save a reconciliation entry
// GET  /api/bank-recon/summary?month=YYYY-MM — system totals vs saved entries

router.get('/bank-recon', async (req, res) => {
  const sid = req.user.stationId;
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const from = month + '-01';
  // Last day of month
  const [y,m] = month.split('-').map(Number);
  const to = new Date(y, m, 0).toISOString().slice(0,10);

  const saved = await db.all(
    `SELECT * FROM bank_reconciliation WHERE station_id=? AND recon_date BETWEEN ? AND ? ORDER BY recon_date DESC`,
    [sid, from, to]
  );
  res.json({ success: true, data: saved });
});

router.post('/bank-recon', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const { reconDate, cashDeposited, upiPhonepe, upiGpay, upiPaytm, upiOther, cardSettled, notes } = req.body;
  if (!reconDate) return res.status(400).json({ success: false, error: 'reconDate required.' });

  // Upsert — one entry per date per station
  await db.run(
    `INSERT INTO bank_reconciliation
       (station_id, recon_date, cash_deposited, upi_phonepe, upi_gpay, upi_paytm, upi_other, card_settled, notes, recorded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(station_id, recon_date) DO UPDATE SET
       cash_deposited=excluded.cash_deposited,
       upi_phonepe=excluded.upi_phonepe,
       upi_gpay=excluded.upi_gpay,
       upi_paytm=excluded.upi_paytm,
       upi_other=excluded.upi_other,
       card_settled=excluded.card_settled,
       notes=excluded.notes,
       recorded_by=excluded.recorded_by,
       updated_at=datetime('now')`,
    [sid, reconDate, cashDeposited||0, upiPhonepe||0, upiGpay||0, upiPaytm||0, upiOther||0, cardSettled||0, notes||null, req.user.id]
  );
  res.json({ success: true, message: 'Bank reconciliation saved.' });
});

router.get('/bank-recon/summary', async (req, res) => {
  const sid = req.user.stationId;
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const from = month + '-01';
  const [y,m] = month.split('-').map(Number);
  const to = new Date(y, m, 0).toISOString().slice(0,10);

  const [sysSales, bankEntries] = await Promise.all([
    // System: grouped by payment mode for the month
    db.all(
      `SELECT payment_mode, COUNT(*) as txns, ROUND(SUM(total_amount),2) as system_amount
       FROM sales WHERE station_id=? AND date(sale_time) BETWEEN ? AND ? AND is_cancelled=0
       GROUP BY payment_mode`,
      [sid, from, to]
    ),
    // Bank entries: aggregate for the month
    db.get(
      `SELECT
         ROUND(COALESCE(SUM(cash_deposited),0),2) as cash_deposited,
         ROUND(COALESCE(SUM(upi_phonepe),0),2) as upi_phonepe,
         ROUND(COALESCE(SUM(upi_gpay),0),2) as upi_gpay,
         ROUND(COALESCE(SUM(upi_paytm),0),2) as upi_paytm,
         ROUND(COALESCE(SUM(upi_other),0),2) as upi_other,
         ROUND(COALESCE(SUM(card_settled),0),2) as card_settled,
         COUNT(*) as days_entered
       FROM bank_reconciliation WHERE station_id=? AND recon_date BETWEEN ? AND ?`,
      [sid, from, to]
    )
  ]);

  // Compute system totals
  const sysMap = {};
  sysSales.forEach(r => { sysMap[r.payment_mode] = { txns: r.txns, amount: r.system_amount }; });
  const sysCash = (sysMap['cash']?.amount||0);
  const sysUPI  = ['upi','phonepe','gpay','paytm'].reduce((a,k) => a+(sysMap[k]?.amount||0), 0);
  const sysCard = (sysMap['card']?.amount||0);

  const bankUPI = +(
    (bankEntries?.upi_phonepe||0)+(bankEntries?.upi_gpay||0)+
    (bankEntries?.upi_paytm||0)+(bankEntries?.upi_other||0)
  ).toFixed(2);

  res.json({ success: true, data: {
    month, from, to,
    system: { cash: sysCash, upi: sysCash===0?0:sysCash, upiBreakdown: sysMap, card: sysCard, salesByMode: sysSales },
    bank: bankEntries || {},
    bankUPITotal: bankUPI,
    diff: {
      cash: +(((bankEntries?.cash_deposited||0) - sysCash)).toFixed(2),
      upi:  +(bankUPI - sysCash).toFixed(2),
      card: +(((bankEntries?.card_settled||0) - sysCard)).toFixed(2),
    }
  }});
});

// ═══════════════════════════════════════════════════════════════════════════
// SPRINT 7 — SHIFT CONFIGS (Multi-shift: Morning/Afternoon/Night)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/shift-configs', async (req, res) => {
  try {
    const data = await db.all(`SELECT * FROM shift_configs WHERE station_id=? AND is_active=1 ORDER BY sort_order,shift_name`, [req.user.stationId]);
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/shift-configs', authorize('owner'), async (req, res) => {
  try {
    const sid = req.user.stationId;
    const { shiftName, startTime, endTime, nozzleIds, sortOrder } = req.body;
    if (!shiftName) return res.status(400).json({ success: false, error: 'shiftName required.' });
    const r = await db.run(`INSERT OR REPLACE INTO shift_configs (station_id,shift_name,start_time,end_time,default_nozzle_ids,sort_order)
      VALUES (?,?,?,?,?,?)`,
      [sid, shiftName, startTime||'06:00', endTime||'14:00',
       JSON.stringify(nozzleIds||[]), sortOrder||0]);
    res.status(201).json({ success: true, id: r.lastInsertRowid, message: 'Shift config saved.' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/shift-configs/:id', authorize('owner'), async (req, res) => {
  try {
    const sid = req.user.stationId;
    const { shiftName, startTime, endTime, nozzleIds, sortOrder, isActive } = req.body;
    await db.run(`UPDATE shift_configs SET
        shift_name=COALESCE(?,shift_name), start_time=COALESCE(?,start_time),
        end_time=COALESCE(?,end_time), default_nozzle_ids=COALESCE(?,default_nozzle_ids),
        sort_order=COALESCE(?,sort_order), is_active=COALESCE(?,is_active)
        WHERE id=? AND station_id=?`,
      [shiftName||null, startTime||null, endTime||null,
       nozzleIds ? JSON.stringify(nozzleIds) : null,
       sortOrder!=null ? sortOrder : null,
       isActive!=null ? (isActive?1:0) : null,
       req.params.id, sid]);
    res.json({ success: true, message: 'Shift config updated.' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SPRINT 7 — PAYSLIP DATA (for PDF generation in frontend)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/payroll/:id/payslip', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const pr = await db.get(`
      SELECT p.*, e.full_name, e.emp_code, e.role, e.mobile, e.join_date,
        st.station_name, st.address as station_address, st.mobile as station_mobile
      FROM payroll_runs p
      JOIN employees e ON e.id=p.employee_id
      JOIN stations st ON st.id=p.station_id
      WHERE p.id=? AND p.station_id=?`, [req.params.id, sid]);
    if (!pr) return res.status(404).json({ success: false, error: 'Payroll record not found.' });

    const advances = await db.all(`SELECT * FROM salary_advances WHERE employee_id=? AND status='active' ORDER BY advance_date`, [pr.employee_id]);
    // attendance has work_date TEXT — filter by payroll period using strftime
    const monthStr = String(pr.payroll_month).padStart(2, '0');
    const periodYM = `${pr.payroll_year}-${monthStr}`;
    const attendance = await db.get(`SELECT
        COUNT(CASE WHEN status='present' THEN 1 END) as present,
        COUNT(CASE WHEN status='absent' THEN 1 END) as absent,
        COUNT(CASE WHEN status='half_day' THEN 1 END) as half_day,
        COUNT(CASE WHEN status='leave' THEN 1 END) as leave
      FROM attendance WHERE employee_id=? AND station_id=?
        AND strftime('%Y-%m', work_date)=?`,
      [pr.employee_id, sid, periodYM]).catch(() => null);

    res.json({ success: true, data: { payroll: pr, advances, attendance } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SPRINT 7 — OFFLINE SALE SYNC
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/offline-sync/sales — batch sync offline-queued sales
router.post('/offline-sync/sales', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const { sales } = req.body; // Array of { clientId, fuelType, quantity, rate, paymentMode, shiftId, ... }
    if (!Array.isArray(sales) || sales.length === 0) {
      return res.status(400).json({ success: false, error: 'sales array required.' });
    }

    const results = [];
    const station = await db.get('SELECT station_code FROM stations WHERE id=?', [sid]);

    for (const s of sales) {
      try {
        const { clientId, fuelType, quantity, rate, paymentMode, shiftId, vehicleNo, customerId, saleTime } = s;

        // Check for duplicate using offline_sale_queue (reliable idempotency by clientId)
        if (!clientId) { results.push({ clientId: null, status: 'failed', error: 'clientId required' }); continue; }
        const existing = await db.get(
          'SELECT status, synced_invoice_no FROM offline_sale_queue WHERE station_id=? AND client_id=?',
          [sid, clientId]).catch(() => null);
        if (existing) {
          results.push({ clientId, status: 'duplicate', invoiceNo: existing.synced_invoice_no });
          continue;
        }

        const qty = parseFloat(quantity), r = parseFloat(rate);
        if (!qty || !r || !fuelType || !shiftId) { results.push({ clientId, status: 'failed', error: 'Missing fields' }); continue; }

        const shift = await db.get('SELECT id,status FROM shifts WHERE id=? AND station_id=?', [shiftId, sid]);
        if (!shift) { results.push({ clientId, status: 'failed', error: 'Shift not found' }); continue; }

        const tank = await db.get('SELECT * FROM tanks WHERE station_id=? AND fuel_type=? AND is_active=1 LIMIT 1', [sid, fuelType]);
        if (!tank) { results.push({ clientId, status: 'failed', error: 'Tank not found' }); continue; }

        const amount  = Math.round(qty * r * 100) / 100;
        const invoiceNo = `${station.station_code}OFF${Date.now().toString().slice(-8)}`;

        await db.transaction(async t => {
          await t.run(`INSERT INTO sales (station_id,invoice_no,shift_id,tank_id,fuel_type,quantity,rate,amount,total_amount,payment_mode,vehicle_no,customer_id,served_by,sale_time)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [sid, invoiceNo, shiftId, tank.id, fuelType, qty, r, amount, amount,
             paymentMode||'cash', vehicleNo||null, customerId||null, req.user.id,
             saleTime || new Date().toISOString()]);
          await t.run(`UPDATE tanks SET current_stock=MAX(0,current_stock-?),updated_at=datetime('now') WHERE id=?`, [qty, tank.id]);
          // Record in queue for idempotency
          await t.run(
            `INSERT OR IGNORE INTO offline_sale_queue (station_id,client_id,payload,status,synced_invoice_no,synced_at) VALUES (?,?,?,?,?,datetime('now'))`,
            [sid, clientId, JSON.stringify(s), 'synced', invoiceNo]);
        });

        results.push({ clientId, status: 'synced', invoiceNo, amount });
      } catch(err) {
        results.push({ clientId: s.clientId, status: 'failed', error: err.message });
      }
    }

    const synced = results.filter(r => r.status === 'synced').length;
    const failed = results.filter(r => r.status === 'failed').length;
    res.json({ success: true, synced, failed, duplicate: results.filter(r=>r.status==='duplicate').length, results });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;

