const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

// GET /api/dealio-notes/pending — unsynced queue rows, oldest first. This is what gets read
// (today, manually by Claude through the DealioDesk connector; later possibly by a scheduled
// task) to flush notes into DealioDesk's actual notes feed via TransactionNotes.Create.
router.get('/pending', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, property_id, dealio_deal_id, address, reason, note_text, created_at
     FROM dealio_note_queue WHERE synced_at IS NULL ORDER BY created_at ASC`
  );
  res.json(rows);
}));

// POST /api/dealio-notes/mark-synced — body: { ids: [1,2,3] }. Called once each queued note
// has actually been written into DealioDesk, so it isn't sent again on the next flush.
router.post('/mark-synced', asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  if (!ids || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
  const { rowCount } = await pool.query(
    `UPDATE dealio_note_queue SET synced_at = now() WHERE id = ANY($1::int[]) AND synced_at IS NULL`,
    [ids]
  );
  res.json({ marked: rowCount });
}));

module.exports = router;
