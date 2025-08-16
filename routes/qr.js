const express = require('express');
const pool = require('../db');

const router = express.Router();

// --- Fetch worker info by worker_id ---
router.get('/worker-info', async (req, res) => {
  const { worker_id } = req.query;
  if (!worker_id) return res.status(400).json({ error: 'Missing worker_id' });

  try {
    const r = await pool.query(
      'SELECT worker_id, name FROM workers WHERE worker_id=$1 LIMIT 1',
      [worker_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Worker not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
