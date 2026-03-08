'use strict';
const express = require('express');
let triggerLowStockCheck;   try { triggerLowStockCheck   = require('./notifications').triggerLowStockCheck;   } catch(e) {}
let triggerCreditSaleBill;  try { triggerCreditSaleBill  = require('./notifications').triggerCreditSaleBill;  } catch(e) {}
const { body, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { heavyLimiter } = require('../middleware/security');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const sid = req.user.stationId;
  const { date, fuelType, paymentMode, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT s.*,u.full_name as served_by_name,c.company_name as customer_name FROM sales s LEFT JOIN users u ON u.id=s.served_by LEFT JOIN credit_customers c ON c.id=s.customer_id WHERE s.station_id=? AND s.is_cancelled=0';
  const params = [sid];
  if (date) { sql += ' AND date(s.sale_time)=?'; params.push(date); }
  if (fuelType) { sql += ' AND s.fuel_type=?'; params.push(fuelType); }
  if (paymentMode) { sql += ' AND s.payment_mode=?'; params.push(paymentMode); }
  sql += ' ORDER BY s.sale_time DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));
  const data = await db.all(sql, params);
  res.json({ success: true, data });
});

router.get('/summary', async (req, res) => {
  const sid = req.user.stationId;
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const [fuel, payment] = await Promise.all([
    db.all(`SELECT fuel_type, SUM(quantity) as qty, SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY fuel_type`, [sid, date]),
    db.all(`SELECT payment_mode, COUNT(*) as count, SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY payment_mode`, [sid, date])
  ]);
  res.json({ success: true, data: { fuelWise: fuel, paymentWise: payment, date } });
});

router.post('/', heavyLimiter,
  [body('fuelType').isIn(['MS','HSD','CNG']),
   body('quantity').isFloat({min:0.01}),
   body('rate').isFloat({min:0.01}),
   body('paymentMode').isIn(['cash','upi','phonepe','gpay','paytm','card','credit','neft','other']),
   body('nozzleId').optional().isInt({min:1}),
   body('shiftId').isInt({min:1}),
   body('vehicleNo').optional().trim().escape(),
   body('upiRef').optional().trim().escape()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const sid = req.user.stationId;
    const { fuelType, quantity, rate, paymentMode, nozzleId, shiftId, vehicleNo, upiRef, customerId } = req.body;

    // Verify shift belongs to this station
    const shift = await db.get('SELECT id,status FROM shifts WHERE id=? AND station_id=?', [shiftId, sid]);
    if (!shift || shift.status !== 'open') return res.status(400).json({ success: false, error: 'No open shift.' });

    // Check tank stock
    const tank = await db.get('SELECT t.* FROM tanks t WHERE t.station_id=? AND t.fuel_type=? AND t.is_active=1 LIMIT 1', [sid, fuelType]);
    if (!tank) return res.status(400).json({ success: false, error: 'Tank not found.' });
    if (tank.current_stock < quantity) return res.status(400).json({ success: false, error: `Insufficient stock. Available: ${tank.current_stock.toFixed(1)}L` });

    // Credit limit check
    if (paymentMode === 'credit' && customerId) {
      const cust = await db.get('SELECT credit_limit,outstanding FROM credit_customers WHERE id=? AND station_id=?', [customerId, sid]);
      if (cust && (cust.outstanding + quantity*rate) > cust.credit_limit) return res.status(400).json({ success: false, error: `Credit limit ₹${cust.credit_limit} exceeded.` });
    }

    const amount = +(quantity * rate).toFixed(2);
    const station = await db.get('SELECT station_code FROM stations WHERE id=?', [sid]);
    const invoiceNo = `${station.station_code}${Date.now().toString().slice(-8)}`;
    try {
      await db.transaction(async t => {
        await t.run(`INSERT INTO sales (station_id,invoice_no,shift_id,nozzle_id,tank_id,fuel_type,quantity,rate,amount,total_amount,payment_mode,upi_ref,customer_id,vehicle_no,served_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [sid, invoiceNo, shiftId, nozzleId||null, tank.id, fuelType, quantity, rate, amount, amount, paymentMode, upiRef||null, customerId||null, vehicleNo||null, req.user.id]);
        await t.run(`UPDATE tanks SET current_stock=current_stock-?,updated_at=datetime('now') WHERE id=?`, [quantity, tank.id]);
        if (paymentMode==='credit' && customerId) await t.run(`UPDATE credit_customers SET outstanding=outstanding+?,updated_at=datetime('now') WHERE id=?`, [amount, customerId]);
        const isUPI = ['upi','phonepe','gpay','paytm'].includes(paymentMode) || paymentMode.includes('pay') || paymentMode==='gpay';
        const shiftCol = paymentMode==='cash'?'cash_collected':isUPI?'upi_collected':paymentMode==='card'?'card_collected':paymentMode==='credit'?'credit_sales':null;
        if (shiftCol) {
          await t.run(`UPDATE shifts SET total_sales=total_sales+?,${shiftCol}=${shiftCol}+? WHERE id=?`, [amount, amount, shiftId]);
        } else {
          await t.run(`UPDATE shifts SET total_sales=total_sales+? WHERE id=?`, [amount, shiftId]);
        }
      });
      await db.logAudit(sid, req.user.id, req.user.username, 'SALE', 'sales', null, null, {invoiceNo, fuelType, quantity, amount, paymentMode}, req.ip, req.get('user-agent'));
      // Sprint 4: Check low stock after sale
      if (triggerLowStockCheck) triggerLowStockCheck(sid).catch(() => {});
      // Sprint 6: Send WhatsApp bill to credit customer
      if (paymentMode === 'credit' && customerId && triggerCreditSaleBill) {
        triggerCreditSaleBill(sid, { customerId, invoiceNo, fuelType, quantity, rate, amount }).catch(() => {});
      }
      res.status(201).json({ success: true, message: 'Sale recorded.', invoiceNo, amount });
    } catch(e) { console.error('[sales/post]', e.message); res.status(500).json({ success: false, error: 'Server error.' }); }
  }
);

router.put('/:id/cancel', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const sale = await db.get('SELECT * FROM sales WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!sale || sale.is_cancelled) return res.status(404).json({ success: false, error: 'Sale not found.' });
  await db.transaction(async t => {
    await t.run('UPDATE sales SET is_cancelled=1,cancel_reason=? WHERE id=?', [req.body.reason||'Cancelled', sale.id]);
    await t.run(`UPDATE tanks SET current_stock=current_stock+?,updated_at=datetime('now') WHERE id=?`, [sale.quantity, sale.tank_id]);
  });
  res.json({ success: true, message: 'Sale cancelled.' });
});

module.exports = router;
