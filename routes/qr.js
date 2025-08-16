const express = require('express');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const pool = require('../db'); // same as your other routes

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'supersecret';
const BASE_URL = 'https://clock.fnesignal.com/clockin_qr.html';

// --- Generate tokenized worker link ---
function makeWorkerLink(workerId) {
  const token = jwt.sign({ workerId }, SECRET, { expiresIn: '90d' });
  return `${BASE_URL}?token=${token}`;
}

// --- GET JSON link ---
router.get('/generate-worker-link/:id', (req, res) => {
  const link = makeWorkerLink(req.params.id);
  res.json({ link });
});

// --- GET QR PNG ---
router.get('/generate-worker-qr/:id', async (req, res) => {
  try {
    const link = makeWorkerLink(req.params.id);
    const png = await QRCode.toBuffer(link, { width: 300, errorCorrectionLevel: 'H', margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'QR code generation failed' });
  }
});

// --- Worker info endpoint (resolve token or last 5 digits) ---
router.get('/worker-info', async (req, res) => {
  const { code, token } = req.query;
  try {
    if (token) {
      const { workerId } = jwt.verify(token, SECRET);
      const r = await pool.query('SELECT id, name FROM workers WHERE id=$1 LIMIT 1', [workerId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Worker not found' });
      return res.json(r.rows[0]);
    }

    if (code) {
      const r = await pool.query(
        'SELECT id, name FROM workers WHERE RIGHT(phone_number,5)=$1 LIMIT 1',
        [code]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Worker not found' });
      return res.json(r.rows[0]);
    }

    return res.status(400).json({ error: 'Missing token or code' });
  } catch (err) {
    console.error(err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

module.exports = router;
