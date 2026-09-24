/**
 * agronomist_captures — the canopy frames the agronomist looks at.
 *
 * v2 (multi-frame sessions): several rows per (camera_id, capture_date):
 *   sequence     1..N inside a session
 *   sharpness    variance of the Laplacian (higher = sharper), null if scoring failed
 *   source       'noon' (12:00 trigger) | 'manual' (POST capture-now) | 'fallback_4h'
 *                (a routine 4-hourly camera_snapshots frame registered for a report)
 *   captured_at  the real capture time (ISO UTC); created_at is the row time
 *
 * v1 had UNIQUE(camera_id, capture_date). SQLite cannot drop a UNIQUE constraint in
 * place, so ensureAgronomistCapturesSchema() rebuilds the table (create new → copy
 * rows keeping ids → drop → rename) inside a transaction, with foreign keys switched
 * off around it so agronomist_reports.capture_id (ON DELETE SET NULL) is untouched.
 * Idempotent: a v2 table is left alone.
 */

const TABLE = 'agronomist_captures';
const NEW_COLUMNS = ['sequence', 'sharpness', 'source', 'captured_at'];

const columnsSql = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER NOT NULL,
    capture_date TEXT NOT NULL,
    path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bytes INTEGER DEFAULT 0,
    preset_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    sequence INTEGER DEFAULT 1,
    sharpness REAL,
    source TEXT DEFAULT 'noon',
    captured_at TEXT`;

const indexSql = `
  CREATE INDEX IF NOT EXISTS idx_agronomist_captures_date ON ${TABLE}(capture_date);
  CREATE INDEX IF NOT EXISTS idx_agronomist_captures_captured_at ON ${TABLE}(captured_at);
  CREATE INDEX IF NOT EXISTS idx_agronomist_captures_path ON ${TABLE}(path);
`;

const AGRONOMIST_CAPTURES_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (${columnsSql}
  );
  ${indexSql}
`;

/** True when the table exists in the v1 shape (UNIQUE constraint and/or missing columns). */
function needsRebuild(db) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE);
  if (!exists) return false;
  const hasUnique = db.pragma(`index_list(${TABLE})`).some(i => i.unique && i.origin === 'u');
  const cols = db.pragma(`table_info(${TABLE})`).map(c => c.name);
  const missing = NEW_COLUMNS.filter(c => !cols.includes(c));
  return hasUnique || missing.length > 0;
}

/**
 * Create the table if absent, or rebuild a v1 table into the v2 shape preserving
 * every row and id. Returns { created, migrated, rows }.
 */
function ensureAgronomistCapturesSchema(db, { log = console, tz = null } = {}) {
  const existed = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE);
  if (!existed) {
    db.exec(AGRONOMIST_CAPTURES_SQL);
    return { created: true, migrated: false, rows: 0 };
  }
  if (!needsRebuild(db)) {
    db.exec(indexSql);
    return { created: false, migrated: false, rows: null };
  }

  const cols = db.pragma(`table_info(${TABLE})`).map(c => c.name);
  const expr = (name, dflt) => (cols.includes(name) ? name : dflt);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n;

  // PRAGMA foreign_keys is a no-op inside a transaction: toggle it outside.
  const fkWasOn = !!db.pragma('foreign_keys', { simple: true });
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${TABLE}_new`);
      db.exec(`CREATE TABLE ${TABLE}_new (${columnsSql}
      )`);
      db.exec(`
        INSERT INTO ${TABLE}_new
          (id, camera_id, capture_date, path, width, height, bytes, preset_id, created_at, sequence, sharpness, source, captured_at)
        SELECT id, camera_id, capture_date, path, width, height, bytes, preset_id, created_at,
               ${expr('sequence', '1')}, ${expr('sharpness', 'NULL')}, ${expr('source', "'noon'")},
               COALESCE(${expr('captured_at', 'NULL')}, created_at)
        FROM ${TABLE}
      `);
      const copied = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}_new`).get().n;
      if (copied !== before) throw new Error(`row count mismatch during rebuild (${copied} != ${before})`);
      db.exec(`DROP TABLE ${TABLE}`);
      db.exec(`ALTER TABLE ${TABLE}_new RENAME TO ${TABLE}`);
      db.exec(indexSql);
      // Keep AUTOINCREMENT going from the highest preserved id.
      const maxId = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${TABLE}`).get().m;
      db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(TABLE);
      db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(TABLE, maxId);
      const fkProblems = db.pragma('foreign_key_check');
      if (fkProblems.length) throw new Error(`foreign_key_check failed after rebuild: ${JSON.stringify(fkProblems.slice(0, 3))}`);
    })();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
  // Legacy rows carry no source. Only a capture taken around local noon can have
  // come from the 12:00 trigger; anything else was a manual capture-now.
  let relabelled = 0;
  if (tz) {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
    const upd = db.prepare(`UPDATE ${TABLE} SET source = 'manual' WHERE id = ?`);
    for (const r of db.prepare(`SELECT id, captured_at FROM ${TABLE}`).all()) {
      const t = r.captured_at ? new Date(r.captured_at) : null;
      if (!t || Number.isNaN(t.getTime())) continue;
      const hour = parseInt(fmt.format(t), 10) % 24;
      if (hour < 11 || hour >= 14) { upd.run(r.id); relabelled++; }
    }
  }
  log.log(`[agronomist_captures] migrated to multi-frame schema (${before} rows preserved, ${relabelled} relabelled as manual)`);
  return { created: false, migrated: true, rows: before, relabelled };
}

module.exports = { AGRONOMIST_CAPTURES_SQL, ensureAgronomistCapturesSchema, needsRebuild, NEW_COLUMNS };
