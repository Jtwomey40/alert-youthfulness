-- alert-youthfulness schema
-- Replaces the Notion Properties + Tasks databases

CREATE TABLE IF NOT EXISTS properties (
  id              SERIAL PRIMARY KEY,
  address         TEXT NOT NULL,
  stage           TEXT NOT NULL DEFAULT 'Intake'
                    CHECK (stage IN ('Intake','Offer requested','Offers ready','Offer selected','Not in DealioDesk')),
  deal_url        TEXT,
  agent_name      TEXT,
  agent_phone     TEXT,
  agent_email     TEXT,
  legacy_key      TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_recaps (
  id              SERIAL PRIMARY KEY,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  meeting_title   TEXT NOT NULL,
  meeting_date    DATE NOT NULL,
  summary         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, meeting_title, meeting_date)
);

CREATE TABLE IF NOT EXISTS tasks (
  id               SERIAL PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'todo'
                     CHECK (status IN ('todo','in_progress','done')),
  priority         TEXT NOT NULL DEFAULT 'medium'
                     CHECK (priority IN ('high','medium','low')),
  due              DATE,
  project          TEXT,
  property_id      INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  source           TEXT NOT NULL DEFAULT 'auto'
                     CHECK (source IN ('dealiodesk','auto')),
  dealio_task_id   TEXT UNIQUE,
  dealio_task_type TEXT CHECK (dealio_task_type IN ('standalone','deal')),
  legacy_id        TEXT,
  steps            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
CREATE INDEX IF NOT EXISTS idx_tasks_property ON tasks(property_id);
CREATE INDEX IF NOT EXISTS idx_properties_stage ON properties(stage);
