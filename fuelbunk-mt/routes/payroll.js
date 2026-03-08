'use strict';
const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════════════════
// ATTENDANCE
// ═══════════════════════════════════════════════════════════════════════════

// GET attendance for a month
router.get('/attendance', async (req, res) => {
  const sid = req.user.stationId;
  const { month, year, employeeId } = req.query;
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year) || new Date().getFullYear();
  const pad = n => String(n).padStart(2,'0');
  const from = `${y}-${pad(m)}-01`;
  const to   = `${y}-${pad(m)}-31`;

  let sql = `SELECT a.*, e.full_name, e.emp_code, e.role FROM attendance a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.station_id=? AND a.work_date BETWEEN ? AND ?`;
  const params = [sid, from, to];
  if (employeeId) { sql += ' AND a.employee_id=?'; params.push(employeeId); }
  sql += ' ORDER BY a.work_date, e.full_name';
  const data = await db.all(sql, params);
  res.json({ success: true, data, month: m, year: y });
});

// GET attendance summary per employee for a month
router.get('/attendance/summary', async (req, res) => {
  const sid = req.user.stationId;
  const m = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y = parseInt(req.query.year) || new Date().getFullYear();
  const pad = n => String(n).padStart(2,'0');
  const from = `${y}-${pad(m)}-01`, to = `${y}-${pad(m)}-31`;

  const employees = await db.all(
    'SELECT id,full_name,emp_code,role,salary FROM employees WHERE station_id=? AND is_active=1 ORDER BY full_name',
    [sid]
  );
  const summaries = await Promise.all(employees.map(async e => {
    const att = await db.all(
      'SELECT status, COUNT(*) as cnt, SUM(overtime_hours) as ot FROM attendance WHERE employee_id=? AND station_id=? AND work_date BETWEEN ? AND ? GROUP BY status',
      [e.id, sid, from, to]
    );
    const present  = att.find(a=>a.status==='present')?.cnt  || 0;
    const absent   = att.find(a=>a.status==='absent')?.cnt   || 0;
    const half     = att.find(a=>a.status==='half_day')?.cnt || 0;
    const holiday  = att.find(a=>a.status==='holiday')?.cnt  || 0;
    const leave    = att.find(a=>a.status==='leave')?.cnt    || 0;
    const overtime = att.reduce((a,b)=>a+(b.ot||0),0);
    const existing = await db.get(
      'SELECT * FROM payroll_runs WHERE employee_id=? AND station_id=? AND payroll_month=? AND payroll_year=?',
      [e.id, sid, m, y]
    );
    return { ...e, present, absent, half, holiday, leave, overtime, payrollStatus: existing?.status||null, payrollId: existing?.id||null };
  }));
  res.json({ success: true, data: summaries, month: m, year: y });
});

// Mark attendance (single or bulk)
router.post('/attendance', authorize('owner','manager'),
  [body('employeeId').isInt({min:1}),
   body('workDate').isDate(),
   body('status').isIn(['present','absent','half_day','holiday','leave']),
   body('hoursWorked').optional().isFloat({min:0,max:24}),
   body('overtimeHours').optional().isFloat({min:0,max:12})],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success:false, errors: errors.array() });
    const sid = req.user.stationId;
    const { employeeId, workDate, status, hoursWorked=8, overtimeHours=0, notes } = req.body;
    const emp = await db.get('SELECT id FROM employees WHERE id=? AND station_id=?', [employeeId, sid]);
    if (!emp) return res.status(404).json({ success:false, error:'Employee not found.' });
    await db.run(`INSERT INTO attendance (station_id,employee_id,work_date,status,hours_worked,overtime_hours,notes,marked_by)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(station_id,employee_id,work_date) DO UPDATE SET
        status=excluded.status, hours_worked=excluded.hours_worked,
        overtime_hours=excluded.overtime_hours, notes=excluded.notes,
        updated_at=datetime('now')`,
      [sid, employeeId, workDate, status, hoursWorked, overtimeHours, notes||null, req.user.id]);
    await db.logAudit(sid, req.user.id, req.user.username, 'ATTENDANCE_MARK', 'attendance', employeeId, null, {workDate,status}, req.ip, req.get('user-agent'));
    res.json({ success:true, message:'Attendance marked.' });
  }
);

