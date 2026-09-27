/**
 * Multilingual (en / tr / ar) schema — additive and idempotent.
 *
 *   alerts.message_key / message_params   catalog key + JSON params of the alert text
 *                                         (alerts.message keeps the English render, so
 *                                         old rows and old readers are unaffected)
 *   user_preferences.language             'en' | 'tr' | 'ar', NULL = never chosen (the
 *                                         frontend then uses the device language and
 *                                         writes it back on first sign-in)
 *   agronomist_report_translations        cached AI translation of a report per language
 *   operator_task_translations            cached translation of an AI-created operator task
 *
 * The Telegram language is a system_settings key (telegram_language), no column.
 */
function ensureI18nSchema(db) {
  const cols = (table) => db.pragma(`table_info(${table})`).map(c => c.name);

  const alertCols = cols('alerts');
  if (!alertCols.includes('message_key')) db.exec('ALTER TABLE alerts ADD COLUMN message_key TEXT');
  if (!alertCols.includes('message_params')) db.exec('ALTER TABLE alerts ADD COLUMN message_params TEXT');

  ensureNullableUserLanguage(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agronomist_report_translations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      lang TEXT NOT NULL CHECK(lang IN ('tr','ar')),
      fields TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed')),
      source_hash TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_estimate REAL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT,
      UNIQUE(report_id, lang),
      FOREIGN KEY (report_id) REFERENCES agronomist_reports(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agro_translations_report ON agronomist_report_translations(report_id);

    CREATE TABLE IF NOT EXISTS operator_task_translations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      lang TEXT NOT NULL CHECK(lang IN ('tr','ar')),
      fields TEXT NOT NULL,
      report_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(task_id, lang),
      FOREIGN KEY (task_id) REFERENCES operator_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_translations_task ON operator_task_translations(task_id);
  `);
}

const LANGUAGE_CHECK = "CHECK(language IS NULL OR language IN ('en','tr','ar'))";

/**
 * user_preferences.language: nullable, no default. NULL means the user never
 * chose a language (new accounts); the API returns null for it.
 *
 * Phase 1 created the column as `NOT NULL DEFAULT 'en'`. SQLite cannot drop a
 * NOT NULL constraint in place, so the column is swapped: add a nullable
 * column, copy every value, drop the old column (its column-level CHECK goes
 * with it) and rename. One transaction; runs only while the old column is
 * still NOT NULL, so it is idempotent. Existing rows keep their value: whether
 * an 'en' was chosen or defaulted cannot be known, so nobody is changed.
 */
function ensureNullableUserLanguage(db) {
  const info = db.pragma('table_info(user_preferences)');
  const col = info.find(c => c.name === 'language');
  if (!col) {
    db.exec(`ALTER TABLE user_preferences ADD COLUMN language TEXT ${LANGUAGE_CHECK}`);
    return 'added';
  }
  if (!col.notnull && col.dflt_value == null) return 'ok';
  const swap = db.transaction(() => {
    db.exec("ALTER TABLE user_preferences ADD COLUMN language_nullable TEXT CHECK(language_nullable IS NULL OR language_nullable IN ('en','tr','ar'))");
    db.exec('UPDATE user_preferences SET language_nullable = language');
    db.exec('ALTER TABLE user_preferences DROP COLUMN language');
    db.exec('ALTER TABLE user_preferences RENAME COLUMN language_nullable TO language');
  });
  swap();
  return 'migrated';
}

module.exports = { ensureI18nSchema, ensureNullableUserLanguage };
