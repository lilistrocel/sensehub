const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'data/sensehub.db'));

// Check if admin exists
const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@sensehub.local');
if (!user) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run('admin@sensehub.local', hash, 'Admin User', 'admin');
  console.log('Admin user created');
} else {
  console.log('Admin user already exists');
}
console.log('Users:', db.prepare('SELECT id, email, role FROM users').all());
db.close();