// Bulk mark attendance for all employees on a date
router.post('/attendance/bulk', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const { workDate, records } = req.body; // records: [{employeeId, status, hoursWorked, overtimeHours}]
  if (!workDate || !Array.isArray(records)) return res.status(400).json({ success:false, error:'workDate and records required.' });
  let saved = 0;
  for (const r of records) {
    if (!r.employeeId) continue;
    const emp = await db.get('SELECT id FROM employees WHERE id=? AND station_id=?', [r.employeeId, sid]);
    if (!emp) continue;
    await db.run(`INSERT INTO attendance (station_id,employee_id,work_date,status,hours_worked,overtime_hours,marked_by)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(station_id,employee_id,work_date) DO UPDATE SET
        status=excluded.status, hours_worked=excluded.hours_worked, overtime_hours=excluded.overtime_hours, updated_at=datetime('now')`,
      [sid, r.employeeId, workDate, r.status||'present', r.hoursWorked||8, r.overtimeHours||0, req.user.id]);
    saved++;
  }
  res.json({ success:true, message:`${saved} attendance records saved.`, saved });
});

// ═══════════════════════════════════════════════════════════════════════════
// SALARY ADVANCES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/advances', async (req, res) => {
  const sid = req.user.stationId;
  const empId = req.query.employeeId;
  let sql = `SELECT sa.*, e.full_name FROM salary_advances sa JOIN employees e ON e.id=sa.employee_id WHERE sa.station_id=?`;
  const params = [sid];
  if (empId) { sql += ' AND sa.employee_id=?'; params.push(empId); }
  sql += ' ORDER BY sa.advance_date DESC';
  const data = await db.all(sql, params);
  res.json({ success:true, data });
});

