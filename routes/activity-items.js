const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

// GET /api/activity-items — list, optional ?status=new|snoozed|handled.
// Before reading, auto-reopens any snooze whose snoozed_until has passed, so a snoozed
// item lands back in the "New" column on its own without a separate scheduled task.
router.get('/', asyncHandler(async (req, res) => {
  await pool.query(
    `UPDATE activity_items SET status = 'new', snoozed_until = NULL
     WHERE status = 'snoozed' AND snoozed_until <= now()`
  );

  const { status } = req.query;
  const clauses = [];
  const values = [];
  if (status) { values.push(status); clauses.push(`ai.status = $${values.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT ai.id, ai.property_id, p.address, p.stage, ai.source, ai.summary, ai.source_url,
            ai.occurred_at, ai.status, ai.snoozed_until, ai.handled_at
     FROM activity_items ai
     JOIN properties p ON p.id = ai.property_id
     ${where}
     ORDER BY ai.occurred_at DESC`,
    values
  );
  res.json(rows);
}));

// POST /api/activity-items — create a new pending item for a property.
// Accepts either property_id directly, or dealio_deal_id to resolve it.
router.post('/', asyncHandler(async (req, res) => {
  const { property_id, dealio_deal_id, source, summary, source_url, occurred_at, source_ref } = req.body;

  if (!source || !['slack', 'zoom'].includes(source)) {
    return res.status(400).json({ error: "source is required and must be 'slack' or 'zoom'" });
  }
  if (!summary) {
    return res.status(400).json({ error: 'summary is required' });
  }

  let resolvedPropertyId = property_id || null;
  if (!resolvedPropertyId && dealio_deal_id) {
    const propResult = await pool.query('SELECT id FROM properties WHERE dealio_deal_id = $1', [dealio_deal_id]);
    if (!propResult.rows.length) return res.status(404).json({ error: 'no property found for that dealio_deal_id' });
    resolvedPropertyId = propResult.rows[0].id;
  }
  if (!resolvedPropertyId) {
    return res.status(400).json({ error: 'property_id (or dealio_deal_id) is required' });
  }

  const { rows } = await pool.query(
    `INSERT INTO activity_items (property_id, source, source_ref, summary, source_url, occurred_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
     RETURNING *`,
    [resolvedPropertyId, source, source_ref || null, summary, source_url || null, occurred_at || null]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/activity-items/:id — handle / snooze / reopen an item.
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action, snoozed_until } = req.body;

  let query;
  let values;
  if (action === 'handle') {
    query = `UPDATE activity_items SET status = 'handled', handled_at = now() WHERE id = $1 RETURNING *`;
    values = [id];
  } else if (action === 'snooze') {
    if (!snoozed_until) return res.status(400).json({ error: 'snoozed_until is required to snooze' });
    query = `UPDATE activity_items SET status = 'snoozed', snoozed_until = $2 WHERE id = $1 RETURNING *`;
    values = [id, snoozed_until];
  } else if (action === 'reopen') {
    query = `UPDATE activity_items SET status = 'new', snoozed_until = NULL, handled_at = NULL WHERE id = $1 RETURNING *`;
    values = [id];
  } else {
    return res.status(400).json({ error: "action must be 'handle', 'snooze', or 'reopen'" });
  }

  const { rows } = await pool.query(query, values);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

module.exports = router;
