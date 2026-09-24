/**
 * System timezone resolution. Order: system_settings.timezone (JSON
 * {"timezone":"Asia/Dubai"} written by the Settings UI) → TZ env → 'UTC'.
 */
function getSystemTimezone(db) {
  try {
    if (db) {
      const row = db.prepare("SELECT value FROM system_settings WHERE key = 'timezone'").get();
      if (row?.value) {
        let v = row.value;
        try { const j = JSON.parse(v); v = j?.timezone ?? j; } catch {}
        if (typeof v === 'string' && v.trim()) {
          // Validate: Intl throws on unknown zone names
          new Intl.DateTimeFormat('en-US', { timeZone: v.trim() });
          return v.trim();
        }
      }
    }
  } catch {}
  return process.env.TZ || 'UTC';
}

/** YYYY-MM-DD for `date` in `tz`. */
function localDateStr(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

module.exports = { getSystemTimezone, localDateStr };