router.post('/advances', authorize('owner','manager'),
  [body('employeeId').isInt({min:1}),
   body('amount').isFloat({min:1}),
   body('repayMonths').optional().isInt({min:1,max:12})],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success:false, errors: errors.array() });
    const sid = req.user.stationId;
    const { employeeId, amount, reason, repayMonths=1, advanceDate } = req.body;
    const emp = await db.get('SELECT * FROM employees WHERE id=? AND station_id=?', [employeeId, sid]);
    if (!emp) return res.status(404).json({ success:false, error:'Employee not found.' });
    const monthly = +(amount / repayMonths).toFixed(2);
    const r = await db.run(`INSERT INTO salary_advances (station_id,employee_id,amount,reason,advance_date,repay_months,monthly_deduction,balance_remaining,given_by)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [sid, employeeId, amount, reason||null, advanceDate||new Date().toISOString().slice(0,10), repayMonths, monthly, amount, req.user.id]);
    await db.logAudit(sid, req.user.id, req.user.username, 'ADVANCE_GIVEN', 'salary_advances', r.lastInsertRowid, null, {employeeId, amount, repayMonths}, req.ip, req.get('user-agent'));
    res.status(201).json({ success:true, message:'Advance recorded.', advanceId: r.lastInsertRowid, monthlyDeduction: monthly });
  }
);

router.put('/advances/:id/clear', authorize('owner'), async (req, res) => {
  const sid = req.user.stationId;
  const adv = await db.get('SELECT * FROM salary_advances WHERE id=? AND station_id=?', [req.params.id, sid]);
  if (!adv) return res.status(404).json({ success:false, error:'Advance not found.' });
  await db.run(`UPDATE salary_advances SET balance_remaining=0, status='cleared' WHERE id=?`, [req.params.id]);
  res.json({ success:true, message:'Advance cleared.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL CALCULATION
// ═══════════════════════════════════════════════════════════════════════════
router.get('/payroll', async (req, res) => {
  const sid = req.user.stationId;
  const m = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y = parseInt(req.query.year)  || new Date().getFullYear();
  const data = await db.all(`
    SELECT pr.*, e.full_name, e.emp_code, e.role
    FROM payroll_runs pr JOIN employees e ON e.id=pr.employee_id
    WHERE pr.station_id=? AND pr.payroll_month=? AND pr.payroll_year=?
    ORDER BY e.full_name`, [sid, m, y]);
  res.json({ success:true, data, month:m, year:y });
});

// Calculate (preview) payroll for one employee
router.post('/payroll/calculate', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const { employeeId, month, year, workingDays=26, otRate=50, otherDeductions=0 } = req.body;
  if (!employeeId || !month || !year) return res.status(400).json({ success:false, error:'employeeId, month, year required.' });
  const emp = await db.get('SELECT * FROM employees WHERE id=? AND station_id=?', [employeeId, sid]);
  if (!emp) return res.status(404).json({ success:false, error:'Employee not found.' });
  const pad = n => String(n).padStart(2,'0');
  const from = `${year}-${pad(month)}-01`, to = `${year}-${pad(month)}-31`;
  const att = await db.all(
    'SELECT status, COUNT(*) as cnt, SUM(overtime_hours) as ot FROM attendance WHERE employee_id=? AND station_id=? AND work_date BETWEEN ? AND ? GROUP BY status',
    [employeeId, sid, from, to]
  );
  const present  = att.find(a=>a.status==='present')?.cnt  || 0;
  const absent   = att.find(a=>a.status==='absent')?.cnt   || 0;
  const half     = att.find(a=>a.status==='half_day')?.cnt || 0;
  const leave    = att.find(a=>a.status==='leave')?.cnt    || 0;
  const otHours  = att.reduce((a,b)=>a+(b.ot||0),0);
  const effectiveDays = present + (half * 0.5) + leave;
  const perDay = emp.salary / workingDays;
  const earnedSalary  = +(perDay * effectiveDays).toFixed(2);
  const otAmount = +(otHours * otRate).toFixed(2);
  const grossSalary = +(earnedSalary + otAmount).toFixed(2);
  // Active advances total deduction
  const advances = await db.all(
    `SELECT id, monthly_deduction, balance_remaining FROM salary_advances WHERE employee_id=? AND station_id=? AND status='active'`,
    [employeeId, sid]
  );
  const advanceDeduction = Math.min(advances.reduce((a,b)=>a+(b.monthly_deduction||0),0), advances.reduce((a,b)=>a+(b.balance_remaining||0),0));
  const netSalary = Math.max(0, +(grossSalary - advanceDeduction - otherDeductions).toFixed(2));
  res.json({ success:true, data: {
    employeeId, employeeName: emp.full_name, empCode: emp.emp_code, role: emp.role,
    baseSalary: emp.salary, workingDays, effectiveDays,
    present, absent, half, leave, otHours, otAmount, grossSalary,
    advanceDeduction, otherDeductions, netSalary, month, year,
    advances: advances.map(a=>({id:a.id, monthlyDeduction:a.monthly_deduction, balance:a.balance_remaining}))
  }});
});

// Save (finalize) payroll for one employee
router.post('/payroll/save', authorize('owner','manager'), async (req, res) => {
  const sid = req.user.stationId;
  const { employeeId, month, year, workingDays=26, otRate=50, otherDeductions=0, notes } = req.body;
  if (!employeeId||!month||!year) return res.status(400).json({ success:false, error:'employeeId, month, year required.' });
  const emp = await db.get('SELECT * FROM employees WHERE id=? AND station_id=?', [employeeId, sid]);
  if (!emp) return res.status(404).json({ success:false, error:'Employee not found.' });
  const pad = n => String(n).padStart(2,'0');
  const from = `${year}-${pad(month)}-01`, to = `${year}-${pad(month)}-31`;
  const att = await db.all(
    'SELECT status, COUNT(*) as cnt, SUM(overtime_hours) as ot FROM attendance WHERE employee_id=? AND station_id=? AND work_date BETWEEN ? AND ? GROUP BY status',
    [employeeId, sid, from, to]
  );
  const present  = att.find(a=>a.status==='present')?.cnt  || 0;
  const absent   = att.find(a=>a.status==='absent')?.cnt   || 0;
  const half     = att.find(a=>a.status==='half_day')?.cnt || 0;
  const leave    = att.find(a=>a.status==='leave')?.cnt    || 0;
  const otHours  = att.reduce((a,b)=>a+(b.ot||0),0);
  const effectiveDays = present + (half * 0.5) + leave;
  const perDay = emp.salary / workingDays;
  const grossSalary = +((perDay * effectiveDays) + (otHours * otRate)).toFixed(2);
  const advances = await db.all(`SELECT id,monthly_deduction,balance_remaining FROM salary_advances WHERE employee_id=? AND station_id=? AND status='active'`,[employeeId,sid]);
  const advanceDeduction = Math.min(advances.reduce((a,b)=>a+(b.monthly_deduction||0),0), advances.reduce((a,b)=>a+(b.balance_remaining||0),0));
  const netSalary = Math.max(0, +(grossSalary - advanceDeduction - otherDeductions).toFixed(2));
  const existing = await db.get('SELECT id FROM payroll_runs WHERE employee_id=? AND station_id=? AND payroll_month=? AND payroll_year=?',[employeeId,sid,month,year]);
  let payrollId;
  if (existing) {
    await db.run(`UPDATE payroll_runs SET base_salary=?,working_days=?,days_present=?,days_absent=?,half_days=?,overtime_hours=?,overtime_amount=?,gross_salary=?,advance_deduction=?,other_deductions=?,net_salary=?,status='draft',notes=?,updated_at=datetime('now') WHERE id=?`,
      [emp.salary,workingDays,present,absent,half,otHours,+(otHours*otRate).toFixed(2),grossSalary,advanceDeduction,otherDeductions,netSalary,notes||null,existing.id]);
    payrollId = existing.id;
  } else {
    const r = await db.run(`INSERT INTO payroll_runs (station_id,employee_id,payroll_month,payroll_year,base_salary,working_days,days_present,days_absent,half_days,overtime_hours,overtime_amount,gross_salary,advance_deduction,other_deductions,net_salary,generated_by,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sid,employeeId,month,year,emp.salary,workingDays,present,absent,half,otHours,+(otHours*otRate).toFixed(2),grossSalary,advanceDeduction,otherDeductions,netSalary,req.user.id,notes||null]);
    payrollId = r.lastInsertRowid;
  }
  // Deduct from advances
  let remaining = advanceDeduction;
  for (const adv of advances) {
    if (remaining <= 0) break;
    const deduct = Math.min(adv.monthly_deduction, adv.balance_remaining, remaining);
    const newBal = Math.max(0, adv.balance_remaining - deduct);
    await db.run(`UPDATE salary_advances SET balance_remaining=?, status=CASE WHEN ?<=0 THEN 'cleared' ELSE status END WHERE id=?`,
      [newBal, newBal, adv.id]);
    remaining -= deduct;
  }
  await db.logAudit(sid, req.user.id, req.user.username, 'PAYROLL_SAVED', 'payroll_runs', payrollId, null, {employeeId,month,year,netSalary}, req.ip, req.get('user-agent'));
  res.json({ success:true, message:'Payroll saved.', payrollId, netSalary });
});

