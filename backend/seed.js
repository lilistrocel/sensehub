const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'data/sensehub.db'));

// Check if admin exists and reset password
const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@sensehub.local');
const hash = bcrypt.hashSync('admin123', 10);
if (!user) {
  db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run('admin@sensehub.local', hash, 'Admin User', 'admin');
  console.log('Admin user created');
} else {
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
  console.log('Admin password reset to admin123');
}
console.log('Users:', db.prepare('SELECT id, email, role FROM users').all());
db.close();
