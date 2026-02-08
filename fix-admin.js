const path = require('path');
const Database = require(path.join(__dirname, 'backend/node_modules/better-sqlite3'));
const bcrypt = require(path.join(__dirname, 'backend/node_modules/bcryptjs'));

const dbPath = path.join(__dirname, 'backend/data/sensehub.db');
const db = new Database(dbPath);

// Generate new password hash
const hash = bcrypt.hashSync('admin123', 10);

// Update the admin user
const result = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Rows updated:', result.changes);

// Verify update
const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get('admin@sensehub.local');
console.log('User:', user ? user.email : 'not found');
console.log('Hash starts with:', user ? user.password_hash.substring(0, 10) : 'N/A');

// Verify password match
const matches = bcrypt.compareSync('admin123', user.password_hash);
console.log('Password matches:', matches);

// Force WAL checkpoint
db.pragma('wal_checkpoint(TRUNCATE)');
console.log('WAL checkpointed');

db.close();
