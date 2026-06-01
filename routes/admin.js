const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../db');

const { requireAdminLogin } = require('../middleware/sessionAuth');

// Admin login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password required'
      });
    }

    const q = await pool.query(
      'SELECT * FROM admin_users WHERE username = $1 LIMIT 1',
      [username]
    );

    const admin = q.rows[0];

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    const match = await bcrypt.compare(password, admin.password_hash);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: 'Invalid password'
      });
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error('Admin session regenerate error:', err);
        return res.status(500).json({
          success: false,
          message: 'Login failed'
        });
      }

      req.session.admin = admin.username;
      req.session.admin_id = admin.id || null;
      req.session.user_type = 'admin';

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Admin session save error:', saveErr);
          return res.status(500).json({
            success: false,
            message: 'Login failed'
          });
        }

        return res.json({
          success: true,
          username: admin.username,
          redirectTo: '/dashboard.html'
        });
      });
    });
  } catch (err) {
    console.error('Admin login error:', err);

    return res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
});

// Check admin login status
router.get('/me', (req, res) => {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({
      success: false,
      loggedIn: false,
      message: 'Not logged in'
    });
  }

  return res.json({
    success: true,
    loggedIn: true,
    admin: {
      username: req.session.admin,
      admin_id: req.session.admin_id || null,
      user_type: 'admin'
    }
  });
});

// Admin logout
router.post('/logout', (req, res) => {
  if (!req.session) {
    return res.json({ success: true });
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('Admin logout error:', err);

      return res.status(500).json({
        success: false,
        message: 'Logout failed'
      });
    }

    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

// List clocked-out sections
router.get('/clocked-out', requireAdminLogin, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT 
        cin.worker_id,
        cin.project_id,
        w.name as worker_name,
        p.name as project_name,
        cin.datetime_local as clock_in_time,
        cout.datetime_local as clock_out_time,
        cin.note as clock_in_note,
        cout.note as clock_out_note,
        cin.pay_rate,
        cout.admin_forced_by,
        cin.session_id,
        EXTRACT(EPOCH FROM (
          CAST(cout.datetime_utc AS timestamp) - CAST(cin.datetime_utc AS timestamp)
        )) AS duration_sec
      FROM clock_entries cin
      JOIN clock_entries cout
        ON cin.worker_id = cout.worker_id
        AND cin.project_id = cout.project_id
        AND cin.session_id = cout.session_id
        AND cin.action = 'in'
        AND cout.action = 'out'
        AND cout.datetime_utc > cin.datetime_utc
      JOIN workers w ON cin.worker_id = w.worker_id
      JOIN projects p ON cin.project_id = p.id
      WHERE NOT EXISTS (
        SELECT 1 FROM clock_entries c2
        WHERE c2.worker_id = cin.worker_id
          AND c2.project_id = cin.project_id
          AND c2.session_id = cin.session_id
          AND c2.action = 'out'
          AND c2.datetime_utc > cin.datetime_utc
          AND c2.datetime_utc < cout.datetime_utc
      )
      ORDER BY cout.datetime_utc DESC
      LIMIT 100
    `);

    res.json(q.rows);
  } catch (err) {
    console.error('Admin clocked-out error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
