// Seller tool: mints one activation key for one buyer on one machine.
//
//   node tools/make-license.js "buyer@example.com" "A1B2-C3D4-E5F6-7890"
//
// The buyer sends you their email and the Machine ID shown in the panel.
// Needs tools/keys/private.pem — keep that file private and backed up; anyone
// who has it can mint keys, and losing it means every future key must use a
// new public key (i.e. a new build).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join(__dirname, 'keys', 'private.pem');
const LOG_FILE = path.join(__dirname, 'keys', 'issued-licenses.csv');

const MAX_PER_EMAIL = 10;

const args = process.argv.slice(2).filter(a => a !== '--force');
const force = process.argv.indexOf('--force') !== -1;
const email = (args[0] || '').trim();
const machine = (args[1] || '').trim().toUpperCase();

if (!email || !machine) {
    console.error('Usage: node tools/make-license.js "buyer@example.com" "A1B2-C3D4-E5F6-7890"');
    process.exit(1);
}
if (email.indexOf('@') === -1) {
    console.error('That does not look like an email address: ' + email);
    process.exit(1);
}
if (!/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(machine)) {
    console.error('Machine ID should look like A1B2-C3D4-E5F6-7890 (16 hex characters). Got: ' + machine);
    process.exit(1);
}
if (!fs.existsSync(KEY_FILE)) {
    console.error('Missing signing key: ' + KEY_FILE);
    process.exit(1);
}

// One buyer should not need many machines. Past the cap this refuses unless you pass
// --force, which is how "they have to contact me first" is enforced.
let previous = [];
if (fs.existsSync(LOG_FILE)) {
    previous = fs.readFileSync(LOG_FILE, 'utf8').split('\n')
        .map(line => line.split(','))
        .filter(cells => cells.length >= 3 && cells[1].trim().toLowerCase() === email.toLowerCase());
}
const already = previous.filter(cells => cells[2].trim().toUpperCase() === machine).length;
if (already) {
    console.log('Note: this machine already has ' + already + ' key(s) for this email. Re-issuing is fine.');
}
if (previous.length >= MAX_PER_EMAIL && !already && !force) {
    console.error('');
    console.error(email + ' already has ' + previous.length + ' keys on ' + MAX_PER_EMAIL + ' different machines:');
    previous.slice(-MAX_PER_EMAIL).forEach(cells => console.error('   ' + cells[0] + '  ' + cells[2]));
    console.error('');
    console.error('That is the limit. If you are happy to give them another, run the same');
    console.error('command again with --force on the end.');
    process.exit(2);   // 2 means "hit the limit", so Make Activation Key.bat can offer to override
}

const toBase64Url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const issued = new Date().toISOString().slice(0, 10);
const payload = toBase64Url(Buffer.from(JSON.stringify({ e: email, m: machine, i: issued }), 'utf8'));
const signature = toBase64Url(crypto.sign(null, Buffer.from(payload, 'utf8'), fs.readFileSync(KEY_FILE, 'utf8')));
const key = payload + '.' + signature;

// A record of who got what, so a leaked key can be traced back and repeat buyers are easy to spot.
try {
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, 'issued,email,machineId\n', 'utf8');
    fs.appendFileSync(LOG_FILE, [issued, email, machine].join(',') + '\n', 'utf8');
} catch (e) {
    console.error('(could not write ' + LOG_FILE + ': ' + e.message + ')');
}

let copied = false;
try {
    require('child_process').execSync('clip', { input: key });
    copied = true;
} catch (e) {}

console.log('');
console.log('Activation key for ' + email + '  (machine ' + machine + ', issued ' + issued + ')');
console.log('------------------------------------------------------------');
console.log(key);
console.log('------------------------------------------------------------');
console.log('');
console.log(copied
    ? 'The key is already on your clipboard - just paste it into your email.'
    : 'Copy everything between the lines and email it to the buyer.');
