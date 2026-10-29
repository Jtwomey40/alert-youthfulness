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

-- Whether Jeremy currently owns this deal's stage in DealioDesk (vs. a teammate).
-- Defaults to true so nothing is hidden before the first ownership sync runs.
-- Kept current by the dealiodesk-zoom-evening-recap-v3 scheduled task, which
-- cross-references DealioDesk's find_deals(owner="me") and PATCHes this field.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS assigned_to_me BOOLEAN NOT NULL DEFAULT true;

-- Soft-delete: set when a property is archived (e.g. "not enough equity") instead of
-- being hard-deleted, so the data isn't gone for good. NULL means active/not archived.
-- Archived properties are excluded from GET /api/properties by default (see routes/properties.js).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Rough dollar estimate/offer value for the deal, entered manually. Nullable since not
-- every property has a number yet. Used for the pipeline-value-by-stage insight.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS deal_value NUMERIC;

-- Audit trail for manual edits to a property's fields (contact info, deal URL, value, etc.).
-- Stage changes are already tracked separately in stage_history, so they're not duplicated here.
-- Populated by the PATCH /api/properties/:id route whenever an auditable field actually changes.
CREATE TABLE IF NOT EXISTS property_edits (
  id              SERIAL PRIMARY KEY,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  field           TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_edits_property ON property_edits(property_id);

-- Expand properties.stage from the original 4 hand-picked values to the 5 stages that make up
-- Jeremy's DealioDesk "offers" lens pipeline (Intake through Offer selected), so the
-- full-pipeline sync (dealiodesk-full-pipeline-sync) can store his ~422 offers-pipeline deals
-- in their real stage. Scoped ONLY to the offers lens — intentionally does NOT include
-- DealioDesk's acquisitions/inspection/title/renovations/resale/disposition lenses; those
-- weren't part of what Jeremy asked to track here.
-- Looks up the existing CHECK constraint by introspection so this is safe to re-run.
DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'properties'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%stage%'
  LOOP
    EXECUTE format('ALTER TABLE properties DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
ALTER TABLE properties ADD CONSTRAINT properties_stage_check CHECK (stage IN (
  'Intake','Estimates available','Offer requested','Offers ready','Offer selected','Not in DealioDesk'
));

-- DealioDesk's finer board lane within a coarse stage (e.g. "Details Shared", "Comping
-- Complete", "Comping Viewed", "Agent disputed comps", "Estimated Offer Available") —
-- free text rather than a CHECK list since DealioDesk's own lane catalog can change.
-- Nullable: only populated for properties touched by the full-pipeline sync. This is what
-- surfaces Jeremy's "70 Details Shared" count, which has no equivalent in the coarse stage.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS dealio_stage TEXT;
CREATE INDEX IF NOT EXISTS idx_properties_dealio_stage ON properties(dealio_stage);

-- Stable DealioDesk-side identifiers for the full-pipeline sync to upsert against, independent
-- of legacy_key's address-slug convention (two deals can share an address slug; DealioDesk's
-- own ids can't collide). dealio_deal_id = DealioDesk's transactionId; dealio_property_id =
-- DealioDesk's propertyId, kept alongside for reference. Both nullable: only set by the sync.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS dealio_deal_id TEXT UNIQUE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS dealio_property_id TEXT;
CREATE INDEX IF NOT EXISTS idx_properties_dealio_deal_id ON properties(dealio_deal_id);

-- When the full-pipeline sync last touched this property, so the sync's own reconcile step
-- (and the dashboard, if useful later) can tell freshly-synced rows from stale/manual ones.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS dealio_synced_at TIMESTAMPTZ;

-- Timestamp for the "Left VM" checkbox on a property's card, mirroring called_at. Also shown
-- only in the 'Offers ready' stage, and reset to NULL on stage change (see PATCH /api/properties/:id).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS left_vm_at TIMESTAMPTZ;

-- Queue of notes waiting to be written into DealioDesk's deal notes feed. This app has no
-- direct DealioDesk API credentials of its own, so checking "I've called them" / "Left VM" /
-- "Not enough equity" doesn't call DealioDesk live — it drops a row here instead. Jeremy (via
-- Claude, through the DealioDesk connector) periodically flushes unsynced rows by calling
-- DealioDesk's TransactionNotes.Create for each dealio_deal_id, then marks them synced via
-- POST /api/dealio-notes/mark-synced. Snapshots dealio_deal_id/address at queue time so a
-- flush still works even if the property is later archived or edited.
CREATE TABLE IF NOT EXISTS dealio_note_queue (
  id              SERIAL PRIMARY KEY,
  property_id     INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  dealio_deal_id  TEXT NOT NULL,
  address         TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('called','left_vm','not_enough_equity')),
  note_text       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dealio_note_queue_unsynced ON dealio_note_queue(synced_at) WHERE synced_at IS NULL;

-- Pending Slack messages / Zoom recaps attached to a property, surfaced on the dashboard's
-- "Board" activity board (replaces the old stage-based Pipeline view, which was redundant
-- with DealioDesk's own stage tracking). Each row is one actionable item; Jeremy marks it
-- handled, snoozes it, or opens the source from the board. See routes/activity-items.js.
CREATE TABLE IF NOT EXISTS activity_items (
  id              SERIAL PRIMARY KEY,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('slack','zoom')),
  source_ref      TEXT,
  summary         TEXT NOT NULL,
  source_url      TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','snoozed','handled')),
  snoozed_until   TIMESTAMPTZ,
  handled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_items_status ON activity_items(status);
CREATE INDEX IF NOT EXISTS idx_activity_items_property ON activity_items(property_id);
