const bcrypt = require('./backend/node_modules/bcryptjs');
const hash = '$2a$10$jeaIhvl4ChY.JHOIAdR2D.ru9iR/I5YBqrX6FuKbp45tug1PJCCdO';
console.log('Matches admin123:', bcrypt.compareSync('admin123', hash));

// Also reset admin password to be sure
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');
const newHash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(newHash, 'admin@sensehub.local');
console.log('Password reset to admin123');

// Verify
const user = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('admin@sensehub.local');
console.log('New hash verification:', bcrypt.compareSync('admin123', user.password_hash));
db.close();
