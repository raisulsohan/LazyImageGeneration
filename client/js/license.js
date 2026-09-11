// ============================================================
// Lazy-Image: licensing
//
// Two kinds of key are accepted, told apart by their shape:
//
//   SupportKori  8B24E-ZZFM7-R52E6-J26ZN   — bought on supportkori.com. Checked
//                over the network against SupportKori, who are the source of truth.
//                They count the seats, so a refund or a disabled key locks the
//                panel by itself on the next launch.
//
//   Direct       <base64url>.<base64url>   — sold by email. An Ed25519 signature
//                made by the seller over the buyer's email and one machine ID.
//                Verified offline; this panel can only verify, never mint.
//
// The network check runs on activation and once per launch, never on the hot path:
// state() is synchronous and reads the cached result, so pressing Generate never
// waits on a web request and a flaky connection cannot stop someone working.
// ============================================================
(function() {

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'LazyImage');
const STATE_FILE = path.join(APP_DIR, 'license.json');
const LEGACY_FILE = path.join(APP_DIR, 'license.key');   // early builds stored the bare key

// A public id, like a Gumroad product id. SupportKori intend it to ship inside the
// software; the buyer's own key is the private half.
const PRODUCT_TOKEN = 'cvmOuCf0w9lBwTni7HP8ninX';
const VERIFY_URL = 'https://supportkori.com/api/licenses/verify';
const DEACTIVATE_URL = 'https://supportkori.com/api/licenses/deactivate';

const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\n' +
    'MCowBQYDK2VwAyEAAHMHHt3zmj9XkhHCxT0jBc+jIsDyF5oTaJ3aWPQEBtM=\n' +
    '-----END PUBLIC KEY-----\n';

const NETWORK_TIMEOUT = 12000;

// How long a checked-out licence keeps working when SupportKori cannot be reached.
// Their guide suggests a few hours; that is too short for this panel — someone on a
// deadline should not lose their tools because a server is down or a hotel wifi is
// blocking things. It costs nothing in piracy terms: anyone willing to edit the code
// ignores this number entirely, and blocking the domain still locks up after 14 days.
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const SUPPORT_EMAIL = 'lettertosohan@gmail.com';

const REASONS = {
    not_found: 'This key was not found. Check for a typo, or copy it again from your SupportKori email.',
    product_mismatch: 'This key belongs to a different product.',
    seat_limit_reached: 'This key is already in use on all of its computers. Free one up with ' +
        '"Deactivate this computer" on the machine you no longer use, or email ' + SUPPORT_EMAIL + '.',
    refunded: 'This order was refunded, so the key no longer works.',
    disabled: 'This key has been switched off. Email ' + SUPPORT_EMAIL + ' if that looks wrong.'
};

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

// === STORED STATE ===

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {}
    // An install from before SupportKori keys existed: adopt the bare key it left behind.
    try {
        const legacy = fs.readFileSync(LEGACY_FILE, 'utf8').replace(/\s+/g, '');
        if (legacy) return { key: legacy, kind: 'direct' };
    } catch (e) {}
    return null;
}

function writeState(state) {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function clearState() {
    try { fs.unlinkSync(STATE_FILE); } catch (e) {}
    try { fs.unlinkSync(LEGACY_FILE); } catch (e) {}
}

// === DIRECT KEYS (offline, Ed25519) ===

// URL-safe base64 by hand: Buffer's 'base64url' needs a newer Node than some CEP hosts ship.
function fromBase64Url(text) {
    return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyDirect(key) {
    const parts = String(key).split('.');
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

// === SUPPORTKORI KEYS (online) ===

function postJson(url, body) {
    return new Promise((resolve, reject) => {
        let https, URL;
        try {
            https = require('https');
            URL = require('url').URL;
        } catch (e) {
            return reject(new Error('This build cannot reach the internet to check the key.'));
        }
        const target = new URL(url);
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        let timedOut = false;

        const req = https.request({
            hostname: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) {}
                if (!parsed) return reject(new Error('The licence server sent something unreadable.'));
                resolve({ status: res.statusCode, body: parsed });
            });
        });

        req.setTimeout(NETWORK_TIMEOUT, () => { timedOut = true; req.destroy(); });
        req.on('error', (e) => reject(timedOut
            ? new Error('The licence server did not answer in time.')
            : new Error('Could not reach the licence server (' + e.message + ').')));
        req.end(payload);
    });
}

