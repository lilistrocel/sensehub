/** Shared DDL so database.js (migration) and unit tests create the same table. */
const AGRONOMIST_CAPTURES_SQL = `
  CREATE TABLE IF NOT EXISTS agronomist_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER NOT NULL,
    capture_date TEXT NOT NULL,
    path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bytes INTEGER DEFAULT 0,
    preset_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(camera_id, capture_date)
  );
  CREATE INDEX IF NOT EXISTS idx_agronomist_captures_date ON agronomist_captures(capture_date);
`;
module.exports = { AGRONOMIST_CAPTURES_SQL };
