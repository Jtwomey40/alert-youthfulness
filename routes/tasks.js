const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

// GET /api/tasks — list with optional filters: status, due_before, source, dealio_task_id, property_id
router.get('/', asyncHandler(async (req, res) => {
  const { status, due_before, source, dealio_task_id, property_id } = req.query;
  const clauses = [];
  const values = [];
  if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
  if (due_before) { values.push(due_before); clauses.push(`due <= $${values.length}`); }
  if (source) { values.push(source); clauses.push(`source = $${values.length}`); }
  if (dealio_task_id) { values.push(dealio_task_id); clauses.push(`dealio_task_id = $${values.length}`); }
  if (property_id) { values.push(property_id); clauses.push(`property_id = $${values.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM tasks ${where} ORDER BY due ASC NULLS LAST, priority ASC`,
    values
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// POST /api/tasks — create
router.post('/', asyncHandler(async (req, res) => {
  const {
    title, status, priority, due, project, property_id,
    source, dealio_task_id, dealio_task_type, legacy_id, steps
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (title, status, priority, due, project, property_id, source, dealio_task_id, dealio_task_type, legacy_id, steps)
       VALUES ($1, COALESCE($2,'todo'), COALESCE($3,'medium'), $4, $5, $6, COALESCE($7,'auto'), $8, $9, $10, COALESCE($11,'[]'::jsonb))
       RETURNING *`,
      [title, status, priority, due, project, property_id, source, dealio_task_id, dealio_task_type, legacy_id, JSON.stringify(steps || [])]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'dealio_task_id already exists', detail: err.detail });
    throw err;
  }
}));

// PATCH /api/tasks/:id — partial update; setting status to 'done' auto-stamps completed_at unless provided
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const fields = ['title', 'status', 'priority', 'due', 'project', 'property_id', 'source', 'dealio_task_id', 'dealio_task_type', 'legacy_id', 'steps', 'completed_at'];
  const sets = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      values.push(f === 'steps' ? JSON.stringify(req.body[f]) : req.body[f]);
      sets.push(`${f} = $${values.length}`);
    }
  }
  if (req.body.status === 'done' && req.body.completed_at === undefined) {
    sets.push('completed_at = now()');
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

module.exports = router;
