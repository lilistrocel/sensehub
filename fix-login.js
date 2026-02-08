const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');

const db = new Database('./backend/data/sensehub.db');
const hash = bcrypt.hashSync('admin123', 10);

// Update existing admin
const result = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');

if (result.changes > 0) {
  process.stdout.write('Updated admin password to admin123\n');
} else {
  process.stdout.write('Admin not found, creating new one\n');
  db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run(
    'admin@sensehub.local',
    hash,
    'Admin User',
    'admin'
  );
}

db.close();
process.stdout.write('Done\n');
