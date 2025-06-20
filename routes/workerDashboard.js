const express = require('express');
const router = express.Router();
const pool = require('../db');

function requireWorkerLogin(req, res, next) {
  if (req.session && req.session.worker_id) {
    return next();
  }
  res.status(401).json({ message: "Not logged in" });
}
router.use(requireWorkerLogin);

router.get('/entries', async (req, res) => {
  const worker_id = req.session.worker_id;
  // ... fetch and respond with only this worker's sessions ...
});
// GET /api/worker-dashboard/entries?worker_id=xxx
router.get('/entries', async (req, res) => {
  const worker_id = req.query.worker_id;
  if (!worker_id) return res.status(400).json({ message: "worker_id required" });

  const q = await pool.query(`
    SELECT ce.*, w.name AS worker_name, p.name AS project_name
    FROM clock_entries ce
    LEFT JOIN workers w ON ce.worker_id = w.worker_id
    LEFT JOIN projects p ON ce.project_id = p.id
    WHERE ce.worker_id = $1
    ORDER BY ce.datetime_local ASC
  `, [worker_id]);
  res.json(q.rows);
});

// PATCH (edit note) /api/worker-dashboard/entries/:id
router.patch('/entries/:id', async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;
  if (note === undefined) return res.status(400).json({ message: "No note provided" });
  await pool.query('UPDATE clock_entries SET note = $1 WHERE id = $2', [note, id]);
  res.json({ success: true });
});

module.exports = router;
