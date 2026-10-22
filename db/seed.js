// One-time import of the current Notion data into Postgres.
// Run with: npm run migrate && node db/seed.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function seed() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
  const legacyKeyToId = {};

  for (const p of data.properties) {
    const { rows } = await pool.query(
      `INSERT INTO properties (address, stage, deal_url, agent_name, agent_phone, agent_email, legacy_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (legacy_key) DO UPDATE SET
         address = EXCLUDED.address, stage = EXCLUDED.stage, deal_url = EXCLUDED.deal_url,
         updated_at = now()
       RETURNING id, legacy_key`,
      [p.address, p.stage, p.deal_url || null, p.agent_name || null, p.agent_phone || null, p.agent_email || null, p.legacy_key]
    );
    legacyKeyToId[rows[0].legacy_key] = rows[0].id;
  }
  console.log(`Seeded ${data.properties.length} properties.`);

  for (const t of data.tasks) {
    const propertyId = t.property_legacy_key ? legacyKeyToId[t.property_legacy_key] || null : null;
    await pool.query(
      `INSERT INTO tasks (title, status, priority, due, project, property_id, source, legacy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dealio_task_id) DO NOTHING`,
      [t.title, t.status, t.priority, t.due || null, t.project || null, propertyId, t.source, t.legacy_id || null]
    );
  }
  console.log(`Seeded ${data.tasks.length} tasks.`);

  await pool.end();
}

seed().catch(err => { console.error(err); process.exit(1); });
