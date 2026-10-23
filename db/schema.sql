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

-- --- Additive changes below (safe to re-run) ---

-- Link a task back to the specific call recap it was generated from, for traceability.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recap_id INTEGER REFERENCES call_recaps(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_recap ON tasks(recap_id);

-- Allow a 'manual' task source (created by Jeremy logging a call from the dashboard UI),
-- in addition to the existing 'dealiodesk' and 'auto' sources. Looks up the existing check
-- constraint on tasks.source by introspection (rather than assuming its auto-generated name)
-- so this is safe to re-run no matter how it was originally named.
DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'tasks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%source%'
  LOOP
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
ALTER TABLE tasks ADD CONSTRAINT tasks_source_check CHECK (source IN ('dealiodesk', 'auto', 'manual'));

-- Records every stage transition so the dashboard can show an activity feed and
-- compute average time-in-stage. Populated going forward by the PATCH /api/properties/:id route.
CREATE TABLE IF NOT EXISTS stage_history (
  id              SERIAL PRIMARY KEY,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_stage      TEXT,
  to_stage        TEXT NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stage_history_property ON stage_history(property_id);
CREATE INDEX IF NOT EXISTS idx_stage_history_changed_at ON stage_history(changed_at);

-- Timestamp for "I've called them" checkbox on a property's card, shown while a property
-- is in the 'Offers ready' stage. Reset to NULL automatically whenever stage changes
-- (see PATCH /api/properties/:id) so a future visit to 'Offers ready' starts unchecked.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS called_at TIMESTAMPTZ;
