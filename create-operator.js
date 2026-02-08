const path = require('path');
const Database = require(path.join(__dirname, 'backend/node_modules/better-sqlite3'));
const bcrypt = require(path.join(__dirname, 'backend/node_modules/bcryptjs'));

const dbPath = path.join(__dirname, 'backend/data/sensehub.db');
const db = new Database(dbPath);

// Generate password hash
const hash = bcrypt.hashSync('operator123', 10);

// Reset admin password
const adminHash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(adminHash, 'admin@sensehub.local');
console.log('Admin password reset to admin123');

// Check if operator exists
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('operator@sensehub.local');
if (existing) {
  console.log('Operator user already exists');
} else {
  // Create operator user
  const result = db.prepare(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
  ).run('operator@sensehub.local', hash, 'Operator User', 'operator');
  console.log('Created operator user with id:', result.lastInsertRowid);
}

db.close();
