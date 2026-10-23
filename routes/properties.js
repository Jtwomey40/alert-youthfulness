const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

// GET /api/properties  — list, optional ?stage=, ?legacy_key=, ?address=
// Also returns last_recap_date / recap_count / stage_since per property so the
// dashboard can flag stale deals without an extra round trip per row.
router.get('/', asyncHandler(async (req, res) => {
  const { stage, legacy_key, address } = req.query;
  const clauses = [];
  const values = [];
  if (stage) { values.push(stage); clauses.push(`p.stage = $${values.length}`); }
  if (legacy_key) { values.push(legacy_key); clauses.push(`p.legacy_key = $${values.length}`); }
  if (address) { values.push(address); clauses.push(`p.address = $${values.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT p.*,
       recaps.last_recap_date,
       COALESCE(recaps.recap_count, 0) AS recap_count,
       COALESCE(hist.last_stage_change, p.created_at) AS stage_since
     FROM properties p
     LEFT JOIN (
       SELECT property_id, MAX(meeting_date) AS last_recap_date, COUNT(*)::int AS recap_count
       FROM call_recaps GROUP BY property_id
     ) recaps ON recaps.property_id = p.id
     LEFT JOIN (
       SELECT property_id, MAX(changed_at) AS last_stage_change
       FROM stage_history GROUP BY property_id
     ) hist ON hist.property_id = p.id
     ${where}
     ORDER BY p.address ASC`,
    values
  );
  res.json(rows);
}));

// GET /api/properties/:id — single property + its recaps + its stage history
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const propResult = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
  if (!propResult.rows.length) return res.status(404).json({ error: 'not found' });
  const recapsResult = await pool.query(
    'SELECT * FROM call_recaps WHERE property_id = $1 ORDER BY meeting_date DESC',
    [id]
  );
  const historyResult = await pool.query(
    'SELECT * FROM stage_history WHERE property_id = $1 ORDER BY changed_at DESC',
    [id]
  );
  res.json({ ...propResult.rows[0], call_recaps: recapsResult.rows, stage_history: historyResult.rows });
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

// PATCH /api/properties/:id — partial update (never overwrites with null unless explicitly passed).
// If `stage` is changing, logs the transition to stage_history for the activity feed / insights.
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const fields = ['address', 'stage', 'deal_url', 'agent_name', 'agent_phone', 'agent_email', 'legacy_key', 'called_at'];
  const sets = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      sets.push(`${f} = $${values.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });

  let previousStage = null;
  if (req.body.stage !== undefined) {
    const current = await pool.query('SELECT stage FROM properties WHERE id = $1', [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'not found' });
    previousStage = current.rows[0].stage;
    // Changing stage resets the "called them" checkbox, unless this same request
    // is explicitly setting called_at itself.
    if (req.body.called_at === undefined && req.body.stage !== previousStage) {
      values.push(null);
      sets.push(`called_at = $${values.length}`);
    }
  }

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE properties SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });

  if (req.body.stage !== undefined && req.body.stage !== previousStage) {
    await pool.query(
      `INSERT INTO stage_history (property_id, from_stage, to_stage) VALUES ($1, $2, $3)`,
      [id, previousStage, req.body.stage]
    );
  }

  res.json(rows[0]);
}));

// DELETE /api/properties/:id — permanently removes the property (e.g. "not enough equity").
// call_recaps and stage_history cascade-delete; tasks keep their row but property_id is set
// to NULL (see schema), so nothing else breaks.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM properties WHERE id = $1 RETURNING id', [id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
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

// POST /api/properties/:id/log-call — manual "I just got off a call" entry point for the dashboard UI.
// Creates a call recap (same dedup rule as /recaps) and, optionally, one or more follow-up tasks
// in the same request, each linked back to the recap via recap_id for traceability.
router.post('/:id/log-call', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { meeting_title, meeting_date, summary, follow_up_tasks } = req.body;
  if (!meeting_title || !meeting_date || !summary) {
    return res.status(400).json({ error: 'meeting_title, meeting_date, summary are required' });
  }
  const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [id]);
  if (!propCheck.rows.length) return res.status(404).json({ error: 'property not found' });

  const insertResult = await pool.query(
    `INSERT INTO call_recaps (property_id, meeting_title, meeting_date, summary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (property_id, meeting_title, meeting_date) DO NOTHING
     RETURNING *`,
    [id, meeting_title, meeting_date, summary]
  );
  let recap = insertResult.rows[0];
  let recapWasNew = true;
  if (!recap) {
    recapWasNew = false;
    const existing = await pool.query(
      `SELECT * FROM call_recaps WHERE property_id = $1 AND meeting_title = $2 AND meeting_date = $3`,
      [id, meeting_title, meeting_date]
    );
    recap = existing.rows[0];
  }

  const createdTasks = [];
  for (const t of (follow_up_tasks || [])) {
    if (!t || !t.title) continue;
    const { rows } = await pool.query(
      `INSERT INTO tasks (title, status, priority, due, project, property_id, source, dealio_task_type, legacy_id, steps, recap_id)
       VALUES ($1, 'todo', COALESCE($2,'medium'), $3, $4, $5, 'manual', NULL, NULL, '[]'::jsonb, $6)
       RETURNING *`,
      [t.title, t.priority, t.due || null, t.project || null, id, recap ? recap.id : null]
    );
    createdTasks.push(rows[0]);
  }

  res.status(recapWasNew ? 201 : 200).json({
    recap,
    recap_was_new: recapWasNew,
    tasks: createdTasks
  });
}));

module.exports = router;
