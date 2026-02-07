const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'sensehub.db');
const db = new Database(dbPath);

const passwordHash = bcrypt.hashSync('admin123', 10);

// Try to insert, if exists update
try {
  db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run('admin@sensehub.local', passwordHash, 'Admin User', 'admin');
  process.stdout.write('Created admin user: admin@sensehub.local\n');
} catch (e) {
  if (e.message.includes('UNIQUE')) {
    db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(passwordHash, 'admin@sensehub.local');
    process.stdout.write('Updated admin password\n');
  } else {
    throw e;
  }
}

db.close();
