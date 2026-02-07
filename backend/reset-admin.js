const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'sensehub.db');
const db = new Database(dbPath);

const passwordHash = bcrypt.hashSync('admin123', 10);

db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(passwordHash, 'admin@sensehub.local');

const user = db.prepare('SELECT id, email, name, role FROM users WHERE email = ?').get('admin@sensehub.local');
process.stdout.write('Password reset for: ' + user.email + '\n');

db.close();
