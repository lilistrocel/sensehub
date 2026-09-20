-- One-off cleanup for the alert storm (13.8k open rows, mostly duplicates).
-- DO NOT run against the live DB without a backup. Run manually, e.g.:
--   sqlite3 backend/data/sensehub.db < backend/scripts/cleanup-alert-storm.sql
-- Requires the dedupe columns (fingerprint, occurrence_count, last_seen_at) to exist,
-- i.e. the backend must have started once with the alerts dedupe migration.
--
-- What it does, per group of OPEN rows sharing (COALESCE(equipment_id,0), message):
--   1. Keeps the newest row (highest id) open, acknowledges every other row in the group
--      (acknowledged_by = NULL, acknowledged_at = now) so history is preserved.
--   2. On the surviving row: occurrence_count = rows in the group, created_at = first
--      occurrence, last_seen_at = latest occurrence, fingerprint = legacy key.
--
-- Fingerprint note: createAlert() uses sha1(source|automation_id|equipment_id|message),
-- which SQLite cannot compute here, so surviving legacy rows get the deterministic key
--   'legacy:' || equipment_id || ':' || message
-- The first NEW occurrence of a legacy condition will therefore open one fresh row
-- (with the sha1 key) next to the legacy row; acknowledge the legacy row from the UI.

BEGIN;

-- Snapshot the open-row groups before mutating anything.
CREATE TEMP TABLE _alert_groups AS
SELECT
  COALESCE(equipment_id, 0) AS eq_key,
  message,
  MAX(id)          AS keep_id,
  COUNT(*)         AS n,
  MIN(created_at)  AS first_seen,
  MAX(created_at)  AS last_seen
FROM alerts
WHERE acknowledged = 0
GROUP BY COALESCE(equipment_id, 0), message;

-- 1. Acknowledge every open row that is not the group's survivor.
UPDATE alerts
SET acknowledged   = 1,
    acknowledged_by = NULL,
    acknowledged_at = datetime('now')
WHERE acknowledged = 0
  AND id NOT IN (SELECT keep_id FROM _alert_groups);

-- 2. Backfill the survivors.
UPDATE alerts
SET occurrence_count = (SELECT n          FROM _alert_groups g WHERE g.keep_id = alerts.id),
    created_at       = (SELECT first_seen FROM _alert_groups g WHERE g.keep_id = alerts.id),
    last_seen_at     = (SELECT last_seen  FROM _alert_groups g WHERE g.keep_id = alerts.id),
    fingerprint      = COALESCE(fingerprint,
                         'legacy:' || COALESCE(equipment_id, 0) || ':' || message)
WHERE id IN (SELECT keep_id FROM _alert_groups);

-- Any already-acknowledged rows without dedupe metadata: fill sane defaults so
-- the columns are never NULL for old history.
UPDATE alerts
SET occurrence_count = COALESCE(occurrence_count, 1),
    last_seen_at     = COALESCE(last_seen_at, created_at)
WHERE occurrence_count IS NULL OR last_seen_at IS NULL;

DROP TABLE _alert_groups;

COMMIT;

-- Sanity check (read-only):
-- SELECT COUNT(*) AS open_rows, SUM(occurrence_count) AS collapsed_occurrences
-- FROM alerts WHERE acknowledged = 0;
