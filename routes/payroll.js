const express = require('express');
const router = express.Router();
const pool = require('../db');

// =====================
// Helper functions
// =====================

async function getActivePayRate(worker_id, date) {
  const q = await pool.query(
    `SELECT rate FROM pay_rates
      WHERE worker_id = $1
        AND start_date <= $2
        AND (end_date IS NULL OR end_date >= $2)
      ORDER BY start_date DESC
      LIMIT 1`,
    [worker_id, date]
  );

  return Number(q.rows[0]?.rate || 0);
}

function parseDateTime(str) {
  if (!str) return null;

  const clean = String(str).trim().replace('T', ' ');
  const [datePart, timePartRaw = '00:00'] = clean.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour = 0, minute = 0] = timePartRaw.split(':').map(Number);

  if (!year || !month || !day) return null;

  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (isNaN(d.getTime())) return null;

  return d;
}

function getDatePart(str) {
  if (!str) return '';
  return String(str).slice(0, 10);
}

function getRowDateTime(row) {
  return row.datetime_local || row.datetime_utc || '';
}

function isTrue(value) {
  return value === true || value === 'true' || value === 't' || value === 1 || value === '1';
}

function getISOWeekKey(date) {
  const tmp = new Date(date.valueOf());
  tmp.setHours(0, 0, 0, 0);
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));

  const week1 = new Date(tmp.getFullYear(), 0, 4);
  const weekNo =
    1 +
    Math.round(
      ((tmp - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
    );

  return `${tmp.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function passesDateFilter(pair, start_date, end_date) {
  const clockInDate = getDatePart(pair.in.datetime_local || pair.in.datetime_utc);

  if (start_date && clockInDate < start_date) return false;
  if (end_date && clockInDate > end_date) return false;

  return true;
}

// =====================
// Pair clock entries into sessions
// Important: use session_id
// This fixes forced clock-out sessions.
// =====================

function buildSessionPairs(entries) {
  const groups = {};

  for (const row of entries) {
    let key;

    if (row.session_id) {
      key = `session:${row.session_id}`;
    } else {
      // Fallback for older records without session_id
      const day = getDatePart(row.datetime_local || row.datetime_utc);
      key = `legacy:${row.worker_id}|${row.project_id}|${day}`;
    }

    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }

  const pairs = [];

  for (const key of Object.keys(groups)) {
    const rows = groups[key].sort((a, b) => {
      const aTime = getRowDateTime(a);
      const bTime = getRowDateTime(b);
      return aTime.localeCompare(bTime);
    });

    const openIns = [];

    for (const row of rows) {
      if (row.action === 'in') {
        openIns.push(row);
      }

      if (row.action === 'out' && openIns.length) {
        const inRow = openIns.shift();
        pairs.push({
          in: inRow,
          out: row
        });
      }
    }
  }

  return pairs;
}

// =====================
// Daily overtime
// 8 hours regular per worker per day
// =====================

async function splitDailyOvertime(entries, start_date, end_date) {
  let pairs = buildSessionPairs(entries);

  // Filter by clock-in date AFTER pairing, so forced clock-out rows are not lost.
  pairs = pairs.filter(pair => passesDateFilter(pair, start_date, end_date));

  const validPairs = [];

  for (const pair of pairs) {
    const inStr = pair.in.datetime_local || pair.in.datetime_utc;
    const outStr = pair.out.datetime_local || pair.out.datetime_utc;

    const inTime = parseDateTime(inStr);
    const outTime = parseDateTime(outStr);

    if (!inTime || !outTime) {
      console.warn('Payroll: skipping invalid datetime:', inStr, outStr, pair);
      continue;
    }

    let hours = (outTime - inTime) / (1000 * 60 * 60);
    if (hours < 0) hours = 0;

    validPairs.push({
      ...pair,
      inTime,
      outTime,
      hours
    });
  }

  const byWorkerDay = {};

  for (const pair of validPairs) {
    const day = getDatePart(pair.in.datetime_local || pair.in.datetime_utc);
    const key = `${pair.in.worker_id}|${day}`;

    if (!byWorkerDay[key]) byWorkerDay[key] = [];
    byWorkerDay[key].push(pair);
  }

  const result = [];

  for (const key of Object.keys(byWorkerDay)) {
    const dayPairs = byWorkerDay[key].sort((a, b) => a.inTime - b.inTime);

    let regularLeft = 8;

    for (const pair of dayPairs) {
      let regularHours = 0;
      let overtimeHours = 0;

      if (regularLeft > 0) {
        if (pair.hours <= regularLeft) {
          regularHours = pair.hours;
          regularLeft -= pair.hours;
        } else {
          regularHours = regularLeft;
          overtimeHours = pair.hours - regularLeft;
          regularLeft = 0;
        }
      } else {
        overtimeHours = pair.hours;
      }

      const dateStr = pair.in.datetime_local || pair.in.datetime_utc;
      const workDate = getDatePart(dateStr);

      let baseRate = Number(pair.in.pay_rate || pair.out.pay_rate || 0);

      if (!baseRate || baseRate === 0) {
        baseRate = await getActivePayRate(pair.in.worker_id, workDate);
      }

      const sessionPaid = isTrue(pair.in.paid) || isTrue(pair.out.paid);
      const sessionBilled = isTrue(pair.in.billed) || isTrue(pair.out.billed);

      const paidDate = pair.in.paid_date || pair.out.paid_date || null;
      const billedDate = pair.in.billed_date || pair.out.billed_date || null;

      const commonFields = {
        ...pair.in,
        id: pair.in.id,
        session_id: pair.in.session_id,
        datetime_out_local: pair.out.datetime_local || pair.out.datetime_utc,
        clock_out_note: pair.out.note || '',
        paid: sessionPaid,
        paid_date: paidDate,
        billed: sessionBilled,
        billed_date: billedDate
      };

      if (regularHours > 0) {
        result.push({
          ...commonFields,
          regular_time: Number(regularHours.toFixed(2)),
          overtime: 0,
          ot_type: '',
          pay_rate: Number(baseRate.toFixed(2)),
          pay_amount: Number((regularHours * baseRate).toFixed(2))
        });
      }

      if (overtimeHours > 0) {
        const overtimeRate = baseRate * 1.5;

        result.push({
          ...commonFields,
          regular_time: 0,
          overtime: Number(overtimeHours.toFixed(2)),
          ot_type: 'Daily',
          pay_rate: Number(overtimeRate.toFixed(2)),
          pay_amount: Number((overtimeHours * overtimeRate).toFixed(2))
        });
      }
    }
  }

  return result;
}

// =====================
// Weekly overtime
// Over 40 regular hours per week becomes weekly OT.
// Daily OT rows stay as OT.
// =====================

function splitWeeklyOvertime(dailyRows) {
  const byWeek = {};

  for (const row of dailyRows) {
    const dateStr = row.datetime_local || row.datetime_utc;
    const d = parseDateTime(dateStr);

    if (!d) {
      console.warn('Payroll: skipping invalid weekly OT row:', row);
      continue;
    }

    const week = getISOWeekKey(d);
    const key = `${row.worker_id}|${week}`;

    if (!byWeek[key]) byWeek[key] = [];
    byWeek[key].push(row);
  }

  const results = [];

  for (const key of Object.keys(byWeek)) {
    const rows = byWeek[key].sort((a, b) => {
      const aTime = getRowDateTime(a);
      const bTime = getRowDateTime(b);
      return aTime.localeCompare(bTime);
    });

    let totalRegular = 0;

    rows.forEach(row => {
      if (!row.ot_type) {
        totalRegular += Number(row.regular_time || 0);
      }
    });

    if (totalRegular <= 40) {
      results.push(...rows);
      continue;
    }

    let weeklyRegularLeft = 40;

    for (const row of rows) {
      // Keep existing daily OT rows unchanged.
      if (row.ot_type) {
        results.push(row);
        continue;
      }

      const hours = Number(row.regular_time || 0);
      const baseRate = Number(row.pay_rate || 0);

      if (weeklyRegularLeft > 0) {
        if (hours <= weeklyRegularLeft) {
          results.push({
            ...row,
            regular_time: Number(hours.toFixed(2)),
            overtime: 0,
            ot_type: '',
            pay_rate: Number(baseRate.toFixed(2)),
            pay_amount: Number((hours * baseRate).toFixed(2))
          });

          weeklyRegularLeft -= hours;
        } else {
          if (weeklyRegularLeft > 0) {
            results.push({
              ...row,
              regular_time: Number(weeklyRegularLeft.toFixed(2)),
              overtime: 0,
              ot_type: '',
              pay_rate: Number(baseRate.toFixed(2)),
              pay_amount: Number((weeklyRegularLeft * baseRate).toFixed(2))
            });
          }

          const weeklyOtHours = hours - weeklyRegularLeft;
          const overtimeRate = baseRate * 1.5;

          if (weeklyOtHours > 0) {
            results.push({
              ...row,
              regular_time: 0,
              overtime: Number(weeklyOtHours.toFixed(2)),
              ot_type: 'Weekly',
              pay_rate: Number(overtimeRate.toFixed(2)),
              pay_amount: Number((weeklyOtHours * overtimeRate).toFixed(2))
            });
          }

          weeklyRegularLeft = 0;
        }
      } else {
        const overtimeRate = baseRate * 1.5;

        results.push({
          ...row,
          regular_time: 0,
          overtime: Number(hours.toFixed(2)),
          ot_type: 'Weekly',
          pay_rate: Number(overtimeRate.toFixed(2)),
          pay_amount: Number((hours * overtimeRate).toFixed(2))
        });
      }
    }
  }

  return results;
}

function applyStatusFilters(rows, billed, paid) {
  let filtered = rows;

  if (billed === 'true') {
    filtered = filtered.filter(row => isTrue(row.billed));
  }

  if (billed === 'false') {
    filtered = filtered.filter(row => !isTrue(row.billed));
  }

  if (paid === 'true') {
    filtered = filtered.filter(row => isTrue(row.paid));
  }

  if (paid === 'false') {
    filtered = filtered.filter(row => !isTrue(row.paid));
  }

  return filtered;
}

function summarizeByWorker(rows) {
  const sums = {};

  for (const row of rows) {
    const name = row.worker_name || row.worker_id;

    if (!sums[name]) {
      sums[name] = {
        worker_name: name,
        regular_time: 0,
        overtime: 0,
        pay_amount: 0
      };
    }

    sums[name].regular_time += Number(row.regular_time || 0);
    sums[name].overtime += Number(row.overtime || 0);
    sums[name].pay_amount += Number(row.pay_amount || 0);
  }

  Object.values(sums).forEach(sum => {
    sum.regular_time = Number(sum.regular_time.toFixed(2));
    sum.overtime = Number(sum.overtime.toFixed(2));
    sum.pay_amount = Number(sum.pay_amount.toFixed(2));
  });

  return Object.values(sums);
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

async function getPayrollRows(query) {
  const { start_date, end_date, worker_id, project_id, billed, paid } = query;

  const wheres = [];
  const vals = [];

  // Only filter worker/project in SQL.
  // Date, paid, and billed are filtered after pairing sessions.
  if (worker_id) {
    vals.push(worker_id);
    wheres.push(`ce.worker_id = $${vals.length}`);
  }

  if (project_id) {
    vals.push(project_id);
    wheres.push(`ce.project_id = $${vals.length}`);
  }

  const whereClause = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  const q = await pool.query(
    `
    SELECT
      ce.*,
      w.name AS worker_name,
      p.name AS project_name
    FROM clock_entries ce
    JOIN workers w ON ce.worker_id = w.worker_id
    JOIN projects p ON ce.project_id = p.id
    ${whereClause}
    ORDER BY ce.datetime_local ASC, ce.id ASC
    `,
    vals
  );

  const dailyRows = await splitDailyOvertime(q.rows, start_date, end_date);
  let finalRows = splitWeeklyOvertime(dailyRows);

  finalRows = applyStatusFilters(finalRows, billed, paid);

  finalRows.sort((a, b) => {
    const aTime = getRowDateTime(a);
    const bTime = getRowDateTime(b);
    return aTime.localeCompare(bTime);
  });

  const workerSums = summarizeByWorker(finalRows);

  return { rows: finalRows, workerSums };
}

// =====================
// API routes
// =====================

// GET /api/payroll
router.get('/', async (req, res) => {
  try {
    const result = await getPayrollRows(req.query);
    res.json(result);
  } catch (e) {
    console.error('API /api/payroll error:', e);
    res.status(500).json({ error: e.message || e.toString() });
  }
});

// POST /api/payroll/bill
// Mark the whole session billed, not only one clock entry row.
router.post('/bill', async (req, res) => {
  const { entry_ids, billed_date } = req.body;

  if (!Array.isArray(entry_ids) || !billed_date) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    await pool.query(
      `
      UPDATE clock_entries
      SET billed = TRUE,
          billed_date = $1
      WHERE id = ANY($2::int[])
         OR session_id IN (
            SELECT session_id
            FROM clock_entries
            WHERE id = ANY($2::int[])
              AND session_id IS NOT NULL
         )
      `,
      [billed_date, entry_ids]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('API /api/payroll/bill error:', e);
    res.status(500).json({ error: e.message || e.toString() });
  }
});

// POST /api/payroll/paid
// Mark the whole session paid, not only one clock entry row.
router.post('/paid', async (req, res) => {
  const { entry_ids, paid_date } = req.body;

  if (!Array.isArray(entry_ids) || !paid_date) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    await pool.query(
      `
      UPDATE clock_entries
      SET paid = TRUE,
          paid_date = $1
      WHERE id = ANY($2::int[])
         OR session_id IN (
            SELECT session_id
            FROM clock_entries
            WHERE id = ANY($2::int[])
              AND session_id IS NOT NULL
         )
      `,
      [paid_date, entry_ids]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('API /api/payroll/paid error:', e);
    res.status(500).json({ error: e.message || e.toString() });
  }
});

// GET /api/payroll/export
router.get('/export', async (req, res) => {
  try {
    const { rows } = await getPayrollRows(req.query);

    const csv = [
      [
        'ID',
        'Session ID',
        'Worker',
        'Project',
        'In',
        'Out',
        'Regular Hrs',
        'OT Hrs',
        'OT Type',
        'Pay Rate',
        'Amount',
        'Billed',
        'Bill Date',
        'Paid',
        'Paid Date',
        'Clock In Note',
        'Clock Out Note'
      ].join(',')
    ];

    for (const row of rows) {
      csv.push(
        [
          row.id || '',
          row.session_id || '',
          csvValue(row.worker_name || ''),
          csvValue(row.project_name || ''),
          csvValue(row.datetime_local || ''),
          csvValue(row.datetime_out_local || ''),
          row.regular_time || 0,
          row.overtime || 0,
          csvValue(row.ot_type || ''),
          row.pay_rate ? Number(row.pay_rate).toFixed(2) : '',
          row.pay_amount ? Number(row.pay_amount).toFixed(2) : '',
          isTrue(row.billed) ? 'Yes' : 'No',
          csvValue(row.billed_date || ''),
          isTrue(row.paid) ? 'Yes' : 'No',
          csvValue(row.paid_date || ''),
          csvValue(row.note || ''),
          csvValue(row.clock_out_note || '')
        ].join(',')
      );
    }

    const now = new Date();
    const filename = `payroll_${String(now.getFullYear()).slice(2)}${String(
      now.getMonth() + 1
    ).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(
      now.getHours()
    ).padStart(2, '0')}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csv.join('\n'));
  } catch (e) {
    console.error('API /api/payroll/export error:', e);
    res.status(500).json({ error: e.message || e.toString() });
  }
});

module.exports = router;