// increment: true only when claiming a seat. A plain re-check never consumes one.
async function verifyOnline(key, increment) {
    const body = { product_id: PRODUCT_TOKEN, license_key: key };
    if (increment) {
        body.increment_uses_count = true;
        body.instance_id = machineId();
    }
    const reply = await postJson(VERIFY_URL, body);
    if (reply.body && reply.body.valid) {
        return { valid: true, email: reply.body.email || '' };
    }
    const code = (reply.body && reply.body.reason) || '';
    return { valid: false, code: code, reason: REASONS[code] || 'This key was refused by SupportKori.' };
}

// === PUBLIC API ===

function looksDirect(key) {
    return key.indexOf('.') !== -1;
}

function cleanKey(raw) {
    const trimmed = String(raw || '').replace(/\s+/g, '');
    return looksDirect(trimmed) ? trimmed : trimmed.toUpperCase();
}

// Synchronous, no network: what the panel gates on. Reads the result the last
// network check wrote, so pressing Generate is instant even on a dead connection.
function state() {
    const stored = readState();
    if (!stored || !stored.key) return { activated: false, machineId: machineId() };

    if (stored.kind === 'direct') {
        const result = verifyDirect(stored.key);
        return { activated: result.valid, email: result.email || '', kind: 'direct', machineId: machineId() };
    }

    if (stored.revoked) {
        return { activated: false, kind: 'skori', machineId: machineId(), reason: stored.reason || '' };
    }
    const age = Date.now() - (stored.lastGood || 0);
    if (age > OFFLINE_GRACE_MS) {
        return {
            activated: false, kind: 'skori', machineId: machineId(),
            reason: 'Lazy-Image has not been able to reach SupportKori for two weeks. ' +
                'Connect to the internet and paste your key again.'
        };
    }
    return {
        activated: true, email: stored.email || '', kind: 'skori', machineId: machineId(),
        // True once the last check failed: the panel still works, but is running on borrowed time.
        offline: !!stored.lastCheckFailed
    };
}

// Claims a seat. Called when the buyer presses Activate.
async function activate(rawKey) {
    const key = cleanKey(rawKey);
    if (!key) return { valid: false, reason: 'Please paste your activation key.' };

    if (looksDirect(key)) {
        const result = verifyDirect(key);
        if (!result.valid) return result;
        try {
            writeState({ key: key, kind: 'direct', email: result.email || '' });
        } catch (e) {
            return { valid: false, reason: 'The key is valid but could not be saved: ' + e.message };
        }
        return result;
    }

    let result;
    try {
        result = await verifyOnline(key, true);
    } catch (e) {
        return { valid: false, reason: e.message + ' Check your internet connection and try again.' };
    }
    if (!result.valid) return result;

    try {
        writeState({ key: key, kind: 'skori', email: result.email || '', lastGood: Date.now(), lastCheckFailed: false });
    } catch (e) {
        return { valid: false, reason: 'The key is valid but could not be saved: ' + e.message };
    }
    return result;
}

// Re-checks a stored SupportKori key without claiming a seat. Run once per launch.
// A refused key locks the panel at once; an unreachable server only starts the
// grace clock, so an outage at SupportKori never strands a paying customer.
async function refresh() {
    const stored = readState();
    if (!stored || !stored.key || stored.kind === 'direct') return state();

    try {
        const result = await verifyOnline(stored.key, false);
        if (result.valid) {
            stored.lastGood = Date.now();
            stored.lastCheckFailed = false;
            stored.revoked = false;
            delete stored.reason;
            if (result.email) stored.email = result.email;
        } else {
            stored.revoked = true;
            stored.reason = result.reason;
        }
    } catch (e) {
        stored.lastCheckFailed = true;     // offline: leave lastGood alone and let the grace period run
    }

    try { writeState(stored); } catch (e) {}
    return state();
}

// Frees this machine's seat so the buyer can move to another computer.
async function deactivate() {
    const stored = readState();
    if (!stored || !stored.key) return { ok: true };

    if (stored.kind !== 'direct') {
        try {
            await postJson(DEACTIVATE_URL, {
                product_id: PRODUCT_TOKEN,
                license_key: stored.key,
                instance_id: machineId()
            });
        } catch (e) {
            // Keep the key installed: releasing the seat is the whole point, and dropping it
            // locally while SupportKori still counts it would strand the buyer on both machines.
            return { ok: false, reason: e.message + ' Nothing was changed — try again when you are online.' };
        }
    }

    clearState();
    return { ok: true };
}

window.LazyLicense = { machineId, state, activate, refresh, deactivate, SUPPORT_EMAIL: SUPPORT_EMAIL };

})();
