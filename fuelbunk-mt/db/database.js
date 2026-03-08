'use strict';
const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || './data/fuelbunk.db';
const isMemory = DB_PATH === ':memory:';
if (!isMemory) fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const client = createClient({ url: isMemory ? ':memory:' : `file:${path.resolve(DB_PATH)}` });

function rowToObj(row, columns) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i] !== undefined ? row[i] : null; });
  return obj;
}

const db = {
  _client: client,
  async run(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.rowsAffected };
  },
  async get(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return result.rows[0] ? rowToObj(result.rows[0], result.columns) : null;
  },
  async all(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return result.rows.map(row => rowToObj(row, result.columns));
  },
  async transaction(fn) {
    await client.execute('BEGIN');
    try { const r = await fn(db); await client.execute('COMMIT'); return r; }
    catch(e) { await client.execute('ROLLBACK'); throw e; }
  },
  async logAudit(stationId, userId, username, action, resource, resourceId, oldVal, newVal, ip, ua, status='success') {
    try {
      await this.run(
        `INSERT INTO audit_log (station_id,user_id,username,action,resource,resource_id,old_values,new_values,ip_address,user_agent,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [stationId,userId,username,action,resource,resourceId,
          oldVal?JSON.stringify(oldVal):null, newVal?JSON.stringify(newVal):null, ip, ua, status]
      );
    } catch {}
  },
  generateInvoiceNo(stationCode='FB') {
    const n = new Date();
    return `${stationCode}${n.getFullYear().toString().slice(-2)}${String(n.getMonth()+1).padStart(2,'0')}${Math.floor(Math.random()*900000)+100000}`;
  }
};

async function initSchema() {
  const tables = [
    // ── STATIONS (multi-tenant core) ─────────────────────────
    `CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      station_name TEXT NOT NULL,
      gstin TEXT, address TEXT, mobile TEXT, email TEXT,
      ms_price REAL NOT NULL DEFAULT 102.00,
      hsd_price REAL NOT NULL DEFAULT 90.00,
      cng_price REAL NOT NULL DEFAULT 85.00,
      xp_price REAL NOT NULL DEFAULT 110.00,
      idle_timeout INTEGER NOT NULL DEFAULT 15,
      plan TEXT NOT NULL DEFAULT 'trial' CHECK(plan IN ('trial','basic','pro','enterprise')),
      is_active INTEGER NOT NULL DEFAULT 1,
      trial_ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // ── SUPER ADMINS ──────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS super_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // ── USERS (per station) ───────────────────────────────────
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      username TEXT NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','manager','cashier','attendant')),
      mobile TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      last_login TEXT, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(station_id, username)
    )`,
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, super_admin_id INTEGER,
      station_id INTEGER,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL, ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER, user_id INTEGER, username TEXT,
      action TEXT NOT NULL, resource TEXT, resource_id INTEGER,
      old_values TEXT, new_values TEXT, ip_address TEXT, user_agent TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS tanks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      tank_name TEXT NOT NULL, fuel_type TEXT NOT NULL CHECK(fuel_type IN ('MS','HSD','CNG','XP')),
      display_name TEXT,
      capacity REAL NOT NULL, current_stock REAL NOT NULL DEFAULT 0,
      min_alert REAL NOT NULL DEFAULT 2000, is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `ALTER TABLE tanks ADD COLUMN display_name TEXT`,
    `CREATE TABLE IF NOT EXISTS nozzles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      tank_id INTEGER NOT NULL REFERENCES tanks(id),
      nozzle_name TEXT NOT NULL, last_reading REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      user_id INTEGER, emp_code TEXT,
      full_name TEXT NOT NULL, role TEXT NOT NULL,
      mobile TEXT, salary REAL NOT NULL DEFAULT 0,
      join_date TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(station_id, emp_code)
    )`,
    `CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      shift_name TEXT NOT NULL, employee_id INTEGER,
      opened_by INTEGER NOT NULL, closed_by INTEGER,
      open_time TEXT NOT NULL DEFAULT (datetime('now')), close_time TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      opening_readings TEXT NOT NULL DEFAULT '{}', closing_readings TEXT DEFAULT '{}',
      total_sales REAL DEFAULT 0, cash_collected REAL DEFAULT 0,
      upi_collected REAL DEFAULT 0, card_collected REAL DEFAULT 0,
      credit_sales REAL DEFAULT 0, cash_physical REAL DEFAULT 0,
      cash_variance REAL DEFAULT 0, notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS credit_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      company_name TEXT NOT NULL, contact_name TEXT,
      mobile TEXT, email TEXT, gstin TEXT, address TEXT,
      credit_limit REAL NOT NULL DEFAULT 0, outstanding REAL NOT NULL DEFAULT 0,
      billing_cycle TEXT NOT NULL DEFAULT 'monthly', is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS credit_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL, amount REAL NOT NULL,
      payment_mode TEXT NOT NULL, reference_no TEXT, notes TEXT,
      received_by INTEGER, payment_date TEXT NOT NULL DEFAULT (date('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      name TEXT NOT NULL, gstin TEXT, mobile TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      tank_id INTEGER NOT NULL, supplier_id INTEGER, invoice_no TEXT,
      quantity REAL NOT NULL, rate REAL NOT NULL, amount REAL NOT NULL,
      density REAL, gst_rate REAL DEFAULT 0, gst_amount REAL DEFAULT 0,
      total_amount REAL NOT NULL, purchase_date TEXT NOT NULL DEFAULT (date('now')),
      received_by INTEGER, notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS dip_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      tank_id INTEGER NOT NULL, shift_id INTEGER,
      dip_mm REAL, calculated_litres REAL NOT NULL, actual_stock REAL NOT NULL,
      variance REAL DEFAULT 0, reading_type TEXT NOT NULL DEFAULT 'manual',
      taken_by INTEGER, reading_time TEXT NOT NULL DEFAULT (datetime('now')), notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      invoice_no TEXT NOT NULL, shift_id INTEGER NOT NULL,
      nozzle_id INTEGER, tank_id INTEGER, fuel_type TEXT NOT NULL,
      quantity REAL NOT NULL, rate REAL NOT NULL, amount REAL NOT NULL,
      gst_rate REAL NOT NULL DEFAULT 0, gst_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL, payment_mode TEXT NOT NULL,
      upi_ref TEXT, customer_id INTEGER, vehicle_no TEXT,
      served_by INTEGER, is_cancelled INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT, sale_time TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(station_id, invoice_no)
    )`,
    `CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      product_code TEXT, product_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'lubricant', hsn_code TEXT,
      unit TEXT NOT NULL DEFAULT 'litre', mrp REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 18,
      stock_qty REAL NOT NULL DEFAULT 0, min_stock REAL NOT NULL DEFAULT 5,
      expiry_date TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // ── SPRINT 2: ATTENDANCE ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      shift_id INTEGER REFERENCES shifts(id),
      work_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','absent','half_day','holiday','leave')),
      hours_worked REAL DEFAULT 8,
      overtime_hours REAL DEFAULT 0,
      notes TEXT,
      marked_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(station_id, employee_id, work_date)
    )`,
    // ── SPRINT 2: SALARY ADVANCES ─────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS salary_advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      reason TEXT,
      advance_date TEXT NOT NULL DEFAULT (date('now')),
      repay_months INTEGER NOT NULL DEFAULT 1,
      monthly_deduction REAL NOT NULL DEFAULT 0,
      balance_remaining REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cleared')),
      given_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // ── SPRINT 2: PAYROLL RUNS ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS payroll_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      payroll_month INTEGER NOT NULL,
      payroll_year INTEGER NOT NULL,
      base_salary REAL NOT NULL,
      working_days INTEGER NOT NULL DEFAULT 26,
      days_present REAL NOT NULL DEFAULT 0,
      days_absent REAL NOT NULL DEFAULT 0,
      half_days INTEGER NOT NULL DEFAULT 0,
      overtime_hours REAL NOT NULL DEFAULT 0,
      overtime_amount REAL NOT NULL DEFAULT 0,
      gross_salary REAL NOT NULL DEFAULT 0,
      advance_deduction REAL NOT NULL DEFAULT 0,
      other_deductions REAL NOT NULL DEFAULT 0,
      net_salary REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','paid')),
      payment_date TEXT,
      payment_mode TEXT,
      notes TEXT,
      generated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(station_id, employee_id, payroll_month, payroll_year)
    )`,
    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_attendance_station ON attendance(station_id)`,
    `CREATE INDEX IF NOT EXISTS idx_attendance_emp ON attendance(employee_id, work_date)`,
    `CREATE INDEX IF NOT EXISTS idx_payroll_station ON payroll_runs(station_id)`,
    `CREATE INDEX IF NOT EXISTS idx_advances_emp ON salary_advances(employee_id)`,

    // ── SPRINT 4: NOTIFICATION SETTINGS ──────────────────────────────────
    `CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL UNIQUE REFERENCES stations(id) ON DELETE CASCADE,
      wa_enabled INTEGER NOT NULL DEFAULT 0,
      wa_number TEXT,
      wa_provider TEXT NOT NULL DEFAULT 'simulate',
      low_stock_enabled INTEGER NOT NULL DEFAULT 1,
      low_stock_threshold REAL,
      day_close_enabled INTEGER NOT NULL DEFAULT 1,
      day_close_time TEXT NOT NULL DEFAULT '22:00',
      credit_reminder_enabled INTEGER NOT NULL DEFAULT 1,
      credit_reminder_days INTEGER NOT NULL DEFAULT 30,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // ── SPRINT 4: NOTIFICATION LOG ────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      recipient TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      error_msg TEXT,
      provider TEXT,
      meta TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notif_log_station ON notification_log(station_id, sent_at)`,

    // ── SPRINT 5: DIP CHART CALIBRATION DATA ─────────────────────────────
    `CREATE TABLE IF NOT EXISTS dip_chart_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      tank_id INTEGER NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
      mm_level REAL NOT NULL,
      litres_volume REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tank_id, mm_level)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dip_chart_tank ON dip_chart_data(tank_id, mm_level)`,

    // ── SPRINT 5: PRODUCT SALES (Lubes & Accessories) ────────────────────
    `CREATE TABLE IF NOT EXISTS product_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      invoice_no TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      shift_id INTEGER REFERENCES shifts(id),
      quantity REAL NOT NULL,
      rate REAL NOT NULL,
      mrp REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      gst_rate REAL NOT NULL DEFAULT 18,
      gst_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'cash',
      customer_name TEXT,
      vehicle_no TEXT,
      served_by INTEGER,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
      sale_time TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_product_sales_station ON product_sales(station_id, sale_time)`,
    `CREATE INDEX IF NOT EXISTS idx_product_sales_product ON product_sales(product_id)`,

    // ── SPRINT 5: PRODUCT STOCK-IN ────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS product_stock_in (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity REAL NOT NULL,
      rate REAL NOT NULL DEFAULT 0,
      invoice_no TEXT,
      supplier_name TEXT,
      notes TEXT,
      received_by INTEGER,
      stock_date TEXT NOT NULL DEFAULT (date('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    // ── SPRINT 6: BANK RECONCILIATION ─────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS bank_reconciliation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      recon_date TEXT NOT NULL,
      cash_deposited REAL NOT NULL DEFAULT 0,
      upi_phonepe REAL NOT NULL DEFAULT 0,
      upi_gpay REAL NOT NULL DEFAULT 0,
      upi_paytm REAL NOT NULL DEFAULT 0,
      upi_other REAL NOT NULL DEFAULT 0,
      card_settled REAL NOT NULL DEFAULT 0,
      notes TEXT,
      recorded_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(station_id, recon_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bank_recon_station ON bank_reconciliation(station_id, recon_date)`,

    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_sales_station ON sales(station_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_time ON sales(sale_time)`,
    `CREATE INDEX IF NOT EXISTS idx_shifts_station ON shifts(station_id)`,
    `CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(station_id,status)`,
    `CREATE INDEX IF NOT EXISTS idx_users_station ON users(station_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tanks_station ON tanks(station_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_station ON audit_log(station_id)`,

    // ── SPRINT 7: SUPPLIER PAYMENTS ───────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      amount REAL NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'neft',
      reference_no TEXT,
      payment_date TEXT NOT NULL DEFAULT (date('now')),
      notes TEXT,
      recorded_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sup_pay_station ON supplier_payments(station_id, supplier_id)`,

    // ── SPRINT 7: SUPPLIER BANK DETAILS (ALTER — safe) ───────────────────
    `ALTER TABLE suppliers ADD COLUMN bank_name TEXT`,
    `ALTER TABLE suppliers ADD COLUMN account_no TEXT`,
    `ALTER TABLE suppliers ADD COLUMN ifsc_code TEXT`,
    `ALTER TABLE suppliers ADD COLUMN address TEXT`,
    `ALTER TABLE suppliers ADD COLUMN email TEXT`,

    // ── SPRINT 7: SHIFT CONFIGS (multi-shift Morning/Afternoon/Night) ─────
    `CREATE TABLE IF NOT EXISTS shift_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      shift_name TEXT NOT NULL,
      start_time TEXT NOT NULL DEFAULT '06:00',
      end_time TEXT NOT NULL DEFAULT '14:00',
      default_nozzle_ids TEXT DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(station_id, shift_name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_shift_configs_station ON shift_configs(station_id)`,

    // ── SPRINT 7: OFFLINE SALE QUEUE (for IndexedDB sync) ────────────────
    `CREATE TABLE IF NOT EXISTS offline_sale_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','failed')),
      synced_invoice_no TEXT,
      error_msg TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      synced_at TEXT,
      UNIQUE(station_id, client_id)
    )`,

    // ── SPRINT 7: NOTIFICATION SETTINGS extra fields ──────────────────────
    `ALTER TABLE stations ADD COLUMN xp_price REAL NOT NULL DEFAULT 110.00`,
    `ALTER TABLE notification_settings ADD COLUMN expiry_alert_enabled INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE notification_settings ADD COLUMN expiry_alert_days INTEGER NOT NULL DEFAULT 30`,
    `ALTER TABLE notification_settings ADD COLUMN sms_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE notification_settings ADD COLUMN sms_number TEXT`,
  ];
  for (const s of tables) {
    await client.execute(s).catch(e => { if(!e.message?.includes('already exists')) console.warn('[DB]',e.message?.substring(0,60)); });
  }
}

async function seedInitialData() {
  const sa = await db.get('SELECT id FROM super_admins LIMIT 1');
  if (sa) return;
  const hash = bcrypt.hashSync(process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123', 12);
  await db.run('INSERT INTO super_admins (username,password_hash,full_name) VALUES (?,?,?)',
    [process.env.SUPER_ADMIN_USERNAME || 'superadmin', hash, 'Super Administrator']);

  // Demo station
  await db.run(`INSERT INTO stations (station_code,station_name,ms_price,hsd_price,cng_price,xp_price,plan,trial_ends_at) VALUES (?,?,102,90,85,110,'trial',date('now','+30 days'))`,
    ['DEMO01','Demo Fuel Station']);
  const station = await db.get('SELECT id FROM stations WHERE station_code=?',['DEMO01']);
  const ownerHash = bcrypt.hashSync('Demo@12345', 12);
  await db.run('INSERT INTO users (station_id,username,password_hash,full_name,role) VALUES (?,?,?,?,?)',
    [station.id,'demo','$2a$12$'+ownerHash.slice(7),'Demo Owner','owner']);
  // fix: just use the hash directly
  await db.run('UPDATE users SET password_hash=? WHERE station_id=? AND username=?',
    [bcrypt.hashSync('Demo@12345',12), station.id, 'demo']);
  await db.run('INSERT INTO tanks (station_id,tank_name,fuel_type,capacity,current_stock,min_alert) VALUES (?,?,?,?,?,?)',[station.id,'MS Tank 1','MS',20000,8000,2000]);
  await db.run('INSERT INTO tanks (station_id,tank_name,fuel_type,capacity,current_stock,min_alert) VALUES (?,?,?,?,?,?)',[station.id,'HSD Tank 1','HSD',20000,6000,2000]);
  const t1=await db.get('SELECT id FROM tanks WHERE station_id=? AND fuel_type=?',[station.id,'MS']);
  const t2=await db.get('SELECT id FROM tanks WHERE station_id=? AND fuel_type=?',[station.id,'HSD']);
  if(t1){ await db.run('INSERT INTO nozzles (station_id,tank_id,nozzle_name) VALUES (?,?,?)',[station.id,t1.id,'MS-1']); await db.run('INSERT INTO nozzles (station_id,tank_id,nozzle_name) VALUES (?,?,?)',[station.id,t1.id,'MS-2']); }
  if(t2){ await db.run('INSERT INTO nozzles (station_id,tank_id,nozzle_name) VALUES (?,?,?)',[station.id,t2.id,'HSD-1']); }
  await db.run('INSERT INTO suppliers (station_id,name,mobile) VALUES (?,?,?)',[station.id,'HPCL Depot','9000000001']);
  console.log('[DB] Seeded: superadmin + DEMO01 station');
}

let _ready = null;
db.ready = function() {
  if (!_ready) _ready = initSchema().then(seedInitialData).catch(console.error);
  return _ready;
};

module.exports = db;
