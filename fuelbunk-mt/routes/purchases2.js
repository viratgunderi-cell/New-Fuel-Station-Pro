'use strict';
/**
 * FuelBunk Pro — Purchases & Suppliers Dedicated Module
 * Endpoints:
 *   GET  /api/purchases/list              — All purchases with filters
 *   GET  /api/purchases/suppliers         — Supplier master list
 *   POST /api/purchases/suppliers         — Add supplier
 *   PUT  /api/purchases/suppliers/:id     — Update supplier
 *   POST /api/purchases                   — Record fuel purchase / GRN
 *   PUT  /api/purchases/:id               — Edit purchase
 *   DELETE /api/purchases/:id             — Soft-delete purchase
 *   GET  /api/purchases/stats             — Purchase summary stats
 *   GET  /api/purchases/supplier/:id/ledger — Supplier payment ledger
 *   POST /api/purchases/supplier/:id/payment — Record payment to supplier
 *   GET  /api/purchases/pending-payments  — Outstanding supplier dues
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db      = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
let triggerLowStockCheck; try { triggerLowStockCheck = require('./notifications').triggerLowStockCheck; } catch(e) {}

const router = express.Router();
router.use(authenticate);

// ── GET /api/purchases2/list ──────────────────────────────────────────────
router.get('/list', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const { from, to, tankId, supplierId, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT pu.*, t.tank_name, t.fuel_type, s.name as supplier_name, s.gstin as supplier_gstin,
                u.full_name as received_by_name
               FROM purchases pu
               JOIN tanks t ON t.id=pu.tank_id
               LEFT JOIN suppliers s ON s.id=pu.supplier_id
               LEFT JOIN users u ON u.id=pu.received_by
               WHERE pu.station_id=?`;
    const params = [sid];
    if (from) { sql += ' AND pu.purchase_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND pu.purchase_date <= ?'; params.push(to); }
    if (tankId) { sql += ' AND pu.tank_id=?'; params.push(tankId); }
    if (supplierId) { sql += ' AND pu.supplier_id=?'; params.push(supplierId); }
    sql += ' ORDER BY pu.purchase_date DESC, pu.created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    const data = await db.all(sql, params);
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/purchases2/stats ─────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [monthStats, tankWise, recentSuppliers] = await Promise.all([
      db.get(`SELECT COUNT(*) as count, ROUND(SUM(quantity),2) as litres,
                ROUND(SUM(total_amount),2) as amount, ROUND(SUM(gst_amount),2) as gst
              FROM purchases WHERE station_id=? AND strftime('%Y-%m',purchase_date)=?`, [sid, month]),
      db.all(`SELECT t.fuel_type, t.tank_name, COUNT(*) as deliveries,
                ROUND(SUM(pu.quantity),2) as litres, ROUND(SUM(pu.total_amount),2) as amount
              FROM purchases pu JOIN tanks t ON t.id=pu.tank_id
              WHERE pu.station_id=? AND strftime('%Y-%m',pu.purchase_date)=?
              GROUP BY pu.tank_id`, [sid, month]),
      db.all(`SELECT s.name, s.gstin, COUNT(*) as deliveries,
                ROUND(SUM(pu.total_amount),2) as amount
              FROM purchases pu JOIN suppliers s ON s.id=pu.supplier_id
              WHERE pu.station_id=? AND strftime('%Y-%m',pu.purchase_date)=?
              GROUP BY pu.supplier_id ORDER BY amount DESC LIMIT 5`, [sid, month])
    ]);
    res.json({ success: true, data: { month, monthStats, tankWise, recentSuppliers } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/purchases2/suppliers ─────────────────────────────────────────
router.get('/suppliers', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const data = await db.all(`SELECT s.*,
        (SELECT COUNT(*) FROM purchases WHERE supplier_id=s.id AND station_id=s.station_id) as delivery_count,
        (SELECT ROUND(SUM(total_amount),2) FROM purchases WHERE supplier_id=s.id AND station_id=s.station_id) as total_purchased
      FROM suppliers s WHERE s.station_id=? AND s.is_active=1 ORDER BY s.name`, [sid]);
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /api/purchases2/suppliers ────────────────────────────────────────
router.post('/suppliers', authorize('owner', 'manager'), [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('gstin').optional().trim().isLength({ max: 15 }),
  body('mobile').optional().trim().isMobilePhone('en-IN')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const sid = req.user.stationId;
    const { name, gstin, mobile, address, email, bankName, accountNo, ifsc } = req.body;
    const r = await db.run(`INSERT INTO suppliers (station_id,name,gstin,mobile,address,email,bank_name,account_no,ifsc_code)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [sid, name, gstin||null, mobile||null, address||null, email||null, bankName||null, accountNo||null, ifsc||null]);
    await db.logAudit(sid, req.user.id, req.user.username, 'create', 'supplier', r.lastInsertRowid, null, { name }, req.ip, req.headers['user-agent']);
    res.status(201).json({ success: true, supplierId: r.lastInsertRowid, message: 'Supplier added.' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PUT /api/purchases2/suppliers/:id ─────────────────────────────────────
router.put('/suppliers/:id', authorize('owner', 'manager'), async (req, res) => {
  try {
    const sid = req.user.stationId;
    const sup = await db.get('SELECT id FROM suppliers WHERE id=? AND station_id=?', [req.params.id, sid]);
    if (!sup) return res.status(404).json({ success: false, error: 'Supplier not found.' });
    const { name, gstin, mobile, address, email, bankName, accountNo, ifsc } = req.body;
    await db.run(`UPDATE suppliers SET name=COALESCE(?,name), gstin=COALESCE(?,gstin),
        mobile=COALESCE(?,mobile), address=COALESCE(?,address), email=COALESCE(?,email),
        bank_name=COALESCE(?,bank_name), account_no=COALESCE(?,account_no), ifsc_code=COALESCE(?,ifsc_code)
        WHERE id=? AND station_id=?`,
      [name||null, gstin||null, mobile||null, address||null, email||null,
       bankName||null, accountNo||null, ifsc||null, req.params.id, sid]);
    res.json({ success: true, message: 'Supplier updated.' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /api/purchases2 — Record GRN / Fuel Delivery ────────────────────
router.post('/', authorize('owner', 'manager'), [
  body('tankId').isInt({ min: 1 }),
  body('quantity').isFloat({ min: 0.1 }),
  body('rate').isFloat({ min: 0.01 }),
  body('purchaseDate').isDate(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const sid = req.user.stationId;
    const { tankId, supplierId, invoiceNo, quantity, rate, gstRate, purchaseDate, density, notes } = req.body;

    const tank = await db.get('SELECT * FROM tanks WHERE id=? AND station_id=?', [tankId, sid]);
    if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });

    const qty    = parseFloat(quantity);
    const r      = parseFloat(rate);
    const gst    = parseFloat(gstRate || 0);
    const base   = Math.round(qty * r * 100) / 100;
    const gstAmt = Math.round(base * gst / 100 * 100) / 100;
    const total  = Math.round((base + gstAmt) * 100) / 100;

    await db.transaction(async t => {
      await t.run(`INSERT INTO purchases (station_id,tank_id,supplier_id,invoice_no,quantity,rate,amount,gst_rate,gst_amount,total_amount,purchase_date,density,received_by,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sid, tankId, supplierId||null, invoiceNo||null, qty, r, base, gst, gstAmt, total, purchaseDate, density||null, req.user.id, notes||null]);
      await t.run(`UPDATE tanks SET current_stock=current_stock+?,updated_at=datetime('now') WHERE id=?`, [qty, tankId]);
    });

    await db.logAudit(sid, req.user.id, req.user.username, 'PURCHASE', 'purchases', null, null,
      { tankId, invoiceNo, qty, rate: r, total }, req.ip, req.headers['user-agent']);

    if (triggerLowStockCheck) triggerLowStockCheck(sid).catch(() => {});

    const updatedTank = await db.get('SELECT current_stock FROM tanks WHERE id=?', [tankId]);
    res.status(201).json({ success: true, message: 'Purchase recorded.', newStock: updatedTank.current_stock, total });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── DELETE /api/purchases2/:id — Soft-cancel purchase ────────────────────
router.delete('/:id', authorize('owner'), async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const pur  = await db.get('SELECT * FROM purchases WHERE id=? AND station_id=?', [req.params.id, sid]);
    if (!pur) return res.status(404).json({ success: false, error: 'Purchase not found.' });
    // Reverse stock
    await db.transaction(async t => {
      await t.run('UPDATE purchases SET notes=? WHERE id=?', ['[CANCELLED] ' + (pur.notes||''), pur.id]);
      await t.run(`UPDATE tanks SET current_stock=MAX(0,current_stock-?),updated_at=datetime('now') WHERE id=?`, [pur.quantity, pur.tank_id]);
    });
    res.json({ success: true, message: 'Purchase reversed.' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/purchases2/pending-payments — Unpaid supplier dues ───────────
router.get('/pending-payments', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const data = await db.all(`
      SELECT s.id as supplier_id, s.name, s.mobile, s.gstin,
        COUNT(pu.id) as invoices,
        ROUND(SUM(pu.total_amount),2) as total_purchased,
        ROUND(COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp
                        WHERE sp.supplier_id=s.id AND sp.station_id=pu.station_id),0),2) as total_paid,
        ROUND(SUM(pu.total_amount) - COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp
                        WHERE sp.supplier_id=s.id AND sp.station_id=pu.station_id),0),2) as total_due,
        MAX(pu.purchase_date) as last_delivery
      FROM purchases pu JOIN suppliers s ON s.id=pu.supplier_id
      WHERE pu.station_id=?
      GROUP BY pu.supplier_id
      HAVING total_due > 0
      ORDER BY total_due DESC`, [sid]);
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/purchases2/supplier/:id/ledger ───────────────────────────────
router.get('/supplier/:id/ledger', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const supplier = await db.get('SELECT * FROM suppliers WHERE id=? AND station_id=?', [req.params.id, sid]);
    if (!supplier) return res.status(404).json({ success: false, error: 'Supplier not found.' });

    const [purchases, payments] = await Promise.all([
      db.all(`SELECT pu.*, t.fuel_type, t.tank_name FROM purchases pu JOIN tanks t ON t.id=pu.tank_id
              WHERE pu.supplier_id=? AND pu.station_id=? ORDER BY pu.purchase_date`, [req.params.id, sid]),
      db.all(`SELECT * FROM supplier_payments WHERE supplier_id=? AND station_id=? ORDER BY payment_date`, [req.params.id, sid]).catch(() => [])
    ]);

    const totalPurchased = purchases.reduce((s, r) => s + (r.total_amount || 0), 0);
    const totalPaid = payments.reduce((s, r) => s + (r.amount || 0), 0);
    const outstanding = Math.round((totalPurchased - totalPaid) * 100) / 100;

    res.json({ success: true, data: { supplier, purchases, payments, totalPurchased, totalPaid, outstanding } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /api/purchases2/supplier/:id/payment ─────────────────────────────
router.post('/supplier/:id/payment', authorize('owner', 'manager'), [
  body('amount').isFloat({ min: 0.01 }),
  body('paymentMode').isIn(['cash', 'neft', 'rtgs', 'upi', 'cheque', 'other']),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const sid = req.user.stationId;
    const supplier = await db.get('SELECT id FROM suppliers WHERE id=? AND station_id=?', [req.params.id, sid]);
    if (!supplier) return res.status(404).json({ success: false, error: 'Supplier not found.' });
    const { amount, paymentMode, referenceNo, paymentDate, notes } = req.body;

    // Ensure supplier_payments table exists
    await db.run(`CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
      amount REAL NOT NULL, payment_mode TEXT NOT NULL,
      reference_no TEXT, payment_date TEXT NOT NULL DEFAULT (date('now')),
      notes TEXT, recorded_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).catch(() => {});

    const r = await db.run(`INSERT INTO supplier_payments (station_id,supplier_id,amount,payment_mode,reference_no,payment_date,notes,recorded_by)
      VALUES (?,?,?,?,?,?,?,?)`,
      [sid, req.params.id, parseFloat(amount), paymentMode, referenceNo||null,
       paymentDate || new Date().toISOString().slice(0,10), notes||null, req.user.id]);

    await db.logAudit(sid, req.user.id, req.user.username, 'SUPPLIER_PAYMENT', 'supplier_payments', r.lastInsertRowid,
      null, { supplierId: req.params.id, amount, paymentMode }, req.ip, req.headers['user-agent']);

    res.status(201).json({ success: true, message: 'Payment recorded.' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
