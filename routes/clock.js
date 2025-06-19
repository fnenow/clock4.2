const express = require('express');
const router = express.Router();
const pool = require('../db');
const { v4: uuidv4 } = require('uuid');

// Helper for formatting as Postgres 'YYYY-MM-DD HH:MM'
function pad(n) { return n < 10 ? '0' + n : n; }
function formatDateTime(date) {
  return (
    date.getFullYear() + '-' +
    pad(date.getMonth() + 1) + '-' +
    pad(date.getDate()) + ' ' +
    pad(date.getHours()) + ':' +
    pad(date.getMinutes())
  );
}

// Convert HTML5 local datetime string ("YYYY-MM-DDTHH:mm") to Postgres compatible ("YYYY-MM-DD HH:mm")
function toDbDatetime(str) {
  return str.replace('T', ' ');
}

// Helper: Get current pay rate for worker
async function getPayRate(worker_id) {
  const q = await pool.query(
    "SELECT rate FROM pay_rates WHERE worker_id=$1 AND (end_date IS NULL OR end_date >= CURRENT_DATE) ORDER BY start_date DESC LIMIT 1",
    [worker_id]
  );
  return q.rows[0]?.rate || 0;
}
// GET /api/clock-entries
router.get('/api/clock-entries', async (req, res) => {
  const q = await pool.query(`
    SELECT
      ce.*,
      w.name AS worker_name,
      p.name AS project_name
    FROM clock_entries ce
    LEFT JOIN workers w ON ce.worker_id = w.worker_id
    LEFT JOIN projects p ON ce.project_id = p.id
    ORDER BY ce.datetime_local ASC
  `);
  res.json(q.rows);
});

// CLOCK IN
router.post('/in', async (req, res) => {
  const { worker_id, project_id, note, datetime_local, timezone_offset } = req.body;
  console.log('[CLOCK IN] Received:', { datetime_local, timezone_offset });
  try {
    // Prevent double clock-in
    const already = await pool.query(
      `SELECT * FROM clock_entries
       WHERE worker_id=$1 AND project_id=$2 AND action='in'
       AND NOT EXISTS (
         SELECT 1 FROM clock_entries AS out
         WHERE out.worker_id=$1 AND out.project_id=$2 AND out.action='out' AND out.datetime_local > clock_entries.datetime_local
       )`,
      [worker_id, project_id]
    );
    if (already.rows.length > 0)
      return res.status(400).json({ message: 'Already clocked in to this project' });

    const pay_rate = await getPayRate(worker_id);
    const session_id = uuidv4();

    // -- Write user input directly as local wall time (converted for Postgres)
    let datetimeLocalStr = toDbDatetime(datetime_local);

    // -- Calculate UTC time in JS only
    let [datePart, timePart] = datetime_local.split('T');
    let [year, month, day] = datePart.split('-').map(Number);
    let [hour, minute] = timePart.split(':').map(Number);

    // JS months are 0-based!
    let dtMillis = Date.UTC(year, month - 1, day, hour, minute);
    // Subtract offset (in minutes) to get UTC time
    let dtUtcMillis = dtMillis - timezone_offset * 60000;
    let dtUtc = new Date(dtUtcMillis);
    let datetimeUtcStr = formatDateTime(dtUtc);

    // Save both strings directly to Postgres
    await pool.query(
      `INSERT INTO clock_entries 
        (worker_id, project_id, action, datetime_utc, datetime_local, timezone_offset, note, pay_rate, session_id)
       VALUES 
        ($1, $2, 'in', $3, $4, $5, $6, $7, $8)`,
      [
        worker_id,
        project_id,
        datetimeUtcStr,     // For Postgres timestamp
        datetimeLocalStr,   // For Postgres timestamp
        timezone_offset,
        note,
        pay_rate,
        session_id
      ]
    );
    res.json({ success: true, session_id });
  } catch (e) {
    console.error('[CLOCK IN ERROR]', e);
    res.status(500).json({ message: e.message });
  }
});

