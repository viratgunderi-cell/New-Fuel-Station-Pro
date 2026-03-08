'use strict';
/**
 * FuelBunk Pro — GST & Accounting Module
 * Endpoints:
 *   GET  /api/gst/summary          — Monthly GST summary (CGST/SGST/IGST totals)
 *   GET  /api/gst/gstr1            — GSTR-1 data (B2B / B2C breakup) JSON
 *   GET  /api/gst/gstr3b           — GSTR-3B summary JSON
 *   GET  /api/gst/gstr1/export     — GSTR-1 CSV download (ready for GST portal)
 *   GET  /api/gst/tally/export     — Tally XML export for the month
 *   GET  /api/gst/irn/register     — E-Invoice IRN mock register
 *   POST /api/gst/irn/generate     — Generate (stub) IRN for a sale
 *   GET  /api/gst/daybook          — Day Book / Cash Book entries for date range
 *   GET  /api/gst/pl               — Profit & Loss for a month
 */

const express = require('express');
const db      = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── helpers ──────────────────────────────────────────────────────────────
const fmt2 = v => Math.round((v || 0) * 100) / 100;

// Indian GST rates for petrol station products
const GST_RATES = { MS: 0, HSD: 0, CNG: 0, lubricant: 18, accessory: 18, other: 18 };

function calcGST(amount, rate) {
  const gstAmt = fmt2(amount * rate / (100 + rate));
  const base   = fmt2(amount - gstAmt);
  return { base, gstAmt, cgst: fmt2(gstAmt / 2), sgst: fmt2(gstAmt / 2) };
}

