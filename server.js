require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db/pool');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/properties', require('./routes/properties'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/insights', require('./routes/insights'));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 404 for unmatched API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Global error handler — catches anything forwarded by asyncHandler so a DB
// error (or any other thrown error) returns a clean 500 instead of crashing
// the whole process.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`alert-youthfulness listening on port ${PORT}`));
