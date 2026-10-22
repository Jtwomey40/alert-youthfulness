const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

// GET /api/properties  — list, optional ?stage=, ?legacy_key=
router.get('/', asyncHandler(async (req, res) => {
  const { stage, legacy_key, address } = req.query;
  const clauses = [];
  const values = [];
  if (stage) { values.push(stage); clauses.push(`stage = $${values.length}`); }
  if (legacy_key) { values.push(legacy_key); clauses.push(`legacy_key = $${values.length}`); }
  if (address) { values.push(address); clauses.push(`address = $${values.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM properties ${where} ORDER BY address ASC`,
    values
  );
  res.json(rows);
}));

// GET /api/properties/:id — single property + its recaps
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const propResult = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
  if (!propResult.rows.length) return res.status(404).json({ error: 'not found' });
  const recapsResult = await pool.query(
    'SELECT * FROM call_recaps WHERE property_id = $1 ORDER BY meeting_date DESC',
    [id]
  );
  res.json({ ...propResult.rows[0], call_recaps: recapsResult.rows });
}));

// POST /api/properties — create
router.post('/', asyncHandler(async (req, res) => {
  const { address, stage, deal_url, agent_name, agent_phone, agent_email, legacy_key } = req.body;
  if (!address) return res.status(400).json({ error: 'address is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO properties (address, stage, deal_url, agent_name, agent_phone, agent_email, legacy_key)
       VALUES ($1, COALESCE($2,'Intake'), $3, $4, $5, $6, $7)
       RETURNING *`,
      [address, stage, deal_url, agent_name, agent_phone, agent_email, legacy_key]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'legacy_key already exists', detail: err.detail });
    throw err;
  }
}));

// PATCH /api/properties/:id — partial update (never overwrites with null unless explicitly passed)
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const fields = ['address', 'stage', 'deal_url', 'agent_name', 'agent_phone', 'agent_email', 'legacy_key'];
  const sets = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      sets.push(`${f} = $${values.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE properties SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// POST /api/properties/:id/recaps — add a call recap, dedup by title+date
router.post('/:id/recaps', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { meeting_title, meeting_date, summary } = req.body;
  if (!meeting_title || !meeting_date || !summary) {
    return res.status(400).json({ error: 'meeting_title, meeting_date, summary are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO call_recaps (property_id, meeting_title, meeting_date, summary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (property_id, meeting_title, meeting_date) DO NOTHING
     RETURNING *`,
    [id, meeting_title, meeting_date, summary]
  );
  if (!rows.length) return res.status(200).json({ message: 'recap already exists, skipped' });
  res.status(201).json(rows[0]);
}));

module.exports = router;
