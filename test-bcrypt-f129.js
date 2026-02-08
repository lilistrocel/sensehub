const bcrypt = require('/home/noobcity/Code/SenseHub/backend/node_modules/bcryptjs');
const hash = '$2a$10$B6UOulwnl0ArrmQE0rsTmOdET5lu6JGAVklI3oAuxKGNfjq98MD86';
const password = 'admin123';
const result = bcrypt.compareSync(password, hash);
console.log('Password matches:', result);

// Also try generating a new hash
const newHash = bcrypt.hashSync('admin123', 10);
console.log('New hash:', newHash);
console.log('New hash matches:', bcrypt.compareSync('admin123', newHash));
