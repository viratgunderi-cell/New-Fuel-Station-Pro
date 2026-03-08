'use strict';
/**
 * FuelBunk Pro — Advanced Reports Module
 * GET /api/reports2/nozzle-wise        — Nozzle-wise sales for a date range
 * GET /api/reports2/shift-comparison   — Shift-wise P&L comparison
 * GET /api/reports2/pl-per-litre       — Margin per litre analysis
 * GET /api/reports2/age-outstanding    — Age-wise outstanding (0-30/31-60/60+)
 * GET /api/reports2/cash-accuracy      — Short/excess cash history per shift
 * GET /api/reports2/month-comparison   — Month-on-month revenue comparison
 * GET /api/reports2/payment-daily      — Payment mode daily breakdown
 * GET /api/reports2/expiry-alerts      — Products expiring in next N days
 * GET /api/reports2/employee-performance — Per-employee performance
 * GET /api/reports2/credit-breach      — Credit limit breach history
 * GET /api/reports2/full-daily         — Complete daily report (all sections)
 */

const express = require('express');
const db      = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const fmt2 = v => Math.round((v || 0) * 100) / 100;

// ── Nozzle-wise Sales ─────────────────────────────────────────────────────
router.get('/nozzle-wise', async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const from = req.query.from || new Date().toISOString().slice(0, 10);
    const to   = req.query.to   || from;
    const data = await db.all(`
      SELECT n.nozzle_name, t.fuel_type, t.tank_name,
        COUNT(s.id) as txns,
        ROUND(SUM(s.quantity),2) as litres,
        ROUND(SUM(s.total_amount),2) as revenue,
        ROUND(AVG(s.quantity),2) as avg_fill,
        MIN(s.sale_time) as first_sale, MAX(s.sale_time) as last_sale
      FROM sales s
      LEFT JOIN nozzles n ON n.id = s.nozzle_id
      LEFT JOIN tanks t ON t.id = s.tank_id
      WHERE s.station_id=? AND date(s.sale_time) BETWEEN ? AND ? AND s.is_cancelled=0
      GROUP BY s.nozzle_id
      ORDER BY litres DESC`, [sid, from, to]);
    res.json({ success: true, data: { from, to, nozzles: data } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Shift Comparison ──────────────────────────────────────────────────────
router.get('/shift-comparison', async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const from = req.query.from || new Date().toISOString().slice(0, 10);
    const to   = req.query.to   || from;
    const shifts = await db.all(`
      SELECT sh.id, sh.shift_name, sh.open_time, sh.close_time, sh.status,
        sh.total_sales, sh.cash_collected, sh.upi_collected, sh.card_collected,
        sh.credit_sales, sh.cash_physical, sh.cash_variance,
        u1.full_name as opened_by, u2.full_name as closed_by,
        (SELECT COUNT(*) FROM sales WHERE shift_id=sh.id AND is_cancelled=0) as txns,
        (SELECT ROUND(SUM(quantity),2) FROM sales WHERE shift_id=sh.id AND is_cancelled=0) as litres
      FROM shifts sh
      LEFT JOIN users u1 ON u1.id=sh.opened_by
      LEFT JOIN users u2 ON u2.id=sh.closed_by
      WHERE sh.station_id=? AND date(sh.open_time) BETWEEN ? AND ?
      ORDER BY sh.open_time DESC`, [sid, from, to]);
    res.json({ success: true, data: { from, to, shifts } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── P&L per Litre ─────────────────────────────────────────────────────────
router.get('/pl-per-litre', async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);

    const [salesData, purchaseData, station] = await Promise.all([
      db.all(`SELECT fuel_type, ROUND(SUM(total_amount),2) as revenue,
                ROUND(SUM(quantity),2) as litres, ROUND(AVG(rate),4) as avg_sale_rate
              FROM sales WHERE station_id=? AND date(sale_time) BETWEEN ? AND ? AND is_cancelled=0
              GROUP BY fuel_type`, [sid, from, to]),
      db.all(`SELECT t.fuel_type, ROUND(SUM(pu.total_amount),2) as cost,
                ROUND(SUM(pu.quantity),2) as litres, ROUND(AVG(pu.rate),4) as avg_purchase_rate
              FROM purchases pu JOIN tanks t ON t.id=pu.tank_id
              WHERE pu.station_id=? AND pu.purchase_date BETWEEN ? AND ?
              GROUP BY t.fuel_type`, [sid, from, to]),
      db.get('SELECT ms_price, hsd_price, cng_price FROM stations WHERE id=?', [sid])
    ]);

    const result = salesData.map(s => {
      const pur = purchaseData.find(p => p.fuel_type === s.fuel_type) || { cost: 0, litres: 0, avg_purchase_rate: 0 };
      const grossMargin = fmt2(s.revenue - pur.cost);
      const marginPerL  = s.litres > 0 ? fmt2(grossMargin / s.litres) : 0;
      const marginPct   = s.revenue > 0 ? fmt2(grossMargin / s.revenue * 100) : 0;
      const currentPrice = s.fuel_type === 'MS' ? station.ms_price :
                           s.fuel_type === 'HSD' ? station.hsd_price : station.cng_price;
      return {
        fuelType: s.fuel_type, revenue: s.revenue, litres: s.litres,
        avgSaleRate: s.avg_sale_rate, currentPrice,
        purchaseCost: pur.cost, purchaseLitres: pur.litres, avgPurchaseRate: pur.avg_purchase_rate,
        grossMargin, marginPerLitre: marginPerL, marginPct
      };
    });

    const totals = {
      revenue: fmt2(result.reduce((s,r) => s+r.revenue, 0)),
      litres:  fmt2(result.reduce((s,r) => s+r.litres, 0)),
      cost:    fmt2(result.reduce((s,r) => s+r.purchaseCost, 0)),
      margin:  fmt2(result.reduce((s,r) => s+r.grossMargin, 0)),
    };
    totals.marginPerLitre = totals.litres > 0 ? fmt2(totals.margin / totals.litres) : 0;

    res.json({ success: true, data: { from, to, fuelwise: result, totals } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Age-wise Outstanding ──────────────────────────────────────────────────
router.get('/age-outstanding', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const customers = await db.all(`
      SELECT c.id, c.company_name, c.mobile, c.credit_limit, c.outstanding, c.billing_cycle,
        (SELECT MAX(payment_date) FROM credit_payments WHERE customer_id=c.id AND station_id=c.station_id) as last_payment,
        (SELECT MAX(sale_time) FROM sales WHERE customer_id=c.id AND station_id=c.station_id AND is_cancelled=0) as last_sale
      FROM credit_customers c WHERE c.station_id=? AND c.is_active=1 AND c.outstanding > 0
      ORDER BY c.outstanding DESC`, [sid]);

    const today = new Date();
    const buckets = { '0-30': [], '31-60': [], '61-90': [], '90+': [] };

    for (const c of customers) {
      const refDate = c.last_payment || c.last_sale;
      let days = refDate ? Math.floor((today - new Date(refDate)) / 86400000) : 999;
      const bucket = days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
      buckets[bucket].push({ ...c, daysOverdue: days });
    }

    const summary = Object.entries(buckets).map(([range, items]) => ({
      range, count: items.length,
      outstanding: fmt2(items.reduce((s, c) => s + c.outstanding, 0)),
      customers: items
    }));

    res.json({ success: true, data: { summary, total: fmt2(customers.reduce((s,c)=>s+c.outstanding,0)) } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Cash Accuracy (Short/Excess History) ─────────────────────────────────
router.get('/cash-accuracy', async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);

    const shifts = await db.all(`
      SELECT sh.shift_name, sh.open_time, sh.close_time,
        sh.cash_collected, sh.cash_physical, sh.cash_variance,
        u1.full_name as opened_by, u2.full_name as closed_by
      FROM shifts sh
      LEFT JOIN users u1 ON u1.id=sh.opened_by
      LEFT JOIN users u2 ON u2.id=sh.closed_by
      WHERE sh.station_id=? AND sh.status='closed'
        AND date(sh.open_time) BETWEEN ? AND ?
      ORDER BY sh.open_time DESC`, [sid, from, to]);

    const totalShifts  = shifts.length;
    const shortShifts  = shifts.filter(s => (s.cash_variance || 0) < -1).length;
    const excessShifts = shifts.filter(s => (s.cash_variance || 0) > 1).length;
    const totalShort   = fmt2(shifts.filter(s=>(s.cash_variance||0)<0).reduce((a,s)=>a+s.cash_variance,0));
    const totalExcess  = fmt2(shifts.filter(s=>(s.cash_variance||0)>0).reduce((a,s)=>a+s.cash_variance,0));

    res.json({ success: true, data: {
      from, to, shifts,
      summary: { totalShifts, shortShifts, excessShifts, totalShort, totalExcess,
                 accuracyRate: totalShifts > 0 ? fmt2((totalShifts-shortShifts-excessShifts)/totalShifts*100) : 100 }
    }});
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Month-on-Month Comparison ─────────────────────────────────────────────
router.get('/month-comparison', async (req, res) => {
  try {
    const sid    = req.user.stationId;
    const months = parseInt(req.query.months || 6);
    const data   = await db.all(`
      SELECT strftime('%Y-%m', sale_time) as month,
        ROUND(SUM(total_amount),2) as revenue,
        ROUND(SUM(quantity),2) as litres,
        COUNT(*) as txns,
        ROUND(SUM(CASE WHEN payment_mode='cash' THEN total_amount ELSE 0 END),2) as cash,
        ROUND(SUM(CASE WHEN payment_mode IN ('upi','phonepe','gpay','paytm') THEN total_amount ELSE 0 END),2) as upi,
        ROUND(SUM(CASE WHEN payment_mode='card' THEN total_amount ELSE 0 END),2) as card,
        ROUND(SUM(CASE WHEN payment_mode='credit' THEN total_amount ELSE 0 END),2) as credit
      FROM sales WHERE station_id=? AND is_cancelled=0
        AND sale_time >= date('now', '-' || ? || ' months')
      GROUP BY month ORDER BY month DESC LIMIT ?`, [sid, months, months]);

    // Add month-on-month growth %
    const result = data.map((m, i) => {
      const prev = data[i + 1];
      const growth = prev && prev.revenue > 0 ? fmt2((m.revenue - prev.revenue) / prev.revenue * 100) : null;
      return { ...m, revenueGrowthPct: growth };
    });

    res.json({ success: true, data: result });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Daily Payment Breakdown ───────────────────────────────────────────────
router.get('/payment-daily', async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const from = req.query.from || new Date().toISOString().slice(0,10);
    const to   = req.query.to   || from;
    const data = await db.all(`
      SELECT date(sale_time) as date, payment_mode,
        COUNT(*) as txns, ROUND(SUM(total_amount),2) as amount
      FROM sales WHERE station_id=? AND date(sale_time) BETWEEN ? AND ? AND is_cancelled=0
      GROUP BY date(sale_time), payment_mode ORDER BY date, payment_mode`, [sid, from, to]);

    // Pivot by date
    const dateMap = {};
    for (const row of data) {
      if (!dateMap[row.date]) dateMap[row.date] = { date: row.date, cash:0, upi:0, card:0, credit:0, total:0, txns:0 };
      const mode = ['phonepe','gpay','paytm','upi'].includes(row.payment_mode) ? 'upi' : row.payment_mode;
      dateMap[row.date][mode] = (dateMap[row.date][mode] || 0) + row.amount;
      dateMap[row.date].total += row.amount;
      dateMap[row.date].txns  += row.txns;
    }

    res.json({ success: true, data: Object.values(dateMap).sort((a,b) => a.date.localeCompare(b.date)) });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Expiry Alerts for Products ────────────────────────────────────────────
router.get('/expiry-alerts', async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const days = parseInt(req.query.days || 30);
    const data = await db.all(`
      SELECT id, product_name, category, hsn_code, stock_qty, unit, mrp, sale_price,
        expiry_date,
        CAST(julianday(expiry_date) - julianday('now') AS INTEGER) as days_to_expiry
      FROM products
      WHERE station_id=? AND is_active=1 AND expiry_date IS NOT NULL
        AND expiry_date <= date('now', '+' || ? || ' days')
      ORDER BY expiry_date ASC`, [sid, days]);

    const expired  = data.filter(p => p.days_to_expiry <= 0);
    const expiring = data.filter(p => p.days_to_expiry > 0);

    res.json({ success: true, data: { expired, expiring, total: data.length, days } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Employee Performance ──────────────────────────────────────────────────
router.get('/employee-performance', async (req, res) => {
  try {
    const sid   = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const data  = await db.all(`
      SELECT e.id, e.full_name, e.role, e.emp_code,
        (SELECT COUNT(*) FROM shifts sh WHERE sh.opened_by=u.id AND sh.station_id=e.station_id
           AND strftime('%Y-%m',sh.open_time)=?) as shifts_opened,
        (SELECT COUNT(*) FROM shifts sh WHERE sh.closed_by=u.id AND sh.station_id=e.station_id
           AND strftime('%Y-%m',sh.open_time)=?) as shifts_closed,
        (SELECT COUNT(*) FROM attendance a WHERE a.employee_id=e.id AND a.station_id=e.station_id
           AND strftime('%Y-%m',a.work_date)=? AND a.status='present') as days_present,
        (SELECT COUNT(*) FROM attendance a WHERE a.employee_id=e.id AND a.station_id=e.station_id
           AND strftime('%Y-%m',a.work_date)=? AND a.status='absent') as days_absent,
        (SELECT COUNT(*) FROM shifts sh WHERE sh.opened_by=u.id AND sh.cash_variance < -100
           AND sh.station_id=e.station_id AND strftime('%Y-%m',sh.open_time)=?) as short_shifts,
        u.id as user_id, u.username, u.last_login
      FROM employees e
      LEFT JOIN users u ON u.id=e.user_id
      WHERE e.station_id=? AND e.is_active=1
      ORDER BY e.role, e.full_name`, [month, month, month, month, month, sid]);

    res.json({ success: true, data: { month, employees: data } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Credit Limit Breach History ───────────────────────────────────────────
router.get('/credit-breach', async (req, res) => {
  try {
    const sid = req.user.stationId;
    const data = await db.all(`
      SELECT c.company_name, c.credit_limit, c.outstanding,
        ROUND(c.outstanding - c.credit_limit, 2) as excess_amount,
        ROUND((c.outstanding / c.credit_limit) * 100, 1) as utilization_pct,
        c.mobile,
        (SELECT MAX(sale_time) FROM sales WHERE customer_id=c.id AND is_cancelled=0) as last_sale
      FROM credit_customers c
      WHERE c.station_id=? AND c.outstanding > c.credit_limit AND c.credit_limit > 0
      ORDER BY excess_amount DESC`, [sid]);
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Full Daily Report (all sections combined) ─────────────────────────────
router.get('/full-daily', async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const [fuelWise, paymentWise, nozzleWise, shiftWise, hourly,
           stockMovement, productSales, creditSales, totals] = await Promise.all([
      db.all(`SELECT fuel_type,COUNT(*) as txns,ROUND(SUM(quantity),2) as qty,ROUND(SUM(total_amount),2) as amount,ROUND(AVG(rate),2) as avg_rate
              FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY fuel_type`, [sid,date]),
      db.all(`SELECT payment_mode,COUNT(*) as txns,ROUND(SUM(total_amount),2) as amount
              FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY payment_mode`, [sid,date]),
      db.all(`SELECT n.nozzle_name,s.fuel_type,COUNT(*) as txns,ROUND(SUM(s.quantity),2) as litres,ROUND(SUM(s.total_amount),2) as amount
              FROM sales s LEFT JOIN nozzles n ON n.id=s.nozzle_id
              WHERE s.station_id=? AND date(s.sale_time)=? AND s.is_cancelled=0 GROUP BY s.nozzle_id`, [sid,date]),
      db.all(`SELECT sh.shift_name,sh.open_time,sh.close_time,sh.total_sales,sh.cash_collected,sh.upi_collected,sh.cash_variance,u.full_name as opened_by
              FROM shifts sh LEFT JOIN users u ON u.id=sh.opened_by WHERE sh.station_id=? AND date(sh.open_time)=?`, [sid,date]),
      db.all(`SELECT strftime('%H',sale_time) as hr,COUNT(*) as txns,ROUND(SUM(total_amount),2) as amount
              FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY hr ORDER BY hr`, [sid,date]),
      db.all(`SELECT t.tank_name,t.fuel_type,t.current_stock,t.capacity,
                COALESCE((SELECT SUM(quantity) FROM sales WHERE tank_id=t.id AND date(sale_time)=? AND is_cancelled=0),0) as sold,
                COALESCE((SELECT SUM(quantity) FROM purchases WHERE tank_id=t.id AND purchase_date=?),0) as received
              FROM tanks t WHERE t.station_id=? AND t.is_active=1`, [date,date,sid]),
      db.all(`SELECT p.product_name,ps.quantity,ps.total_amount,ps.payment_mode
              FROM product_sales ps JOIN products p ON p.id=ps.product_id
              WHERE ps.station_id=? AND date(ps.sale_time)=? AND ps.is_cancelled=0`, [sid,date]),
      db.all(`SELECT c.company_name,s.invoice_no,s.fuel_type,s.quantity,s.total_amount
              FROM sales s JOIN credit_customers c ON c.id=s.customer_id
              WHERE s.station_id=? AND date(s.sale_time)=? AND s.is_cancelled=0`, [sid,date]),
      db.get(`SELECT COUNT(*) as txns, ROUND(SUM(total_amount),2) as revenue, ROUND(SUM(quantity),2) as litres
              FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid,date])
    ]);

    res.json({ success: true, data: {
      date, totals, fuelWise, paymentWise, nozzleWise, shiftWise,
      hourly, stockMovement, productSales, creditSales
    }});
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
