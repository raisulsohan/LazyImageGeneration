// ============================================================
// Lazy-Image: licensing
// A key is an Ed25519 signature made by the seller over the buyer's email and
// the ID of one machine. This panel can only VERIFY, never mint, so a key
// cannot be forged here and a shared key will not work on another computer.
// ============================================================
(function() {

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'LazyImage');
const LICENSE_FILE = path.join(APP_DIR, 'license.key');

const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\n' +
    'MCowBQYDK2VwAyEAAHMHHt3zmj9XkhHCxT0jBc+jIsDyF5oTaJ3aWPQEBtM=\n' +
    '-----END PUBLIC KEY-----\n';

let cachedMachineId = null;

// Windows' MachineGuid is stable for the life of an installation and is not tied to hardware
// the user might swap. Hashed so the raw system ID never leaves the machine.
function machineId() {
    if (cachedMachineId) return cachedMachineId;
    let base = '';
    try {
        const out = cp.execFileSync('reg',
            ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
            { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
        if (match) base = match[1];
    } catch (e) {}
    if (!base) {
        let user = '';
        try { user = os.userInfo().username || ''; } catch (e) {}
        base = os.hostname() + '|' + user;
    }
    const digest = crypto.createHash('sha256').update('LazyImage|' + base).digest('hex').slice(0, 16).toUpperCase();
    cachedMachineId = digest.replace(/(.{4})(?=.)/g, '$1-');
    return cachedMachineId;
}

// URL-safe base64 by hand: Buffer's 'base64url' needs a newer Node than some CEP hosts ship.
function fromBase64Url(text) {
    return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verify(keyString) {
    const clean = String(keyString || '').replace(/\s+/g, '');
    if (!clean) return { valid: false, reason: 'Please paste your activation key.' };

    const parts = clean.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return { valid: false, reason: 'That does not look like a Lazy-Image activation key.' };
    }

    let payload;
    try {
        payload = JSON.parse(fromBase64Url(parts[0]).toString('utf8'));
    } catch (e) {
        return { valid: false, reason: 'That does not look like a Lazy-Image activation key.' };
    }

    let signatureOk = false;
    try {
        signatureOk = crypto.verify(null, Buffer.from(parts[0], 'utf8'), PUBLIC_KEY, fromBase64Url(parts[1]));
    } catch (e) {
        return { valid: false, reason: 'This key could not be checked on this computer (' + e.message + ').' };
    }
    if (!signatureOk) return { valid: false, reason: 'This activation key is not valid.' };
    if (payload.m !== machineId()) {
        return { valid: false, reason: 'This key was issued for a different computer. Send your Machine ID to get a key for this one.' };
    }
    return { valid: true, email: payload.e || '', issued: payload.i || '' };
}

function activate(keyString) {
    const result = verify(keyString);
    if (!result.valid) return result;
    try {
        fs.mkdirSync(APP_DIR, { recursive: true });
        fs.writeFileSync(LICENSE_FILE, String(keyString).replace(/\s+/g, ''), 'utf8');
    } catch (e) {
        return { valid: false, reason: 'The key is valid but could not be saved: ' + e.message };
    }
    return result;
}

// Re-verified on every call rather than trusted once, so copying license.key to another
// computer does not activate it there.
function status() {
    let stored = '';
    try { stored = fs.readFileSync(LICENSE_FILE, 'utf8'); } catch (e) {}
    if (!stored) return { activated: false, machineId: machineId() };
    const result = verify(stored);
    return { activated: result.valid, email: result.email || '', machineId: machineId() };
}

window.LazyLicense = { machineId, verify, activate, status };

})();
