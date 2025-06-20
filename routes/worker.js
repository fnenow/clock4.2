const bcrypt = require('bcrypt'); // Add this at the top
const express = require('express');
const router = express.Router();
const pool = require('../db');

// POST /api/worker/login
router.post('/login', async (req, res) => {
  const { worker_id, password } = req.body;
  const q = await pool.query('SELECT * FROM workers WHERE worker_id = $1', [worker_id]);
  const worker = q.rows[0];
  if (worker) {
    // Compare using bcrypt
    const match = await bcrypt.compare(password, worker.password_hash); // or password_hash if that's the actual name
    if (match) {
      req.session.worker_id = worker.worker_id;
      req.session.worker_name = worker.name;
      res.json({ success: true, worker: { worker_id: worker.worker_id, name: worker.name } });
      return;
    }
  }
  res.status(401).json({ message: "Invalid login" });
});

// POST /api/worker/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// GET /api/worker/projects/:worker_id
router.get('/projects/:worker_id', async (req, res) => {
  // Example: list all projects for user
  const q = await pool.query(
    `SELECT p.id, p.name
     FROM projects p
     JOIN project_workers wp ON p.id = wp.project_id
     WHERE wp.worker_id = $1`,
    [req.params.worker_id]
  );
  res.json(q.rows);
});

// POST /api/worker/change-password
router.post('/change-password', async (req, res) => {
  const { worker_id, old_password, new_password } = req.body;
  const q = await pool.query('SELECT * FROM workers WHERE worker_id = $1 AND password_harsh = $2', [worker_id, old_password]);
  const worker = q.rows[0];
  if (!worker) return res.status(401).json({ message: "Incorrect old password" });
  await pool.query('UPDATE workers SET password = $1 WHERE worker_id = $2', [new_password, worker_id]);
  res.json({ success: true });
});

module.exports = router;
