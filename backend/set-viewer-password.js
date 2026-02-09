const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const db = new Database(__dirname + '/data/sensehub.db');
const hash = bcrypt.hashSync('viewer123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'operator@sensehub.local');
console.log('Password set to: viewer123');
db.close();
