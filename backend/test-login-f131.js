const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'data/sensehub.db'));
const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@sensehub.local');

console.log('User found:', user ? 'yes' : 'no');
console.log('Stored hash:', user?.password_hash);

const testPassword = 'admin123';
const isValid = bcrypt.compareSync(testPassword, user.password_hash);
console.log('Password valid:', isValid);

// Try creating a fresh hash and comparing
const freshHash = bcrypt.hashSync('admin123', 10);
console.log('Fresh hash:', freshHash);
console.log('Fresh hash valid:', bcrypt.compareSync('admin123', freshHash));

db.close();
