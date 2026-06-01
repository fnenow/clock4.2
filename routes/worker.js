const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../db');

// Utility: Extract last 5 digits from phone
function last5(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-5);
}

// --- Worker CRUD ---

// List all active workers, minimal fields
router.get('/all', async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT worker_id, name FROM workers WHERE inactive IS NOT TRUE ORDER BY name ASC`
    );

    res.json(q.rows);
  } catch (err) {
    console.error('Worker all error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List all workers, full fields
router.get('/list', async (req, res) => {
  try {
    const q = await pool.query('SELECT * FROM workers ORDER BY created_at DESC');
    res.json(q.rows);
  } catch (err) {
    console.error('Worker list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add worker
router.post('/', async (req, res) => {
  const { name, phone, start_date, note, worker_id: customId } = req.body;
  let worker_id = customId || last5(phone);

  if (!worker_id || worker_id.length < 3) {
    return res.status(400).json({ error: "Invalid worker ID" });
  }

  const password_hash = await bcrypt.hash(worker_id, 10);

  try {
    await pool.query(
      `INSERT INTO workers (worker_id, name, phone, start_date, note, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [worker_id, name, phone, start_date, note, password_hash]
    );

    res.json({ success: true, worker_id });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: "Worker ID already exists" });
    }

    res.status(500).json({ error: e.message });
  }
});

// Update worker info
router.put('/:worker_id', async (req, res) => {
  try {
    const { worker_id } = req.params;
    const { name, phone, start_date, end_date, note, inactive } = req.body;

    await pool.query(
      `UPDATE workers
       SET name=$1, phone=$2, start_date=$3, end_date=$4, note=$5, inactive=$6
       WHERE worker_id=$7`,
      [name, phone, start_date, end_date, note, !!inactive, worker_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Worker update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete worker
router.delete('/:worker_id', async (req, res) => {
  try {
    const { worker_id } = req.params;

    await pool.query('DELETE FROM workers WHERE worker_id=$1', [worker_id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Worker delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Worker/Project Assignment ---

// Get projects assigned to worker
router.get('/projects/:worker_id', async (req, res) => {
  try {
    const { worker_id } = req.params;

    const q = await pool.query(
      `SELECT p.*
       FROM projects p
       JOIN project_workers pw ON p.id = pw.project_id
       WHERE pw.worker_id=$1
         AND (p.hidden IS FALSE OR p.hidden IS NULL)`,
      [worker_id]
    );

    res.json(q.rows);
  } catch (err) {
    console.error('Worker projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Assign worker to project
router.post('/:worker_id/assign', async (req, res) => {
  try {
    const { worker_id } = req.params;
    const { project_id } = req.body;

    await pool.query(
      'INSERT INTO project_workers (project_id, worker_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [project_id, worker_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Worker assign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Unassign worker from project
router.post('/:worker_id/unassign', async (req, res) => {
  try {
    const { worker_id } = req.params;
    const { project_id } = req.body;

    await pool.query(
      'DELETE FROM project_workers WHERE project_id=$1 AND worker_id=$2',
      [project_id, worker_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Worker unassign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Auth and Session ---

// Worker login with 30-day session cookie
router.post('/login', async (req, res) => {
  try {
    const { worker_id, password } = req.body;

    if (!worker_id || !password) {
      return res.status(400).json({
        success: false,
        message: 'Worker ID and password required'
      });
    }

    const q = await pool.query(
      'SELECT * FROM workers WHERE worker_id = $1 AND inactive IS NOT TRUE LIMIT 1',
      [worker_id]
    );

    const worker = q.rows[0];

    if (!worker) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    const match = await bcrypt.compare(password, worker.password_hash);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: 'Invalid password'
      });
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error('Worker session regenerate error:', err);

        return res.status(500).json({
          success: false,
          message: 'Login failed'
        });
      }

      req.session.worker_id = worker.worker_id;
      req.session.worker_name = worker.name;
      req.session.user_type = 'worker';

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Worker session save error:', saveErr);

          return res.status(500).json({
            success: false,
            message: 'Login failed'
          });
        }

        return res.json({
          success: true,
          worker: {
            worker_id: worker.worker_id,
            name: worker.name
          },
          redirectTo: '/timeclock.html'
        });
      });
    });
  } catch (err) {
    console.error('Worker login error:', err);

    res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
});

// Check worker login status
router.get('/me', (req, res) => {
  if (!req.session || !req.session.worker_id) {
    return res.status(401).json({
      success: false,
      loggedIn: false,
      message: 'Not logged in'
    });
  }

  return res.json({
    success: true,
    loggedIn: true,
    worker: {
      worker_id: req.session.worker_id,
      name: req.session.worker_name
    }
  });
});

// Logout
router.post('/logout', (req, res) => {
  if (!req.session) {
    return res.json({ success: true });
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('Worker logout error:', err);

      return res.status(500).json({
        success: false,
        message: 'Logout failed'
      });
    }

    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

// --- Password Management ---

// Change password
router.post('/change-password', async (req, res) => {
  try {
    const { worker_id, old_password, new_password } = req.body;

    if (!worker_id || !old_password || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Missing password information'
      });
    }

    if (req.session && req.session.worker_id && String(req.session.worker_id) !== String(worker_id)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden'
      });
    }

    const q = await pool.query(
      'SELECT * FROM workers WHERE worker_id=$1',
      [worker_id]
    );

    const worker = q.rows[0];

    if (!worker) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    const match = await bcrypt.compare(old_password, worker.password_hash);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: 'Old password incorrect'
      });
    }

    const newHash = await bcrypt.hash(new_password, 10);

    await pool.query(
      'UPDATE workers SET password_hash=$1 WHERE worker_id=$2',
      [newHash, worker_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Worker change password error:', err);

    res.status(500).json({
      success: false,
      message: 'Password change failed'
    });
  }
});

module.exports = router;
