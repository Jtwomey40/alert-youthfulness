const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

// GET /api/properties  — list, optional ?stage=, ?legacy_key=, ?address=, ?assigned_to_me=true|false,
// ?dealio_stage=, ?dealio_deal_id=, ?archived=true|all (default: excludes archived properties),
// ?recap_search=<text> (matches against that property's call recap summaries, in addition to
// the usual filters). Also returns last_recap_date / recap_count / stage_since per property so
// the dashboard can flag stale deals without an extra round trip per row.
router.get('/', asyncHandler(async (req, res) => {
  const { stage, legacy_key, address, assigned_to_me, dealio_stage, dealio_deal_id, archived, recap_search } = req.query;
  const clauses = [];
  const values = [];
  if (stage) { values.push(stage); clauses.push(`p.stage = $${values.length}`); }
  if (legacy_key) { values.push(legacy_key); clauses.push(`p.legacy_key = $${values.length}`); }
  if (address) { values.push(address); clauses.push(`p.address = $${values.length}`); }
  if (assigned_to_me !== undefined) { values.push(assigned_to_me === 'true'); clauses.push(`p.assigned_to_me = $${values.length}`); }
  if (dealio_stage) { values.push(dealio_stage); clauses.push(`p.dealio_stage = $${values.length}`); }
  if (dealio_deal_id) { values.push(dealio_deal_id); clauses.push(`p.dealio_deal_id = $${values.length}`); }
  if (archived === 'true') { clauses.push(`p.archived_at IS NOT NULL`); }
  else if (archived !== 'all') { clauses.push(`p.archived_at IS NULL`); }
  if (recap_search) {
    values.push(`%${recap_search}%`);
    clauses.push(`EXISTS (SELECT 1 FROM call_recaps cr WHERE cr.property_id = p.id AND cr.summary ILIKE $${values.length})`);
  }
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

// GET /api/properties/:id — single property + its recaps + its stage history + its edit history
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
  const editsResult = await pool.query(
    'SELECT * FROM property_edits WHERE property_id = $1 ORDER BY changed_at DESC',
    [id]
  );
  res.json({ ...propResult.rows[0], call_recaps: recapsResult.rows, stage_history: historyResult.rows, edit_history: editsResult.rows });
}));

