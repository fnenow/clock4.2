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
function toDbDatetime(str) {
  return str.replace('T', ' ');
}
async function getPayRate(worker_id) {
  const q = await pool.query(
    "SELECT rate FROM pay_rates WHERE worker_id=$1 AND (end_date IS NULL OR end_date >= CURRENT_DATE) ORDER BY start_date DESC LIMIT 1",
    [worker_id]
  );
  return q.rows[0]?.rate || 0;
}

// CHANGED: This route is now /entries (NOT /api/clock-entries)
router.get('/entries', async (req, res) => {
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
  try {
    const already = await pool.query(
      `SELECT * FROM clock_entries
       WHERE worker_id = $1 AND project_id = $2 AND action = 'in'
       AND NOT EXISTS (
         SELECT 1 FROM clock_entries AS out
         WHERE out.session_id = clock_entries.session_id AND out.action = 'out'
       )`,
      [worker_id, project_id]
    );
    if (already.rows.length > 0)
      return res.status(400).json({ message: 'Already clocked in to this project' });

    const pay_rate = await getPayRate(worker_id);
    const session_id = uuidv4();
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
        (worker_id, project_id, action, datetime_utc, datetime_local, timezone_offset, note, pay_rate, session_id)
       VALUES 
        ($1, $2, 'in', $3, $4, $5, $6, $7, $8)`,
      [
        worker_id,
        project_id,
        datetimeUtcStr,
        datetimeLocalStr,
        timezone_offset,
        note,
        pay_rate,
        session_id
      ]
    );
    res.json({ success: true, session_id });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// CLOCK OUT
router.post('/out', async (req, res) => {
  const { worker_id, project_id, note, datetime_local, timezone_offset, session_id } = req.body;
  try {
    if (!session_id) return res.status(400).json({ message: "Missing session_id" });
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
    res.status(500).json({ message: e.message });
  }
});

// Force clock out by session_id (using the session_id string)
router.post('/force-clock-out-by-session/:session_id', async (req, res) => {
  const { session_id } = req.params;
  try {
    // Find the "in" entry for this session
    const q = await pool.query('SELECT * FROM clock_entries WHERE session_id = $1 AND action = $2', [session_id, 'in']);
    if (!q.rows.length) return res.status(404).send('Session not found');
    const entry = q.rows[0];

    // Check if already clocked out
    const outQ = await pool.query(
      'SELECT * FROM clock_entries WHERE session_id = $1 AND action = $2',
      [session_id, 'out']
    );
    if (outQ.rows.length) return res.status(400).send('Already clocked out');

    // Insert forced clock-out entry
    const now = new Date();
    now.setSeconds(0, 0);
    const pad = n => n < 10 ? '0' + n : n;
    const datetime_utc = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const localTime = new Date(now.getTime() + (entry.timezone_offset * 60 * 1000));
    const datetime_local = `${localTime.getFullYear()}-${pad(localTime.getMonth() + 1)}-${pad(localTime.getDate())} ${pad(localTime.getHours())}:${pad(localTime.getMinutes())}`;

    await pool.query(`
      INSERT INTO clock_entries
        (worker_id, project_id, action, datetime_utc, datetime_local, session_id, pay_rate, note, timezone_offset)
      VALUES
        ($1, $2, 'out', $3, $4, $5, $6, $7, $8)
    `, [
      entry.worker_id,
      entry.project_id,
      datetime_utc,
      datetime_local,
      entry.session_id,
      entry.pay_rate,
      '[forced clock-out]',
      entry.timezone_offset
    ]);
    res.sendStatus(200);
  } catch (e) {
    console.error('Error forcing clock-out:', e);
    res.status(500).send('Server error');
  }
});
// Force clock out by clock entry id (id of 'in' entry)
//router.post('/force-clock-out-by-entry/:id', async (req, res) => {
//  const { id } = req.params;
//  try {
//    // Find the "in" entry
//    const q = await pool.query('SELECT * FROM clock_entries WHERE id = $1', [id]);
//    if (!q.rows.length) return res.status(404).send('Entry not found');
//    const entry = q.rows[0];
//    if (entry.action !== 'in') return res.status(400).send('Not a clock-in entry');

    // Check if already clocked out
//    const outQ = await pool.query(
//      'SELECT * FROM clock_entries WHERE session_id = $1 AND action = $2',
//      [entry.session_id, 'out']
//    );
//    if (outQ.rows.length) return res.status(400).send('Already clocked out');

    // Insert forced clock-out entry
//    const now = new Date();
//    now.setSeconds(0, 0);
//    const pad = n => n < 10 ? '0' + n : n;
//    const datetime_utc = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
//    const localTime = new Date(now.getTime() + (entry.timezone_offset * 60 * 1000));
//    const datetime_local = `${localTime.getFullYear()}-${pad(localTime.getMonth() + 1)}-${pad(localTime.getDate())} ${pad(localTime.getHours())}:${pad(localTime.getMinutes())}`;

//    await pool.query(`
//      INSERT INTO clock_entries
//        (worker_id, project_id, action, datetime_utc, datetime_local, session_id, pay_rate, note, timezone_offset)
//      VALUES
//        ($1, $2, 'out', $3, $4, $5, $6, $7, $8)
//    `, [
//      entry.worker_id,
//      entry.project_id,
//      datetime_utc,
//      datetime_local,
//      entry.session_id,
//      entry.pay_rate,
//      '[forced clock-out]',
//      entry.timezone_offset
//    ]);
//    res.sendStatus(200);
//  } catch (e) {
//    console.error('Error forcing clock-out:', e);
//    res.status(500).send('Server error');
//  }
//});

// GET CURRENT CLOCK STATUS
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

module.exports = router;
