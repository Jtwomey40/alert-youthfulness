const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const asyncHandler = require('./asyncHandler');

// GET /api/insights/stats — rollup numbers for the dashboard's Insights tab.
router.get('/stats', asyncHandler(async (req, res) => {
  const [tasksWeek, tasksMonth, byPriority, byStage, closedMonth, avgDaysPerStage, valueByStage] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'done' AND completed_at >= now() - interval '7 days'`),
    pool.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'done' AND completed_at >= now() - interval '30 days'`),
    pool.query(`SELECT priority, COUNT(*)::int AS n FROM tasks WHERE status != 'done' GROUP BY priority`),
    pool.query(`SELECT stage, COUNT(*)::int AS n FROM properties GROUP BY stage`),
    pool.query(`SELECT COUNT(*)::int AS n FROM stage_history WHERE to_stage = 'Offer selected' AND changed_at >= now() - interval '30 days'`),
    pool.query(`
      SELECT to_stage AS stage, ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(next_changed_at, now()) - changed_at)) / 86400)::numeric, 1) AS avg_days
      FROM (
        SELECT property_id, to_stage, changed_at,
               LEAD(changed_at) OVER (PARTITION BY property_id ORDER BY changed_at) AS next_changed_at
        FROM stage_history
      ) t
      GROUP BY to_stage
    `),
    pool.query(`
      SELECT stage, COALESCE(SUM(deal_value), 0)::numeric AS total_value, COUNT(deal_value)::int AS n_with_value
      FROM properties
      WHERE archived_at IS NULL AND stage != 'Not in DealioDesk'
      GROUP BY stage
    `)
  ]);

  res.json({
    tasks_completed_7d: tasksWeek.rows[0].n,
    tasks_completed_30d: tasksMonth.rows[0].n,
    open_tasks_by_priority: byPriority.rows,
    properties_by_stage: byStage.rows,
    deals_reached_offer_selected_30d: closedMonth.rows[0].n,
    avg_days_per_stage: avgDaysPerStage.rows,
    avg_days_per_stage_note: 'Based on stage transitions tracked since this feature shipped — history before that is not available.',
    pipeline_value_by_stage: valueByStage.rows
  });
}));

// GET /api/insights/needs-attention — properties that are stale or missing contact info,
// plus any overdue tasks, surfaced as one combined worklist.
router.get('/needs-attention', asyncHandler(async (req, res) => {
  const staleDays = Number(req.query.stale_days) || 14;
  const [staleRecap, missingAgent, overdueTasks] = await Promise.all([
    pool.query(`
      SELECT p.id, p.address, p.stage, recaps.last_recap_date
      FROM properties p
      LEFT JOIN (
        SELECT property_id, MAX(meeting_date) AS last_recap_date
        FROM call_recaps GROUP BY property_id
      ) recaps ON recaps.property_id = p.id
      WHERE p.stage NOT IN ('Offer selected', 'Not in DealioDesk') AND p.archived_at IS NULL
        AND (recaps.last_recap_date IS NULL OR recaps.last_recap_date < (CURRENT_DATE - $1::int))
      ORDER BY p.address ASC
    `, [staleDays]),
    pool.query(`
      SELECT id, address, stage FROM properties
      WHERE stage NOT IN ('Not in DealioDesk') AND archived_at IS NULL AND (agent_email IS NULL OR agent_email = '')
      ORDER BY address ASC
    `),
    pool.query(`
      SELECT t.*, p.address AS property_address FROM tasks t
      LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.status != 'done' AND t.due IS NOT NULL AND t.due < CURRENT_DATE
      ORDER BY t.due ASC
    `)
  ]);

  res.json({
    stale_recaps: staleRecap.rows,
    missing_agent_contact: missingAgent.rows,
    overdue_tasks: overdueTasks.rows
  });
}));

// GET /api/insights/activity — recent stage changes + recent call recaps, merged into one feed.
router.get('/activity', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const [stageChanges, recaps] = await Promise.all([
    pool.query(`
      SELECT sh.id, sh.property_id, p.address, sh.from_stage, sh.to_stage, sh.changed_at AS occurred_at, 'stage_change' AS type
      FROM stage_history sh JOIN properties p ON p.id = sh.property_id
      ORDER BY sh.changed_at DESC LIMIT $1
    `, [limit]),
    pool.query(`
      SELECT c.id, c.property_id, p.address, c.meeting_title, c.meeting_date, c.created_at AS occurred_at, 'recap' AS type
      FROM call_recaps c JOIN properties p ON p.id = c.property_id
      ORDER BY c.created_at DESC LIMIT $1
    `, [limit])
  ]);

  const merged = [...stageChanges.rows, ...recaps.rows]
    .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
    .slice(0, limit);

  res.json(merged);
}));

module.exports = router;
