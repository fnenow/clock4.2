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