// Bulk payroll for all employees
router.post('/payroll/bulk', authorize('owner'), async (req, res) => {
  const sid = req.user.stationId;
  const { month, year, workingDays=26 } = req.body;
  if (!month||!year) return res.status(400).json({ success:false, error:'month and year required.' });
  const employees = await db.all('SELECT id FROM employees WHERE station_id=? AND is_active=1',[sid]);
  const results = [];
  for (const e of employees) {
    try {
      const calcRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/payroll/payroll/calculate`,{
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${req.headers.authorization?.split(' ')[1]}`},
        body: JSON.stringify({employeeId:e.id, month, year, workingDays})
      });
      // Inline calculation instead of self-call
      const pad = n => String(n).padStart(2,'0');
      const from = `${year}-${pad(month)}-01`, to = `${year}-${pad(month)}-31`;
      const emp = await db.get('SELECT * FROM employees WHERE id=?',[e.id]);
      const att = await db.all('SELECT status,COUNT(*) as cnt,SUM(overtime_hours) as ot FROM attendance WHERE employee_id=? AND station_id=? AND work_date BETWEEN ? AND ? GROUP BY status',[e.id,sid,from,to]);
      const present=(att.find(a=>a.status==='present')?.cnt||0);
      const half=(att.find(a=>a.status==='half_day')?.cnt||0);
      const leave=(att.find(a=>a.status==='leave')?.cnt||0);
      const absent=(att.find(a=>a.status==='absent')?.cnt||0);
      const otHours=att.reduce((a,b)=>a+(b.ot||0),0);
      const effectiveDays=present+(half*0.5)+leave;
      const perDay=emp.salary/workingDays;
      const grossSalary=+((perDay*effectiveDays)+(otHours*50)).toFixed(2);
      const advances=await db.all(`SELECT id,monthly_deduction,balance_remaining FROM salary_advances WHERE employee_id=? AND station_id=? AND status='active'`,[e.id,sid]);
      const advDeduct=Math.min(advances.reduce((a,b)=>a+(b.monthly_deduction||0),0),advances.reduce((a,b)=>a+(b.balance_remaining||0),0));
      const netSalary=Math.max(0,+(grossSalary-advDeduct).toFixed(2));
      const existing=await db.get('SELECT id FROM payroll_runs WHERE employee_id=? AND station_id=? AND payroll_month=? AND payroll_year=?',[e.id,sid,month,year]);
      if (existing) {
        await db.run(`UPDATE payroll_runs SET base_salary=?,working_days=?,days_present=?,days_absent=?,half_days=?,overtime_hours=?,gross_salary=?,advance_deduction=?,net_salary=?,status='draft',updated_at=datetime('now') WHERE id=?`,
          [emp.salary,workingDays,present,absent,half,otHours,grossSalary,advDeduct,netSalary,existing.id]);
      } else {
        await db.run(`INSERT INTO payroll_runs (station_id,employee_id,payroll_month,payroll_year,base_salary,working_days,days_present,days_absent,half_days,overtime_hours,gross_salary,advance_deduction,net_salary,generated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [sid,e.id,month,year,emp.salary,workingDays,present,absent,half,otHours,grossSalary,advDeduct,netSalary,req.user.id]);
      }
      results.push({ employeeId:e.id, name:emp.full_name, netSalary, status:'ok' });
    } catch(err) { results.push({ employeeId:e.id, status:'error', error:err.message }); }
  }
  res.json({ success:true, message:`Payroll generated for ${results.filter(r=>r.status==='ok').length} employees.`, results });
});

// Approve / mark as paid
router.put('/payroll/:id/approve', authorize('owner'), async (req, res) => {
  const sid = req.user.stationId;
  const pr = await db.get('SELECT * FROM payroll_runs WHERE id=? AND station_id=?',[req.params.id,sid]);
  if (!pr) return res.status(404).json({ success:false, error:'Payroll record not found.' });
  const { paymentMode='cash', paymentDate } = req.body;
  await db.run(`UPDATE payroll_runs SET status='paid',payment_mode=?,payment_date=?,updated_at=datetime('now') WHERE id=?`,
    [paymentMode, paymentDate||new Date().toISOString().slice(0,10), req.params.id]);
  res.json({ success:true, message:'Marked as paid.' });
});

// Get single payroll detail (for slip)
router.get('/payroll/:id', async (req, res) => {
  const sid = req.user.stationId;
  const pr = await db.get(`SELECT pr.*,e.full_name,e.emp_code,e.role,e.mobile,e.join_date,st.station_name,st.address,st.mobile as station_mobile FROM payroll_runs pr JOIN employees e ON e.id=pr.employee_id JOIN stations st ON st.id=pr.station_id WHERE pr.id=? AND pr.station_id=?`,[req.params.id,sid]);
  if (!pr) return res.status(404).json({ success:false, error:'Not found.' });
  res.json({ success:true, data:pr });
});

// ═══════════════════════════════════════════════════════════════════════════
// PERFORMANCE REPORT
// ═══════════════════════════════════════════════════════════════════════════
router.get('/performance', async (req, res) => {
  const sid = req.user.stationId;
  const m = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y = parseInt(req.query.year)  || new Date().getFullYear();
  const pad = n => String(n).padStart(2,'0');
  const from = `${y}-${pad(m)}-01`, to = `${y}-${pad(m)}-31`;

  const employees = await db.all('SELECT id,full_name,emp_code,role,salary FROM employees WHERE station_id=? AND is_active=1 ORDER BY full_name',[sid]);
  const perf = await Promise.all(employees.map(async e => {
    const [sales, shifts, att, advances] = await Promise.all([
      db.get(`SELECT COUNT(*) as txns, ROUND(SUM(quantity),2) as litres, ROUND(SUM(total_amount),2) as revenue FROM sales WHERE served_by=? AND station_id=? AND date(sale_time) BETWEEN ? AND ? AND is_cancelled=0`,[e.id,sid,from,to]),
      db.get(`SELECT COUNT(*) as total, COUNT(CASE WHEN status='closed' THEN 1 END) as closed, ROUND(AVG(ABS(cash_variance)),2) as avg_variance FROM shifts WHERE opened_by=? AND station_id=? AND date(open_time) BETWEEN ? AND ?`,[e.id,sid,from,to]),
      db.get(`SELECT COUNT(*) as total, COUNT(CASE WHEN status='present' THEN 1 END) as present, COUNT(CASE WHEN status='absent' THEN 1 END) as absent FROM attendance WHERE employee_id=? AND station_id=? AND work_date BETWEEN ? AND ?`,[e.id,sid,from,to]),
      db.get(`SELECT COALESCE(SUM(balance_remaining),0) as total_advance FROM salary_advances WHERE employee_id=? AND station_id=? AND status='active'`,[e.id,sid]),
    ]);
    const attRate = att.total > 0 ? Math.round((att.present/att.total)*100) : null;
    return {
      ...e,
      txns: sales?.txns||0, litres: sales?.litres||0, revenue: sales?.revenue||0,
      shiftsOpened: shifts?.total||0, shiftsCompleted: shifts?.closed||0,
      avgCashVariance: shifts?.avg_variance||0,
      attendanceDays: att?.total||0, presentDays: att?.present||0, absentDays: att?.absent||0,
      attendanceRate: attRate,
      totalAdvanceBalance: advances?.total_advance||0,
      score: ((sales?.litres||0)/100) + ((att?.present||0)*2) - ((att?.absent||0)*3) - ((shifts?.avg_variance||0)/100)
    };
  }));
  perf.sort((a,b)=>b.score-a.score);
  res.json({ success:true, data:perf, month:m, year:y });
});

module.exports = router;
