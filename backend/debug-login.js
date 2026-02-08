const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data/sensehub.db'));

// Get the admin user
const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@sensehub.local');
console.log('User found:', user ? 'Yes' : 'No');
if (user) {
  console.log('User ID:', user.id);
  console.log('Email:', user.email);
  console.log('Password hash length:', user.password_hash ? user.password_hash.length : 0);
  console.log('Password hash (first 20 chars):', user.password_hash ? user.password_hash.substring(0, 20) : 'null');

  // Test password comparison
  const testPassword = 'admin123';
  const isValid = bcrypt.compareSync(testPassword, user.password_hash);
  console.log('Password "admin123" valid:', isValid);
}

// List all users
const allUsers = db.prepare('SELECT id, email, name, role FROM users').all();
console.log('\nAll users:', allUsers);