// POST /api/properties — create
router.post('/', asyncHandler(async (req, res) => {
  const { address, stage, deal_url, agent_name, agent_phone, agent_email, legacy_key, deal_value, dealio_stage, dealio_deal_id, dealio_property_id } = req.body;
  if (!address) return res.status(400).json({ error: 'address is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO properties (address, stage, deal_url, agent_name, agent_phone, agent_email, legacy_key, deal_value, dealio_stage, dealio_deal_id, dealio_property_id)
       VALUES ($1, COALESCE($2,'Intake'), $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [address, stage, deal_url, agent_name, agent_phone, agent_email, legacy_key, deal_value || null, dealio_stage || null, dealio_deal_id || null, dealio_property_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'legacy_key or dealio_deal_id already exists', detail: err.detail });
    throw err;
  }
}));

// POST /api/properties/bulk-sync — upsert many properties at once from a DealioDesk pull,
// keyed by dealio_deal_id (DealioDesk's transactionId — stable, unlike address/legacy_key).
// Used by the dealiodesk-full-pipeline-sync / -backfill-now scheduled tasks instead of one
// GET+POST/PATCH round trip per deal, since hundreds of sequential calls is exactly the
// pattern that has repeatedly hung/stalled other scheduled tasks in this environment.
//
// Body: { deals: [{ dealio_deal_id (required), dealio_property_id, address (required),
//   stage (required, one of the stage CHECK values), dealio_stage, deal_url, deal_value }, ...] }
// The caller is expected to send Jeremy's ENTIRE current owned book in one call (every lens
// with deals, plus Intake) — the reconcile step below treats any previously-synced property
// missing from this list as no longer his, so a partial/single-lens call would incorrectly
// de-own deals that simply live in a lens that wasn't included this time.
//
// Per deal: upsert by dealio_deal_id. On conflict, updates address/stage/dealio_stage/
// deal_url/deal_value/dealio_synced_at/assigned_to_me(true) — but never touches agent_name/
// agent_phone/agent_email/archived_at/called_at/legacy_key, so manual edits and archive/call
// state survive repeated syncs. New rows get legacy_key = NULL (dealio_deal_id is this row's
// real stable key; this sync doesn't participate in the old "prop_<address-slug>" convention).
// A stage change vs. the existing row is logged to stage_history, same as a manual PATCH.
//
// Reconcile: any existing property with a non-null dealio_deal_id that is NOT present in this
// request's deals list gets assigned_to_me set to false (closed, reassigned, or ended) —
// batches dealiodesk-ownership-sync-now's logic. Properties with no dealio_deal_id (manually
// created, or added by an older task) are never touched by this reconcile step.
//
// Returns { created, updated, deowned, errors: [...] }.
router.post('/bulk-sync', asyncHandler(async (req, res) => {
  const deals = Array.isArray(req.body.deals) ? req.body.deals : null;
  if (!deals) return res.status(400).json({ error: 'deals must be an array' });

  // NOTE: each deal is upserted as its own independent statement/transaction against the
  // shared pool (not one big multi-hundred-row transaction) — a single bad row (e.g. a stage
  // value that trips the properties_stage_check CHECK constraint) is caught, recorded in
  // `errors`, and skipped, rather than aborting and rolling back every other deal in the batch.
  let created = 0, updated = 0, deowned = 0;
  const errors = [];
  const seenIds = [];

  for (const d of deals) {
    const { dealio_deal_id, dealio_property_id, address, stage, dealio_stage, deal_url, deal_value } = d || {};
    if (!dealio_deal_id || !address || !stage) {
      errors.push({ dealio_deal_id: dealio_deal_id || null, error: 'dealio_deal_id, address and stage are required' });
      continue;
    }

    try {
      const existing = await pool.query('SELECT * FROM properties WHERE dealio_deal_id = $1', [dealio_deal_id]);

      if (!existing.rows.length) {
        await pool.query(
          `INSERT INTO properties (address, stage, dealio_stage, deal_url, deal_value, dealio_deal_id, dealio_property_id, assigned_to_me, dealio_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, now())`,
          [address, stage, dealio_stage || null, deal_url || null, deal_value || null, dealio_deal_id, dealio_property_id || null]
        );
        created++;
      } else {
        const before = existing.rows[0];
        await pool.query(
          `UPDATE properties
           SET address = $1, stage = $2, dealio_stage = $3, deal_url = $4, deal_value = $5,
               dealio_property_id = $6, assigned_to_me = true, dealio_synced_at = now(), updated_at = now()
           WHERE dealio_deal_id = $7`,
          [address, stage, dealio_stage || null, deal_url || null, deal_value || null, dealio_property_id || null, dealio_deal_id]
        );
        if (before.stage !== stage) {
          await pool.query(
            `INSERT INTO stage_history (property_id, from_stage, to_stage) VALUES ($1, $2, $3)`,
            [before.id, before.stage, stage]
          );
        }
        updated++;
      }

      // Only counts as "seen" (and thus protected from the de-own reconcile below) once its
      // upsert actually succeeded — a row that errored out shouldn't shield a stale match.
      seenIds.push(dealio_deal_id);
    } catch (err) {
      errors.push({ dealio_deal_id, error: err.message });
    }
  }

  if (seenIds.length) {
    const { rowCount } = await pool.query(
      `UPDATE properties SET assigned_to_me = false, updated_at = now()
       WHERE dealio_deal_id IS NOT NULL AND assigned_to_me = true AND NOT (dealio_deal_id = ANY($1::text[]))`,
      [seenIds]
    );
    deowned = rowCount;
  }

  res.json({ created, updated, deowned, errors });
}));

// Fields whose changes get written to property_edits as an audit trail. Stage is tracked
// separately in stage_history, and called_at/left_vm_at/archived_at are lifecycle toggles
// rather than "edits" in the sense Jeremy cares about, so none of those are duplicated here.
const AUDITED_FIELDS = ['address', 'deal_url', 'agent_name', 'agent_phone', 'agent_email', 'legacy_key', 'deal_value', 'assigned_to_me'];

// Text dropped into DealioDesk's notes feed for each dashboard checkbox that queues a note.
// Keyed by the `dealio_note_reason` the frontend sends alongside a PATCH — see enqueueDealioNote.
const DEALIO_NOTE_TEXT = {
  called: 'Called \u2014 marked via Jeremy\u2019s dashboard.',
  left_vm: 'Left a voicemail \u2014 marked via Jeremy\u2019s dashboard.',
  not_enough_equity: 'Not enough equity \u2014 archived via Jeremy\u2019s dashboard.'
};

// Drops a row in dealio_note_queue for a property that has a dealio_deal_id, so it can later
// be written into DealioDesk's actual notes feed (this app has no live DealioDesk API access
// of its own — see the comment on dealio_note_queue in db/schema.sql). No-ops silently for an
// unrecognized reason or a property with no dealio_deal_id (nothing to attach a note to).
async function enqueueDealioNote(property, reason) {
  const text = DEALIO_NOTE_TEXT[reason];
  if (!text || !property.dealio_deal_id) return;
  await pool.query(
    `INSERT INTO dealio_note_queue (property_id, dealio_deal_id, address, reason, note_text)
     VALUES ($1, $2, $3, $4, $5)`,
    [property.id, property.dealio_deal_id, property.address, reason, text]
  );
}

// PATCH /api/properties/:id — partial update (never overwrites with null unless explicitly passed).
// If `stage` is changing, logs the transition to stage_history for the activity feed / insights.
// Any change to an AUDITED_FIELDS field is logged to property_edits for the edit-history view.
// An optional, non-persisted `dealio_note_reason` ('called' | 'left_vm' | 'not_enough_equity')
// queues a DealioDesk note for this property — see enqueueDealioNote.
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const fields = ['address', 'stage', 'deal_url', 'agent_name', 'agent_phone', 'agent_email', 'legacy_key', 'deal_value', 'called_at', 'left_vm_at', 'assigned_to_me', 'archived_at', 'dealio_stage', 'dealio_deal_id', 'dealio_property_id', 'dealio_synced_at'];
  const sets = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      sets.push(`${f} = $${values.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });

  const current = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
  if (!current.rows.length) return res.status(404).json({ error: 'not found' });
  const before = current.rows[0];
  const previousStage = before.stage;

  // Changing stage resets the "called them" / "left VM" checkboxes, unless this same request
  // is explicitly setting that field itself.
  if (req.body.stage !== undefined && req.body.called_at === undefined && req.body.stage !== previousStage) {
    values.push(null);
    sets.push(`called_at = $${values.length}`);
  }
  if (req.body.stage !== undefined && req.body.left_vm_at === undefined && req.body.stage !== previousStage) {
    values.push(null);
    sets.push(`left_vm_at = $${values.length}`);
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

  for (const f of AUDITED_FIELDS) {
    if (req.body[f] === undefined) continue;
    const oldVal = before[f];
    const newVal = rows[0][f];
    const changed = String(oldVal ?? '') !== String(newVal ?? '');
    if (changed) {
      await pool.query(
        `INSERT INTO property_edits (property_id, field, old_value, new_value) VALUES ($1, $2, $3, $4)`,
        [id, f, oldVal == null ? null : String(oldVal), newVal == null ? null : String(newVal)]
      );
    }
  }

  if (req.body.dealio_note_reason) {
    await enqueueDealioNote(rows[0], req.body.dealio_note_reason);
  }

  res.json(rows[0]);
}));

// DELETE /api/properties/:id — permanently removes the property. Kept for rare cases that
// genuinely need hard deletion, but the dashboard's "not enough equity" checkbox no longer
// uses this route — it PATCHes archived_at instead so the data is archived, not destroyed.
// call_recaps, stage_history and property_edits cascade-delete; tasks keep their row but
// property_id is set to NULL (see schema), so nothing else breaks.
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