// CLOCK OUT (same technique)
router.post('/out', async (req, res) => {
  const { worker_id, project_id, note, datetime_local, timezone_offset, session_id } = req.body;
  console.log('[CLOCK OUT] Received:', { datetime_local, timezone_offset });
  try {
    if (!session_id) return res.status(400).json({ message: "Missing session_id" });

    // Make sure there's an open clock-in session
    const { rows } = await pool.query(
      `SELECT * FROM clock_entries WHERE worker_id=$1 AND project_id=$2 AND session_id=$3 AND action='in'
       AND NOT EXISTS (
         SELECT 1 FROM clock_entries AS out
         WHERE out.session_id=$3 AND out.action='out'
       )`,
      [worker_id, project_id, session_id]
    );
    if (!rows.length) return res.status(400).json({ message: "No matching open clock-in session found" });

    let datetimeLocalStr = toDbDatetime(datetime_local);
    let [datePart, timePart] = datetime_local.split('T');
    let [year, month, day] = datePart.split('-').map(Number);
    let [hour, minute] = timePart.split(':').map(Number);
    let dtMillis = Date.UTC(year, month - 1, day, hour, minute);
    let dtUtcMillis = dtMillis - timezone_offset * 60000;
    let dtUtc = new Date(dtUtcMillis);
    let datetimeUtcStr = formatDateTime(dtUtc);

    await pool.query(
      `INSERT INTO clock_entries 
        (worker_id, project_id, action, datetime_utc, datetime_local, timezone_offset, note, session_id)
       VALUES 
        ($1, $2, 'out', $3, $4, $5, $6, $7)`,
      [
        worker_id,
        project_id,
        datetimeUtcStr,
        datetimeLocalStr,
        timezone_offset,
        note,
        session_id
      ]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[CLOCK OUT ERROR]', e);
    res.status(500).json({ message: e.message });
  }
});

// POST /api/clock-entries/:id/force-clock-out
router.post('/api/clock-entries/:id/force-clock-out', async (req, res) => {
  const id = req.params.id;
  try {
    // Find the original "in" entry to get worker, project, session, pay_rate, and timezone_offset
    const q = await pool.query('SELECT * FROM clock_entries WHERE id = $1', [id]);
    if (!q.rows.length) return res.status(404).send('Entry not found');
    const entry = q.rows[0];
    if (entry.action !== 'in') return res.status(400).send('Not a clock-in entry');

    // Get necessary fields
    const { worker_id, project_id, pay_rate, session_id, timezone_offset } = entry;

    // 1. Get current UTC time (to the minute)
    const now = new Date();
    now.setSeconds(0, 0); // Zero out seconds and ms for "to the minute"
    const pad = n => n < 10 ? '0' + n : n;
    const datetime_utc = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // 2. Calculate datetime_local by subtracting timezone_offset (in minutes) from UTC
    const localTime = new Date(now.getTime() + (timezone_offset * 60 * 1000));
    const datetime_local = `${localTime.getFullYear()}-${pad(localTime.getMonth() + 1)}-${pad(localTime.getDate())} ${pad(localTime.getHours())}:${pad(localTime.getMinutes())}`;

    await pool.query(`
      INSERT INTO clock_entries
        (worker_id, project_id, action, datetime_utc, datetime_local, session_id, pay_rate, note, timezone_offset)
      VALUES
        ($1, $2, 'out', $3, $4, $5, $6, $7, $8)
    `, [
      worker_id,
      project_id,
      datetime_utc,
      datetime_local,
      session_id,
      pay_rate,
      '[forced clock-out]',
      timezone_offset
    ]);

    res.sendStatus(200);
  } catch (err) {
    console.error('Error forcing clock-out:', err);
    res.status(500).send('Server error');
  }
});

// GET CURRENT CLOCK STATUS (no changes needed)
router.get('/status/:worker_id', async (req, res) => {
  const { worker_id } = req.params;
  const q = await pool.query(
    `SELECT * FROM clock_entries
     WHERE worker_id=$1 AND action='in'
     AND NOT EXISTS (
       SELECT 1 FROM clock_entries AS out
       WHERE out.worker_id=$1 AND out.project_id=clock_entries.project_id AND out.session_id=clock_entries.session_id AND out.action='out'
     )
     ORDER BY datetime_utc DESC LIMIT 1`,
    [worker_id]
  );
  res.json(q.rows[0] || {});
});

// ADMIN FORCE CLOCK OUT (uses current server time)
router.post('/force-out', async (req, res) => {
  const { worker_id, project_id, admin_name } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM clock_entries
       WHERE worker_id=$1 AND project_id=$2 AND action='in'
       AND NOT EXISTS (
         SELECT 1 FROM clock_entries AS out
         WHERE out.worker_id=$1 AND out.project_id=$2 AND out.session_id=clock_entries.session_id AND out.action='out'
       )
       ORDER BY datetime_local DESC
       LIMIT 1
      `, [worker_id, project_id]
    );
    if (!rows.length) return res.status(400).json({ message: "No active clock-in session found" });

    const clockIn = rows[0];
    // Use current UTC/server time for UTC, and convert to wall time using offset
    const nowUtc = new Date();
    const nowLocal = new Date(nowUtc.getTime() + clockIn.timezone_offset * 60000);

    let datetimeLocalStr = formatDateTime(nowLocal);
    let datetimeUtcStr = formatDateTime(nowUtc);

    await pool.query(
      `INSERT INTO clock_entries
         (worker_id, project_id, action, datetime_utc, datetime_local, timezone_offset, note, admin_forced_by, session_id)
       VALUES
         ($1, $2, 'out', $3, $4, $5, $6, $7, $8)`,
      [
        worker_id,
        project_id,
        datetimeUtcStr,
        datetimeLocalStr,
        clockIn.timezone_offset,
        'Admin forced clock out',
        admin_name,
        clockIn.session_id
      ]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[ADMIN FORCE CLOCK OUT ERROR]', e);
    res.status(500).json({ message: e.message });
  }
});

// PATCH /api/clock-entries/:id
router.patch('/api/clock-entries/:id', async (req, res) => {
  const { id } = req.params;
  const { project_name, datetime_local, note } = req.body;
  try {
    if (project_name) {
      // Update project by name (lookup ID)
      const pq = await pool.query('SELECT id FROM projects WHERE name = $1', [project_name]);
      if (!pq.rows.length) return res.status(400).json({ message: 'Project not found' });
      await pool.query('UPDATE clock_entries SET project_id = $1 WHERE id = $2', [pq.rows[0].id, id]);
    }
    if (datetime_local) {
      // Fetch timezone_offset
      const q = await pool.query('SELECT timezone_offset FROM clock_entries WHERE id = $1', [id]);
      if (!q.rows.length) return res.status(404).json({ message: 'Entry not found' });
      const { timezone_offset } = q.rows[0];
      // Parse local datetime and update utc
      const [datePart, timePart] = datetime_local.split(' ');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hour, minute] = timePart.split(':').map(Number);
      const dtMillis = Date.UTC(year, month - 1, day, hour, minute);
      const dtUtcMillis = dtMillis - timezone_offset * 60000;
      const dtUtc = new Date(dtUtcMillis);
      const pad = n => n < 10 ? '0' + n : n;
      const datetime_utc = `${dtUtc.getFullYear()}-${pad(dtUtc.getMonth() + 1)}-${pad(dtUtc.getDate())} ${pad(dtUtc.getHours())}:${pad(dtUtc.getMinutes())}`;
      await pool.query('UPDATE clock_entries SET datetime_local = $1, datetime_utc = $2 WHERE id = $3', [datetime_local, datetime_utc, id]);
    }
    if (note !== undefined) {
      await pool.query('UPDATE clock_entries SET note = $1 WHERE id = $2', [note, id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/clock-entries/:id', err);
    res.status(500).json({ message: 'Error updating entry' });
  }
});


module.exports = router;
