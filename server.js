const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
require('dotenv').config();

const pool = require('./db');

// --- 1) Create app ---
const app = express();

// --- 2) Middleware ---
app.use(cors());
app.use(express.json());

app.use(session({
  store: new pgSession({ pool }),
  secret: process.env.SESSION_SECRET || 'changeme',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30*24*60*60*1000 } // 30 days
}));

// --- 3) Import routes AFTER app initialization ---
const clockRoutes = require('./routes/clock');
const workerRoutes = require('./routes/worker');
const projectRouter = require('./routes/project');
const payrateRoutes = require('./routes/payrate');
const adminRoutes = require('./routes/admin');
const payrollRoutes = require('./routes/payroll');
const workerDashboardRoutes = require('./routes/workerDashboard');
const qrRoutes = require('./routes/qr'); // QR endpoints

// --- 4) Mount routes ---
app.use('/api/clock', clockRoutes);
app.use('/api/worker', workerRoutes);
app.use('/api/projects', projectRouter);
app.use('/api/payrate', payrateRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/worker-dashboard', workerDashboardRoutes);
app.use('/api/qr', qrRoutes); // <-- QR routes mounted here

// --- 5) Alias & special routes (existing) ---
app.post('/api/clock-entries/:session_id/force-clock-out', (req, res, next) => {
  req.url = '/force-clock-out-by-session/' + req.params.session_id;
  clockRoutes(req, res, next);
});

app.use('/api/clock-entries', (req, res, next) => {
  req.url = '/entries' + req.url.substring('/api/clock-entries'.length);
  clockRoutes(req, res, next);
});

// --- 6) Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- 7) Default route ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'timeclock.html'));
});

// --- 8) 404 handler ---
app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

// --- 9) Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FNE Time Clock server running on ${PORT}`));