// ── GET /api/gst/summary?month=YYYY-MM ────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const sid  = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-');

    const [station, fuelSales, productSales, purchases] = await Promise.all([
      db.get('SELECT * FROM stations WHERE id=?', [sid]),
      db.all(`SELECT fuel_type, SUM(total_amount) as amount, COUNT(*) as txns,
                SUM(quantity) as litres
              FROM sales WHERE station_id=? AND strftime('%Y-%m',sale_time)=?
              AND is_cancelled=0 GROUP BY fuel_type`, [sid, month]),
      db.all(`SELECT p.category, p.gst_rate,
                SUM(ps.total_amount) as amount, SUM(ps.gst_amount) as gst_amount,
                COUNT(*) as txns
              FROM product_sales ps JOIN products p ON p.id=ps.product_id
              WHERE ps.station_id=? AND strftime('%Y-%m',ps.sale_time)=?
              AND ps.is_cancelled=0 GROUP BY p.category, p.gst_rate`, [sid, month]),
      db.all(`SELECT pu.*, t.fuel_type, s.name as supplier_name, s.gstin as supplier_gstin
              FROM purchases pu JOIN tanks t ON t.id=pu.tank_id
              LEFT JOIN suppliers s ON s.id=pu.supplier_id
              WHERE pu.station_id=? AND strftime('%Y-%m',pu.purchase_date)=?
              ORDER BY pu.purchase_date`, [sid, month])
    ]);

    // Fuel sales — petroleum products are exempt from GST (0% on fuel itself)
    const fuelTotal    = fuelSales.reduce((s, r) => s + (r.amount || 0), 0);
    const fuelExempt   = fmt2(fuelTotal);

    // Product (lubes) GST computation
    let outwardGST = 0, cgstOut = 0, sgstOut = 0;
    for (const ps of productSales) {
      const rate = ps.gst_rate || 18;
      const g = calcGST(ps.amount, rate);
      cgstOut  += g.cgst;
      sgstOut  += g.sgst;
      outwardGST += g.gstAmt;
    }
    outwardGST = fmt2(outwardGST);
    cgstOut    = fmt2(cgstOut);
    sgstOut    = fmt2(sgstOut);

    // Input credit from purchases
    let inwardGST = 0, cgstIn = 0, sgstIn = 0;
    for (const p of purchases) {
      inwardGST += p.gst_amount || 0;
      cgstIn    += fmt2((p.gst_amount || 0) / 2);
      sgstIn    += fmt2((p.gst_amount || 0) / 2);
    }
    inwardGST = fmt2(inwardGST);
    cgstIn    = fmt2(cgstIn);
    sgstIn    = fmt2(sgstIn);

    const netTaxPayable = fmt2(Math.max(0, outwardGST - inwardGST));

    res.json({
      success: true, data: {
        month, station,
        outward: { exempt: fuelExempt, taxable: productSales.reduce((s,r)=>s+(r.amount||0),0), gst: outwardGST, cgst: cgstOut, sgst: sgstOut },
        inward:  { purchases: purchases.reduce((s,r)=>s+(r.total_amount||0),0), itc: inwardGST, cgst: cgstIn, sgst: sgstIn },
        netTaxPayable,
        fuelSales, productSales, purchases
      }
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/gst/gstr1?month=YYYY-MM ─────────────────────────────────────
router.get('/gstr1', async (req, res) => {
  try {
    const sid   = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const station = await db.get('SELECT * FROM stations WHERE id=?', [sid]);

    // B2C (retail / cash / UPI sales) — group by fuel/product
    const b2c = await db.all(`
      SELECT 'fuel' as type, fuel_type as item, payment_mode,
        COUNT(*) as txns, ROUND(SUM(quantity),2) as qty,
        ROUND(SUM(total_amount),2) as amount,
        ROUND(SUM(gst_amount),2) as gst_amount
      FROM sales WHERE station_id=? AND strftime('%Y-%m',sale_time)=?
        AND is_cancelled=0 AND (customer_id IS NULL OR payment_mode != 'credit')
      GROUP BY fuel_type, payment_mode
      ORDER BY fuel_type, payment_mode`, [sid, month]);

    // B2B (credit/fleet sales to GST-registered customers)
    const b2b = await db.all(`
      SELECT s.invoice_no, s.sale_time, s.fuel_type, s.quantity,
        s.total_amount, s.gst_amount, s.payment_mode,
        c.company_name, c.gstin as customer_gstin, c.billing_cycle
      FROM sales s
      JOIN credit_customers c ON c.id = s.customer_id
      WHERE s.station_id=? AND strftime('%Y-%m',s.sale_time)=?
        AND s.is_cancelled=0 AND c.gstin IS NOT NULL AND c.gstin != ''
      ORDER BY s.sale_time`, [sid, month]);

    // Product sales (taxable)
    const products = await db.all(`
      SELECT ps.invoice_no, ps.sale_time, ps.total_amount,
        ps.gst_rate, ps.gst_amount, ps.quantity,
        p.product_name, p.hsn_code, p.category, p.gst_rate as gst_pct
      FROM product_sales ps JOIN products p ON p.id=ps.product_id
      WHERE ps.station_id=? AND strftime('%Y-%m',ps.sale_time)=?
        AND ps.is_cancelled=0 ORDER BY ps.sale_time`, [sid, month]);

    // HSN-wise summary
    const hsnSummary = await db.all(`
      SELECT p.hsn_code, p.gst_rate,
        ROUND(SUM(ps.total_amount),2) as amount,
        ROUND(SUM(ps.gst_amount),2) as gst_amount,
        COUNT(*) as txns
      FROM product_sales ps JOIN products p ON p.id=ps.product_id
      WHERE ps.station_id=? AND strftime('%Y-%m',ps.sale_time)=?
        AND ps.is_cancelled=0 AND p.hsn_code IS NOT NULL
      GROUP BY p.hsn_code, p.gst_rate`, [sid, month]);

    res.json({ success: true, data: { month, station, b2c, b2b, products, hsnSummary } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/gst/gstr3b?month=YYYY-MM ────────────────────────────────────
router.get('/gstr3b', async (req, res) => {
  try {
    const sid   = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const station = await db.get('SELECT * FROM stations WHERE id=?', [sid]);

    const [outwardFuel, outwardProducts, inwardPurchases] = await Promise.all([
      db.get(`SELECT ROUND(SUM(total_amount),2) as amount FROM sales
              WHERE station_id=? AND strftime('%Y-%m',sale_time)=? AND is_cancelled=0`, [sid, month]),
      db.get(`SELECT ROUND(SUM(total_amount),2) as amount, ROUND(SUM(gst_amount),2) as gst
              FROM product_sales WHERE station_id=? AND strftime('%Y-%m',sale_time)=? AND is_cancelled=0`, [sid, month]),
      db.get(`SELECT ROUND(SUM(total_amount),2) as amount, ROUND(SUM(gst_amount),2) as itc
              FROM purchases WHERE station_id=? AND strftime('%Y-%m',purchase_date)=?`, [sid, month])
    ]);

    const taxableSupplies = outwardProducts.amount || 0;
    const taxGst  = outwardProducts.gst || 0;
    const itc     = inwardPurchases.itc  || 0;
    const cgst    = fmt2(taxGst / 2);
    const sgst    = fmt2(taxGst / 2);
    const cgstItc = fmt2(itc / 2);
    const sgstItc = fmt2(itc / 2);

    res.json({
      success: true, data: {
        month, station,
        table31: { // Outward supplies
          exemptFuelSales:   outwardFuel.amount || 0,
          taxableProductSales: taxableSupplies,
          totalOutward: fmt2((outwardFuel.amount || 0) + taxableSupplies),
          totalTax: taxGst, cgst, sgst
        },
        table4: { // ITC available
          itcTotal: itc, cgstItc, sgstItc
        },
        netPayable: { cgst: fmt2(cgst - cgstItc), sgst: fmt2(sgst - sgstItc), total: fmt2(taxGst - itc) }
      }
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/gst/gstr1/export?month=YYYY-MM  — CSV download ──────────────
router.get('/gstr1/export', async (req, res) => {
  try {
    const sid   = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const station = await db.get('SELECT * FROM stations WHERE id=?', [sid]);

    const rows = await db.all(`
      SELECT s.invoice_no, s.sale_time, s.fuel_type, s.quantity, s.rate,
        s.total_amount, s.gst_rate, s.gst_amount, s.payment_mode,
        c.company_name, c.gstin as cust_gstin
      FROM sales s LEFT JOIN credit_customers c ON c.id=s.customer_id
      WHERE s.station_id=? AND strftime('%Y-%m',s.sale_time)=? AND s.is_cancelled=0
      ORDER BY s.sale_time`, [sid, month]);

    const prodRows = await db.all(`
      SELECT ps.invoice_no, ps.sale_time, p.product_name, p.hsn_code,
        ps.quantity, ps.rate, ps.total_amount, ps.gst_rate, ps.gst_amount, ps.payment_mode
      FROM product_sales ps JOIN products p ON p.id=ps.product_id
      WHERE ps.station_id=? AND strftime('%Y-%m',ps.sale_time)=? AND ps.is_cancelled=0
      ORDER BY ps.sale_time`, [sid, month]);

    let csv = `GSTIN,${station.gstin || 'NOT SET'},Station,${station.station_name},Month,${month}\n\n`;
    csv += `SECTION B2C — FUEL SALES (EXEMPT)\n`;
    csv += `Invoice No,Date,Fuel Type,Quantity (L),Rate,Amount (₹),GST Rate (%),GST Amount,Payment Mode,Customer\n`;
    for (const r of rows) {
      const cust = r.company_name || 'Retail';
      csv += `${r.invoice_no},${r.sale_time?.slice(0,10)},${r.fuel_type},${r.quantity},${r.rate},${r.total_amount},${r.gst_rate||0},${r.gst_amount||0},${r.payment_mode},${cust}\n`;
    }
    csv += `\nSECTION B2C — PRODUCT SALES (TAXABLE)\n`;
    csv += `Invoice No,Date,Product,HSN Code,Quantity,Rate,Amount (₹),GST Rate (%),GST Amount,Payment Mode\n`;
    for (const r of prodRows) {
      csv += `${r.invoice_no},${r.sale_time?.slice(0,10)},"${r.product_name}",${r.hsn_code||''},${r.quantity},${r.rate},${r.total_amount},${r.gst_rate||18},${r.gst_amount||0},${r.payment_mode}\n`;
    }

    const filename = `GSTR1_${station.station_code}_${month}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/gst/tally/export?month=YYYY-MM — Tally XML ──────────────────
router.get('/tally/export', authorize('owner', 'manager'), async (req, res) => {
  try {
    const sid   = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const station = await db.get('SELECT * FROM stations WHERE id=?', [sid]);

    const sales = await db.all(`
      SELECT s.invoice_no, s.sale_time, s.fuel_type, s.quantity, s.rate,
        s.total_amount, s.gst_amount, s.payment_mode, s.vehicle_no,
        c.company_name
      FROM sales s LEFT JOIN credit_customers c ON c.id=s.customer_id
      WHERE s.station_id=? AND strftime('%Y-%m',s.sale_time)=? AND s.is_cancelled=0
      ORDER BY s.sale_time LIMIT 5000`, [sid, month]);

    const purchases = await db.all(`
      SELECT pu.invoice_no, pu.purchase_date, t.fuel_type, pu.quantity,
        pu.rate, pu.total_amount, pu.gst_amount, s.name as supplier_name
      FROM purchases pu JOIN tanks t ON t.id=pu.tank_id
      LEFT JOIN suppliers s ON s.id=pu.supplier_id
      WHERE pu.station_id=? AND strftime('%Y-%m',pu.purchase_date)=?`, [sid, month]);

    // Build Tally XML (TallyPrime compatible)
    const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const tallyDate = d => (d||'').replace(/-/g,'');

    let vouchers = '';

    // Sales vouchers
    for (const s of sales) {
      const ledger = s.payment_mode === 'cash' ? 'Cash' :
                     ['upi','phonepe','gpay','paytm'].includes(s.payment_mode) ? 'UPI Collection' :
                     s.payment_mode === 'card' ? 'Card POS' :
                     s.company_name ? esc(s.company_name) : 'Sundry Debtors';
      const fuelLedger = s.fuel_type === 'MS' ? 'MS Sales' : s.fuel_type === 'HSD' ? 'HSD Sales' : 'CNG Sales';
      vouchers += `
  <VOUCHER>
    <DATE>${tallyDate(s.sale_time?.slice(0,10))}</DATE>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>${esc(s.invoice_no)}</VOUCHERNUMBER>
    <NARRATION>${esc(s.fuel_type)} ${s.quantity}L${s.vehicle_no?' | '+esc(s.vehicle_no):''}</NARRATION>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${esc(ledger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${s.total_amount.toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${esc(fuelLedger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>${s.total_amount.toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
  </VOUCHER>`;
    }

    // Purchase vouchers
    for (const p of purchases) {
      const supplier = esc(p.supplier_name || 'Fuel Supplier');
      const fuelLedger = p.fuel_type === 'MS' ? 'MS Purchase' : p.fuel_type === 'HSD' ? 'HSD Purchase' : 'CNG Purchase';
      vouchers += `
  <VOUCHER>
    <DATE>${tallyDate(p.purchase_date)}</DATE>
    <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
    <VOUCHERNUMBER>${esc(p.invoice_no || 'PUR-'+p.purchase_date)}</VOUCHERNUMBER>
    <NARRATION>${esc(p.fuel_type)} ${p.quantity}L from ${supplier}</NARRATION>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${fuelLedger}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${(p.total_amount - (p.gst_amount||0)).toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    ${p.gst_amount > 0 ? `<ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Input CGST</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${(p.gst_amount/2).toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Input SGST</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${(p.gst_amount/2).toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>` : ''}
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${supplier}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>${p.total_amount.toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
  </VOUCHER>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(station.station_name)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">${vouchers}
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const filename = `Tally_${station.station_code}_${month}.xml`;
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/gst/irn/register?month=YYYY-MM  — E-Invoice log ─────────────
router.get('/irn/register', async (req, res) => {
  try {
    const sid   = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    // B2B sales ≥ ₹5L with GST registered customers are e-invoice eligible
    const rows = await db.all(`
      SELECT s.invoice_no, s.sale_time, s.fuel_type, s.quantity, s.total_amount,
        s.gst_amount, c.company_name, c.gstin,
        CASE WHEN s.total_amount >= 500000 THEN 'E-Invoice Required' ELSE 'Exempt' END as irn_status,
        CASE WHEN s.total_amount >= 500000 THEN 'IRN-' || s.invoice_no ELSE NULL END as irn_no
      FROM sales s JOIN credit_customers c ON c.id=s.customer_id
      WHERE s.station_id=? AND strftime('%Y-%m',s.sale_time)=?
        AND s.is_cancelled=0 AND c.gstin IS NOT NULL AND c.gstin != ''
      ORDER BY s.sale_time DESC`, [sid, month]);
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /api/gst/irn/generate — Generate stub IRN for a B2B invoice ──────
router.post('/irn/generate', authorize('owner', 'manager'), async (req, res) => {
  try {
    const sid = req.user.stationId;
    const { invoiceNo } = req.body;
    if (!invoiceNo) return res.status(400).json({ success: false, error: 'invoiceNo required.' });
    const sale = await db.get(`
      SELECT s.*, c.company_name, c.gstin as cust_gstin, st.gstin as station_gstin, st.station_name
      FROM sales s JOIN credit_customers c ON c.id=s.customer_id
      JOIN stations st ON st.id=s.station_id
      WHERE s.invoice_no=? AND s.station_id=? AND s.is_cancelled=0`, [invoiceNo, sid]);
    if (!sale) return res.status(404).json({ success: false, error: 'Sale not found or not a B2B invoice.' });
    if (!sale.cust_gstin) return res.status(400).json({ success: false, error: 'Customer GSTIN not set. Cannot generate IRN.' });
    if (!sale.station_gstin) return res.status(400).json({ success: false, error: 'Station GSTIN not set in Settings. Please update first.' });
    // In production, this would call NIC IRP API. Here we generate a deterministic stub.
    const irnData = `${sale.station_gstin}${invoiceNo}${sale.sale_time?.slice(0,10)}`;
    const irn = 'IRN' + Buffer.from(irnData).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0, 60);
    const qrPayload = {
      SellerGSTIN: sale.station_gstin,
      BuyerGSTIN: sale.cust_gstin,
      DocNo: invoiceNo,
      DocDate: sale.sale_time?.slice(0,10),
      TotInvVal: sale.total_amount,
      ItemCnt: 1,
      IRN: irn
    };
    res.json({ success: true, data: {
      irn, invoiceNo, saleId: sale.id,
      sellerGSTIN: sale.station_gstin,
      buyerGSTIN: sale.cust_gstin,
      buyerName: sale.company_name,
      totalAmount: sale.total_amount,
      qrPayload: JSON.stringify(qrPayload),
      note: 'Stub IRN — Connect NIC/ClearTax API for production e-Invoice generation.'
    }});
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/gst/daybook?from=YYYY-MM-DD&to=YYYY-MM-DD ───────────────────
router.get('/daybook', async (req, res) => {
  try {
    const sid   = req.user.stationId;
    const from  = req.query.from || new Date().toISOString().slice(0,10);
    const to    = req.query.to   || from;

    const [sales, purchases, creditPayments, payroll] = await Promise.all([
      db.all(`SELECT date(sale_time) as date, payment_mode,
                ROUND(SUM(total_amount),2) as amount, COUNT(*) as txns
              FROM sales WHERE station_id=? AND date(sale_time) BETWEEN ? AND ?
              AND is_cancelled=0 GROUP BY date(sale_time), payment_mode ORDER BY date`, [sid, from, to]),
      db.all(`SELECT purchase_date as date, supplier_id,
                ROUND(SUM(total_amount),2) as amount, COUNT(*) as txns
              FROM purchases WHERE station_id=? AND purchase_date BETWEEN ? AND ?
              GROUP BY purchase_date ORDER BY purchase_date`, [sid, from, to]),
      db.all(`SELECT payment_date as date, payment_mode,
                ROUND(SUM(amount),2) as amount, COUNT(*) as txns
              FROM credit_payments WHERE station_id=? AND payment_date BETWEEN ? AND ?
              GROUP BY payment_date, payment_mode ORDER BY payment_date`, [sid, from, to]),
      db.all(`SELECT p.payment_date as date, ROUND(SUM(p.net_salary),2) as amount, COUNT(*) as count
              FROM payroll_runs p WHERE p.station_id=? AND p.payment_date BETWEEN ? AND ?
              AND p.status='paid' GROUP BY p.payment_date ORDER BY p.payment_date`, [sid, from, to])
    ]);

    // Build day-book grouped by date
    const dayMap = {};
    const addEntry = (date, dr, cr, narration, type) => {
      if (!dayMap[date]) dayMap[date] = { date, entries: [], drTotal: 0, crTotal: 0 };
      dayMap[date].entries.push({ narration, type, dr: fmt2(dr), cr: fmt2(cr) });
      dayMap[date].drTotal = fmt2(dayMap[date].drTotal + dr);
      dayMap[date].crTotal = fmt2(dayMap[date].crTotal + cr);
    };

    for (const s of sales) {
      const acct = s.payment_mode === 'cash' ? 'Cash A/c' :
                   ['upi','phonepe','gpay','paytm'].includes(s.payment_mode) ? 'UPI Collection A/c' :
                   s.payment_mode === 'card' ? 'Card POS A/c' :
                   s.payment_mode === 'credit' ? 'Debtors A/c' : 'Other Income';
      addEntry(s.date, s.amount, 0, `${acct} — ${s.txns} sales (${s.payment_mode})`, 'sale');
      addEntry(s.date, 0, s.amount, 'Fuel Sales A/c', 'sale');
    }
    for (const p of purchases) {
      addEntry(p.date, p.amount, 0, 'Fuel Purchase A/c', 'purchase');
      addEntry(p.date, 0, p.amount, 'Supplier / Creditors A/c', 'purchase');
    }
    for (const cp of creditPayments) {
      addEntry(cp.date, cp.amount, 0, `Cash/Bank (credit receipt — ${cp.payment_mode})`, 'receipt');
      addEntry(cp.date, 0, cp.amount, 'Debtors A/c — Credit Receipt', 'receipt');
    }
    for (const pr of payroll) {
      addEntry(pr.date, 0, pr.amount, `Salary Expense — ${pr.count} employees`, 'expense');
      addEntry(pr.date, pr.amount, 0, 'Cash/Bank — Salary Paid', 'expense');
    }

    const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
    res.json({ success: true, data: { from, to, days } });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/gst/pl?month=YYYY-MM — P&L Summary ──────────────────────────
router.get('/pl', async (req, res) => {
  try {
    const sid   = req.user.stationId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const station = await db.get('SELECT * FROM stations WHERE id=?', [sid]);

    const [fuelSales, productSales, fuelPurchases, productPurchases, payroll] = await Promise.all([
      db.get(`SELECT ROUND(SUM(total_amount),2) as revenue, ROUND(SUM(quantity),2) as litres
              FROM sales WHERE station_id=? AND strftime('%Y-%m',sale_time)=? AND is_cancelled=0`, [sid, month]),
      db.get(`SELECT ROUND(SUM(total_amount),2) as revenue FROM product_sales
              WHERE station_id=? AND strftime('%Y-%m',sale_time)=? AND is_cancelled=0`, [sid, month]),
      db.get(`SELECT ROUND(SUM(total_amount),2) as cost FROM purchases
              WHERE station_id=? AND strftime('%Y-%m',purchase_date)=?`, [sid, month]),
      db.get(`SELECT ROUND(SUM(quantity * rate),2) as cost FROM product_stock_in
              WHERE station_id=? AND strftime('%Y-%m',stock_date)=?`, [sid, month]),
      db.get(`SELECT ROUND(SUM(net_salary),2) as amount FROM payroll_runs
              WHERE station_id=? AND payroll_year=? AND payroll_month=? AND status IN ('approved','paid')`,
              [sid, ...month.split('-').map(Number)])
    ]);

    const fuelRev    = fuelSales.revenue    || 0;
    const prodRev    = productSales.revenue || 0;
    const totalRev   = fmt2(fuelRev + prodRev);
    const fuelCOGS   = fuelPurchases.cost   || 0;
    const prodCOGS   = productPurchases.cost|| 0;
    const totalCOGS  = fmt2(fuelCOGS + prodCOGS);
    const grossProfit= fmt2(totalRev - totalCOGS);
    const salaryExp  = payroll.amount || 0;
    const netProfit  = fmt2(grossProfit - salaryExp);
    const litres     = fuelSales.litres || 0;
    const marginPerL = litres > 0 ? fmt2(grossProfit / litres) : 0;

    res.json({ success: true, data: {
      month, station,
      revenue: { fuel: fuelRev, products: prodRev, total: totalRev },
      cogs:    { fuel: fuelCOGS, products: prodCOGS, total: totalCOGS },
      grossProfit,
      expenses: { salary: salaryExp, total: salaryExp },
      netProfit,
      metrics:  { litres, marginPerLitre: marginPerL,
                  grossMarginPct: totalRev > 0 ? fmt2(grossProfit / totalRev * 100) : 0 }
    }});
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
