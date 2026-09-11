// ============================================================
// Lazy-Image: Browser Bridge
// Drives ChatGPT through the Chrome DevTools Protocol (CDP) using a
// dedicated profile of the Windows default browser (Chrome, Edge, …).
// The browser is started only for a login or for a
// single generation and is closed again right afterwards. During a
// generation its window is never shown (no taskbar button, no focus
// change). Zero npm dependencies.
// ============================================================
(function() {

const cp = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'LazyImage');
const LEGACY_AUTH_MARKER = path.join(APP_DIR, '.authenticated');   // pre-2.0 marker, Chrome only
const CHATGPT_URL = 'https://chatgpt.com/';
const LOGIN_URL = 'https://chatgpt.com/auth/login';
const CHATGPT_PAGE = /^https:\/\/(?:[a-z0-9-]+\.)*chatgpt\.com\//i;
const AUTH_PAGE = /^https:\/\/(?:auth\.openai\.com|auth0\.openai\.com|accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|appleid\.apple\.com)\/|^https:\/\/chatgpt\.com\/auth\//i;

const LAUNCH_TIMEOUT_MS = 20000;
const READY_TIMEOUT_MS = 60000;
const CHALLENGE_TIMEOUT_MS = 30000;
const UI_CHANGED_GRACE_MS = 20000;
const GENERATION_TIMEOUT_MS = 6 * 60 * 1000;
const TEXT_ONLY_REPLY_MS = 45000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

let session = null;        // the one browser this panel owns: { proc, visible, port, browserPath, exited }
let busy = false;
let cancelRequested = false;

const UI_CHANGED_MESSAGE = 'Lazy-Image could not find ChatGPT\'s chat box. ChatGPT has most likely changed its website — please check for a Lazy-Image update.';

// Failures worth one silent second attempt. Anything needing the user (login, verification,
// a usage limit, a refusal) is never retried, and neither is a timeout: the image may still
// be on its way, and a second 6-minute wait helps nobody.
const RETRYABLE = { LAUNCH_FAILED: true, BROWSER_CLOSED: true, CHATGPT_ERROR: true };

function bridgeError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function failureMessage(failure) {
    if (failure.code === 'RATE_LIMIT') {
        return 'ChatGPT has hit a usage limit: "' + failure.text + '" — wait for it to reset and try again.';
    }
    if (failure.code === 'CHATGPT_BLOCKED') {
        return 'ChatGPT flagged this session: "' + failure.text + '" — click "Open ChatGPT", check the browser window, then try again.';
    }
    return 'ChatGPT reported an error: "' + failure.text + '"';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// MINIMAL CDP WEBSOCKET CLIENT
// CEP's Node has no WebSocket, and the panel's own WebSocket sends an
// Origin header that Chrome's DevTools server rejects, so frames are
// handled here over a raw socket.
// ============================================================

class CdpConnection {
    constructor(socket, leftover) {
        this.socket = socket;
        this.chunks = [];
        this.buffered = 0;
        this.fragments = [];
        this.nextId = 0;
        this.pending = {};
        this.closed = false;

        socket.setNoDelay(true);
        socket.on('data', data => this._push(data));
        socket.on('close', () => this._teardown());
        socket.on('error', () => this._teardown());
        if (leftover && leftover.length) this._push(leftover);
    }

    send(method, params, timeoutMs) {
        if (this.closed) return Promise.reject(new Error('Connection to the browser was closed'));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                delete this.pending[id];
                reject(bridgeError('TIMEOUT', 'The browser did not answer (' + method + ')'));
            }, timeoutMs || 30000);
            this.pending[id] = { resolve, reject, timer };
            this._write(0x1, Buffer.from(JSON.stringify({ id, method, params: params || {} }), 'utf8'));
        });
    }

    close() {
        if (this.closed) return;
        try { this._write(0x8, Buffer.alloc(0)); } catch (e) {}
        try { this.socket.end(); } catch (e) {}
        this._teardown();
    }

    _teardown() {
        if (this.closed) return;
        this.closed = true;
        const pending = this.pending;
        this.pending = {};
        Object.keys(pending).forEach(id => {
            clearTimeout(pending[id].timer);
            pending[id].reject(new Error('Connection to the browser was closed'));
        });
    }

    _write(opcode, payload) {
        const length = payload.length;
        let header;
        if (length < 126) {
            header = Buffer.alloc(2);
            header[1] = 0x80 | length;
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[1] = 0x80 | 127;
            header.writeUInt32BE(Math.floor(length / 0x100000000), 2);
            header.writeUInt32BE(length >>> 0, 6);
        }
        header[0] = 0x80 | opcode;
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(length);
        for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3];
        this.socket.write(Buffer.concat([header, mask, masked]));
    }

    _push(data) {
        this.chunks.push(data);
        this.buffered += data.length;
        this._drain();
    }

    // Returns the first n buffered bytes as one contiguous Buffer.
    _peek(n) {
        if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks)];
        return this.chunks[0];
    }

    _consume(n) {
        this.chunks[0] = this.chunks[0].slice(n);
        if (!this.chunks[0].length) this.chunks.shift();
        this.buffered -= n;
    }

    _drain() {
        while (this.buffered >= 2) {
            const head = this._peek(Math.min(this.buffered, 14));
            const fin = (head[0] & 0x80) !== 0;
            const opcode = head[0] & 0x0f;
            const isMasked = (head[1] & 0x80) !== 0;
            let length = head[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffered < 4) return;
                length = head.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (this.buffered < 10) return;
                length = head.readUInt32BE(2) * 0x100000000 + head.readUInt32BE(6);
                offset = 10;
            }
            if (isMasked) offset += 4;
            if (this.buffered < offset + length) return;

            const frame = this._peek(offset + length);
            let payload = Buffer.from(frame.slice(offset, offset + length));
            if (isMasked) {
                const mask = frame.slice(offset - 4, offset);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }
            this._consume(offset + length);
            this._onFrame(fin, opcode, payload);
        }
    }

    _onFrame(fin, opcode, payload) {
        if (opcode === 0x8) return this.close();
        if (opcode === 0x9) return this._write(0xA, payload);
        if (opcode === 0x1 || opcode === 0x2) this.fragments = [payload];
        else if (opcode === 0x0) this.fragments.push(payload);
        else return;
        if (!fin) return;

        const text = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        const waiter = msg.id && this.pending[msg.id];
        if (!waiter) return;
        delete this.pending[msg.id];
        clearTimeout(waiter.timer);
        if (msg.error) waiter.reject(new Error(msg.error.message || 'The browser returned an error'));
        else waiter.resolve(msg.result);
    }
}

function openCdp(wsUrl) {
    return new Promise((resolve, reject) => {
        const m = /^ws:\/\/([^:/]+):(\d+)(\/.*)$/.exec(wsUrl || '');
        if (!m) return reject(new Error('Invalid DevTools URL: ' + wsUrl));

        const socket = net.createConnection({ host: m[1], port: parseInt(m[2], 10) });
        let head = Buffer.alloc(0);
        let settled = false;
        const fail = err => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(err);
        };

        socket.setTimeout(10000, () => fail(new Error('Timed out connecting to the browser')));
        socket.on('error', fail);
        socket.on('connect', () => {
            socket.write([
                'GET ' + m[3] + ' HTTP/1.1',
                'Host: ' + m[1] + ':' + m[2],
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64'),
                'Sec-WebSocket-Version: 13',
                '', ''
            ].join('\r\n'));
        });
        socket.on('data', function onData(data) {
            head = Buffer.concat([head, data]);
            const end = head.indexOf('\r\n\r\n');
            if (end === -1) return;
            socket.removeListener('data', onData);
            const status = head.slice(0, end).toString().split('\r\n')[0];
            if (!/ 101 /.test(status)) return fail(new Error('The browser refused the DevTools connection: ' + status));
            settled = true;
            socket.removeListener('error', fail);
            socket.setTimeout(0);
            resolve(new CdpConnection(socket, head.slice(end + 4)));
        });
    });
}

function httpJson(port, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: port, path: pathname, method: 'GET', timeout: 5000 }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Unexpected DevTools response')); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('DevTools HTTP timeout')));
        req.on('error', reject);
        req.end();
    });
}

async function evaluate(conn, fn, arg, timeoutMs) {
    const expression = '(' + fn.toString() + ')(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
    const res = await conn.send('Runtime.evaluate', {
        expression: expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
    }, (timeoutMs || 30000) + 5000);
    if (res.exceptionDetails) {
        const ex = res.exceptionDetails;
        throw new Error((ex.exception && ex.exception.description) || ex.text || 'Page script failed');
    }
    return res.result ? res.result.value : undefined;
}

function pressKey(conn, key, keyCode, modifiers, text) {
    const base = { key: key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: modifiers || 0 };
    const down = Object.assign({ type: text ? 'keyDown' : 'rawKeyDown' }, base, text ? { text: text, unmodifiedText: text } : {});
    return conn.send('Input.dispatchKeyEvent', down)
        .then(() => conn.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base)));
}

// ============================================================
// BROWSER PROCESS
// ============================================================

// Chromium-based browsers that speak the DevTools protocol, keyed by executable name.
const CHROMIUM_BROWSERS = {
    'chrome.exe': { id: 'chrome', name: 'Chrome' },
    'msedge.exe': { id: 'edge', name: 'Edge' },
    'brave.exe': { id: 'brave', name: 'Brave' },
    'vivaldi.exe': { id: 'vivaldi', name: 'Vivaldi' },
    'chromium.exe': { id: 'chromium', name: 'Chromium' }
};

let browserCache = { at: 0, value: null };

function regValue(key, valueName) {
    try {
        const out = cp.execFileSync('reg', ['query', key].concat(valueName ? ['/v', valueName] : ['/ve']),
            { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const match = out.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
        return match ? match[1].trim() : null;
    } catch (e) {
        return null;
    }
}

function exeFromCommand(command) {
    const match = /^\s*"([^"]+\.exe)"/i.exec(command || '') || /^\s*(\S+\.exe)/i.exec(command || '');
    return match && fs.existsSync(match[1]) ? match[1] : null;
}

function describeBrowser(exe) {
    const info = exe && CHROMIUM_BROWSERS[path.basename(exe).toLowerCase()];
    return info ? { exe: exe, id: info.id, name: info.name, profileDir: path.join(APP_DIR, info.name + 'Profile') } : null;
}

// The Windows default browser when it is Chromium-based (Firefox has no DevTools protocol
// support); otherwise Chrome, then Edge, which ships with Windows.
function findBrowser() {
    if (Date.now() - browserCache.at < 5000) return browserCache.value;

    // Newer Windows 11 builds keep the current choice in UserChoiceLatest\ProgId and can leave a
    // stale value in UserChoice, so the newer key wins.
    const choice = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https';
    const progId = regValue(choice + '\\UserChoiceLatest\\ProgId', 'ProgId') ||
        regValue(choice + '\\UserChoiceLatest', 'ProgId') ||
        regValue(choice + '\\UserChoice', 'ProgId');
    let browser = progId ? describeBrowser(exeFromCommand(regValue('HKCR\\' + progId + '\\shell\\open\\command'))) : null;

    if (!browser) {
        const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
        const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const local = process.env['LOCALAPPDATA'] || '';
        const fallbacks = [
            path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        ];
        browser = describeBrowser(fallbacks.find(p => fs.existsSync(p)) || registryAppPath('chrome.exe') || registryAppPath('msedge.exe'));
    }

    browserCache = { at: Date.now(), value: browser };
    return browser;
}

function registryAppPath(exeName) {
    const roots = ['HKLM', 'HKCU'];
    for (const root of roots) {
        try {
            const out = cp.execSync('reg query "' + root + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exeName + '" /ve',
                { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            const match = out.match(/REG_SZ\s+(.+\.exe)/i);
            if (match && fs.existsSync(match[1].trim())) return match[1].trim();
        } catch (e) {}
    }
    return null;
}

function powerShellArgs(script) {
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function runPowerShell(script, timeoutMs) {
    return new Promise(resolve => {
        cp.execFile('powershell.exe', powerShellArgs(script),
            { windowsHide: true, timeout: timeoutMs || 15000 }, (err, stdout) => resolve(err ? null : stdout));
    });
}

// Chrome activates its first window at startup. Launched right after a click in the panel it
// inherits the right to take the foreground, so even its hidden window would pull keyboard
// focus away from After Effects. LockSetForegroundWindow blocks that while Chrome starts; any
// click or Alt press by the user lifts the lock early. P/Invoke is emitted via reflection, so
// no C# compiler run is needed and this takes well under a second.
function lockForegroundWhileLaunching(lockMs) {
    const script = [
        "$ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'LazyImageFg'), 'Run')",
        "$tb = $ab.DefineDynamicModule('LazyImageFg').DefineType('Fg', 'Public, Class')",
        "$m = $tb.DefinePInvokeMethod('LockSetForegroundWindow', 'user32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [Type[]]@([uint32]), 'Winapi', 'Auto')",
        "$m.SetImplementationFlags('PreserveSig')",
        "$fg = $tb.CreateType()",
        "[Console]::Out.WriteLine('locked:' + $fg::LockSetForegroundWindow(1))",
        "[Console]::Out.Flush()",
        // Windows lifts the lock the moment the user clicks or presses a key, so re-assert it
        // for as long as the browser might still be starting up.
        "for ($i = 0; $i -lt " + Math.ceil(lockMs / 500) + "; $i++) { [void]$fg::LockSetForegroundWindow(1); Start-Sleep -Milliseconds 500 }",
        "[void]$fg::LockSetForegroundWindow(2)"
    ].join('; ');
    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve();
        };
        try {
            const helper = cp.spawn('powershell.exe', powerShellArgs(script), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            helper.stdout.on('data', data => { if (String(data).indexOf('locked:') !== -1) finish(); });
            helper.on('exit', finish);
            helper.on('error', finish);
        } catch (e) {
            finish();
        }
        setTimeout(finish, 4000);
    });
}

// Chrome holds <profile>\lockfile open while it runs; a deletable lockfile is stale.
function profileInUse(profileDir) {
    const lock = path.join(profileDir, 'lockfile');
    if (!fs.existsSync(lock)) return false;
    try { fs.unlinkSync(lock); return false; } catch (e) { return true; }
}

// Closes browser instances left running on our profile (a crash, or an older Lazy-Image version).
async function killProfileBrowsers(profileDir, exeName) {
    const needle = profileDir.replace(/'/g, "''");
    await runPowerShell(
        "Get-CimInstance Win32_Process -Filter \"Name='" + exeName.replace(/'/g, "''") + "'\" | " +
        "Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('" + needle + "', [StringComparison]::OrdinalIgnoreCase) -ge 0 } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }");
    for (let i = 0; i < 20 && profileInUse(profileDir); i++) await sleep(250);
}

async function launchBrowser(visible, url) {
    const browser = findBrowser();
    if (!browser) throw bridgeError('BROWSER_NOT_FOUND', 'No supported browser was found. Please install Google Chrome or Microsoft Edge.');
    if (session && !session.exited) await closeBrowser(session);

    fs.mkdirSync(browser.profileDir, { recursive: true });
    if (profileInUse(browser.profileDir)) await killProfileBrowsers(browser.profileDir, path.basename(browser.exe));
    const portFile = path.join(browser.profileDir, 'DevToolsActivePort');
    try { fs.unlinkSync(portFile); } catch (e) {}

    const args = [
        '--user-data-dir=' + browser.profileDir,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
    ];
    // The hidden window still needs a desktop-sized viewport, or ChatGPT switches to its mobile layout.
    if (!visible) args.push('--window-size=1280,900');
    args.push(url);

    if (!visible) await lockForegroundWhileLaunching(15000);

    checkCancelled();

    // windowsHide starts the browser with SW_HIDE: no window and no taskbar button, while the
    // page itself keeps rendering as "visible".
    const proc = cp.spawn(browser.exe, args, { detached: true, stdio: 'ignore', windowsHide: !visible });
    const s = { proc: proc, browser: browser, visible: visible, port: 0, browserPath: '', exited: false, closing: null };
    proc.on('exit', () => { s.exited = true; });
    proc.on('error', () => { s.exited = true; });
    proc.unref();
    session = s;

    try {
        const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
        while (Date.now() < deadline) {
            checkCancelled();
            if (s.exited) throw bridgeError('LAUNCH_FAILED', browser.name + ' closed right after starting. Please try again.');
            try {
                const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
                if (lines[0] && lines[1]) {
                    s.port = parseInt(lines[0], 10);
                    s.browserPath = lines[1].trim();
                    return s;
                }
            } catch (e) {}
            await sleep(200);
        }
        throw bridgeError('LAUNCH_FAILED', browser.name + ' did not start in time. Please try again.');
    } catch (e) {
        // Callers never get a handle to a half-started browser, so it must not outlive this call.
        forceKill(s);
        if (session === s) session = null;
        throw e;
    }
}

function closeBrowser(s) {
    if (!s) return Promise.resolve();
    if (session === s) session = null;
    if (!s.closing) s.closing = closeGracefully(s);
    return s.closing;
}

// Browser.close lets Chrome flush cookies to disk, so the login survives; taskkill is the fallback.
async function closeGracefully(s) {
    if (s.exited) return;
    if (s.port && s.browserPath) {
        try {
            const conn = await openCdp('ws://127.0.0.1:' + s.port + s.browserPath);
            await conn.send('Browser.close', {}, 3000).catch(() => {});
            conn.close();
        } catch (e) {}
        for (let i = 0; i < 30 && !s.exited; i++) await sleep(200);
    }
    if (!s.exited) forceKill(s);
}

function forceKill(s) {
    try {
        cp.spawnSync('taskkill', ['/PID', String(s.proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } catch (e) {}
    s.exited = true;
}

function checkCancelled() {
    if (cancelRequested) throw bridgeError('CANCELLED', 'Cancelled.');
}

function checkAlive(s) {
    checkCancelled();
    if (s.exited) throw bridgeError('BROWSER_CLOSED', 'The browser closed unexpectedly. Please try again.');
}

async function connectToChatGPT(s) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        checkAlive(s);
        try {
            const targets = await httpJson(s.port, '/json/list');
            const page = targets.find(t => t.type === 'page' && CHATGPT_PAGE.test(t.url) && t.webSocketDebuggerUrl);
            if (page) return await openCdp(page.webSocketDebuggerUrl);
        } catch (e) {}
        await sleep(300);
    }
    throw bridgeError('LAUNCH_FAILED', 'Could not open ChatGPT. Please try again.');
}

// ============================================================
// PAGE SCRIPTS (run inside chatgpt.com, passed via Function#toString)
// ============================================================

// ChatGPT's markup changes over time, so every hook is an ordered list and the first selector
// that matches wins — one rename then costs nothing. diagnose() reports which ones resolved.
const PAGE_HOOKS = {
    composer: [
        'div#prompt-textarea[contenteditable="true"]',
        '#prompt-textarea[contenteditable="true"]',
        'div[contenteditable="true"][id*="prompt"]',
        'form div[contenteditable="true"]',
        'textarea[name="prompt-textarea"]',
        'form textarea'
    ],
    send: [
        '#composer-submit-button[data-testid="send-button"]',
        '[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'form button[type="submit"]'
    ],
    // Literal text ChatGPT shows when a request fails. These are distinctive enough that a normal
    // reply will not contain them, and they are only ever matched outside the user's own messages.
    failures: [
        { pattern: 'reached our limit of messages', code: 'RATE_LIMIT' },
        { pattern: '(reached|hit)[^.]{0,24}(image|picture)[^.]{0,24}limit', code: 'RATE_LIMIT' },
        { pattern: 'limit (for|on) (generating |creating )?images', code: 'RATE_LIMIT' },
        { pattern: 'unusual activity (has been )?detected', code: 'CHATGPT_BLOCKED' },
        { pattern: 'error in message stream', code: 'CHATGPT_ERROR' },
        { pattern: 'there was an error generating a response', code: 'CHATGPT_ERROR' },
        { pattern: 'an error occurred while connecting to the websocket', code: 'CHATGPT_ERROR' },
        { pattern: 'a network error occurred', code: 'CHATGPT_ERROR' },
        { pattern: 'something went wrong', code: 'CHATGPT_ERROR' },
        { pattern: 'conversation not found', code: 'CHATGPT_ERROR' }
    ],
    // A finished reply saying one of these will never produce an image, so stop waiting for one.
    refusals: [
        'can\'?t (create|generate|make) ',
        'cannot (create|generate|make) ',
        'unable to (create|generate|make) ',
        'won\'?t be able to (create|generate)',
        'i\'?m not able to (create|generate)'
    ]
};

function pageSessionState() {
    return fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' })
        .then(res => res.json())
        .then(json => ({ known: true, loggedIn: !!(json && json.accessToken) }))
        .catch(() => ({ known: false, loggedIn: false }));
}

function pageLoadState(hooks) {
    const title = document.title || '';
    const text = document.body ? document.body.innerText.slice(0, 1500) : '';
    if (/just a moment|attention required/i.test(title) || /verify you are human|checking your browser|needs to review the security/i.test(text)) {
        return Promise.resolve({ state: 'challenge' });
    }
    if (document.readyState !== 'complete') return Promise.resolve({ state: 'loading' });
    return fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' })
        .then(res => res.json())
        .then(json => {
            if (!json || !json.accessToken) return { state: 'logged_out' };
            const composer = hooks.composer.map(s => document.querySelector(s)).find(Boolean);
            return { state: composer ? 'ready' : 'no_composer' };
        })
        .catch(() => ({ state: 'loading' }));
}

function pageDiagnose(hooks) {
    const pick = list => {
        for (let i = 0; i < list.length; i++) {
            if (document.querySelector(list[i])) return list[i];
        }
        return null;
    };
    return { composer: pick(hooks.composer), send: pick(hooks.send) };
}

function pageVisibleDialog() {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
        .find(el => el.offsetWidth || el.offsetHeight);
    return dialog ? (dialog.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160) || 'dialog' : '';
}

function pageFocusComposer(hooks) {
    const editor = hooks.composer.map(s => document.querySelector(s)).find(Boolean);
    if (!editor) return false;
    editor.focus();
    document.execCommand('selectAll', false, null);  // the next insertText replaces any draft
    return true;
}

function pageComposerText(hooks) {
    const editor = hooks.composer.map(s => document.querySelector(s)).find(Boolean);
    if (!editor) return null;
    return editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText;
}

function pageClickSend(hooks) {
    const button = hooks.send.map(s => document.querySelector(s)).find(Boolean);
    if (!button || button.disabled) return false;
    button.click();
    return true;
}

function pageSnapshotImages() {
    window.__lazyImageBefore = new Set(Array.from(document.images).map(img => img.currentSrc || img.src));
    // Error text already on screen belongs to an earlier message and must not fail this run.
    window.__lazyFailureBefore = document.body ? (document.body.innerText || '') : '';
    return document.querySelectorAll('[data-message-author-role="user"]').length;
}

function pageGenerationState(hooks) {
    const before = window.__lazyImageBefore || new Set();
    const images = [];
    Array.from(document.images).forEach(img => {
        const src = img.currentSrc || img.src;
        if (!src || before.has(src) || img.closest('nav, form, header, aside, [role="dialog"]')) return;
        if (img.naturalWidth < 256 || img.naturalHeight < 256) return;
        let blurred = false;
        for (let el = img, i = 0; el && i < 4; el = el.parentElement, i++) {
            if ((getComputedStyle(el).filter || '').indexOf('blur') !== -1) { blurred = true; break; }
        }
        images.push({ src: src, w: img.naturalWidth, h: img.naturalHeight, complete: img.complete, blurred: blurred });
    });
    const streaming = Array.from(document.querySelectorAll('button')).some(b =>
        /stop-button|stop streaming|stop generating/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.dataset.testid || '')));
    const main = document.querySelector('main') || document.body;
    const busyUi = !!main.querySelector('[role="progressbar"], [aria-busy="true"]') ||
        /creating image|generating image|editing image/i.test((main.innerText || '').slice(-3000));
    const replies = document.querySelectorAll('[data-message-author-role="assistant"]');
    const last = replies.length ? replies[replies.length - 1] : null;
    const lastText = last ? last.innerText.trim().replace(/\s+/g, ' ').slice(0, 400) : '';

    // Scan for ChatGPT's own error text. The user's own prompt is cut out first, so a prompt
    // like "a poster saying something went wrong" cannot fail its own generation.
    let scan = main.innerText || '';
    Array.from(document.querySelectorAll('[data-message-author-role="user"]')).forEach(el => {
        if (el.innerText) scan = scan.split(el.innerText).join(' ');
    });
    Array.from(document.querySelectorAll('[role="alert"]')).forEach(el => {
        const alertText = el.innerText || '';
        // Alerts usually sit inside main already; only add what is not there, so the message
        // reported back to the panel is not doubled up.
        if ((el.offsetWidth || el.offsetHeight) && alertText && scan.indexOf(alertText) === -1) {
            scan += '\n' + alertText;
        }
    });

    const seenBefore = window.__lazyFailureBefore || '';
    let failure = null;
    for (let i = 0; i < hooks.failures.length && !failure; i++) {
        const hit = new RegExp(hooks.failures[i].pattern, 'i').exec(scan);
        if (hit && seenBefore.indexOf(hit[0]) === -1) {
            failure = {
                code: hooks.failures[i].code,
                text: scan.slice(Math.max(0, hit.index - 40), hit.index + 160).replace(/\s+/g, ' ').trim()
            };
        }
    }
    let refusal = false;
    for (let i = 0; i < hooks.refusals.length && !refusal; i++) {
        if (new RegExp(hooks.refusals[i], 'i').test(lastText)) refusal = true;
    }

    return {
        images: images,
        streaming: streaming,
        busyUi: busyUi,
        failure: failure,
        refusal: refusal,
        userMessages: document.querySelectorAll('[data-message-author-role="user"]').length,
        text: lastText
    };
}

function pageDownloadImage(src) {
    const url = new URL(src, location.href);
    return fetch(url.href, { credentials: url.origin === location.origin ? 'include' : 'omit' })
        .then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.blob();
        })
        .then(blob => {
            const type = (blob.type || '').toLowerCase();
            if (type === 'image/png' || type === 'image/jpeg') return blob;
            // After Effects can't import WebP etc., so re-encode as PNG.
            return createImageBitmap(blob).then(bitmap => {
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                canvas.getContext('2d').drawImage(bitmap, 0, 0);
                return canvas.convertToBlob({ type: 'image/png' });
            });
        })
        .then(blob => blob.arrayBuffer().then(buffer => {
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return { b64: btoa(binary), type: blob.type };
        }));
}

// ============================================================
// CHATGPT FLOW
// ============================================================

async function waitForChatGPT(conn, s) {
    const start = Date.now();
    let challengeSince = 0;
    let noComposerSince = 0;
    for (;;) {
        checkAlive(s);
        let st;
        // A navigation (e.g. a Cloudflare redirect) can destroy the context mid-call; just retry.
        try { st = await evaluate(conn, pageLoadState, PAGE_HOOKS, 15000); } catch (e) { st = { state: 'loading' }; }

        if (st.state === 'ready') return;
        if (st.state === 'logged_out') {
            throw bridgeError('NOT_LOGGED_IN', 'You are not logged in to ChatGPT. Click "Login to ChatGPT" first.');
        }
        // Logged in, page fully loaded, but no chat box matched any known selector.
        if (st.state === 'no_composer') {
            noComposerSince = noComposerSince || Date.now();
            if (Date.now() - noComposerSince > UI_CHANGED_GRACE_MS) {
                throw bridgeError('UI_CHANGED', UI_CHANGED_MESSAGE);
            }
        } else {
            noComposerSince = 0;
        }
        if (st.state === 'challenge') {
            challengeSince = challengeSince || Date.now();
            if (Date.now() - challengeSince > CHALLENGE_TIMEOUT_MS) {
                throw bridgeError('CHALLENGE', 'ChatGPT wants a quick human verification. Click "Open ChatGPT", complete it in the browser window, close the window, then generate again.');
            }
        } else {
            challengeSince = 0;
        }
        if (Date.now() - start > READY_TIMEOUT_MS) {
            throw bridgeError('TIMEOUT', 'ChatGPT did not finish loading. Check your internet connection and try again.');
        }
        await sleep(1000);
    }
}

async function dismissDialogs(conn) {
    for (let i = 0; i < 2; i++) {
        const dialog = await evaluate(conn, pageVisibleDialog);
        if (!dialog) return;
        await pressKey(conn, 'Escape', 27);
        await sleep(600);
    }
    const dialog = await evaluate(conn, pageVisibleDialog);
    if (dialog) {
        throw bridgeError('DIALOG', 'ChatGPT is showing a message that needs your attention ("' + dialog + '"). Click "Open ChatGPT", handle it in the browser window, close the window, then generate again.');
    }
}

function squash(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

// Lines are joined with Shift+Enter (ChatGPT's newline); a raw "\n" could submit early.
async function typePrompt(conn, text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (!await evaluate(conn, pageFocusComposer, PAGE_HOOKS)) throw bridgeError('UI_CHANGED', UI_CHANGED_MESSAGE);
    for (let i = 0; i < lines.length; i++) {
        if (i > 0) await pressKey(conn, 'Enter', 13, 8);
        if (lines[i]) await conn.send('Input.insertText', { text: lines[i] });
    }
    await sleep(300);
    if (squash(await evaluate(conn, pageComposerText, PAGE_HOOKS)) === squash(text)) return;

    // Fallback: the whole prompt on one line.
    await evaluate(conn, pageFocusComposer, PAGE_HOOKS);
    await conn.send('Input.insertText', { text: squash(text) });
    await sleep(300);
    if (squash(await evaluate(conn, pageComposerText, PAGE_HOOKS)) !== squash(text)) {
        throw bridgeError('SEND_FAILED', 'Could not type the prompt into ChatGPT.');
    }
}

async function sendPrompt(conn, s, text) {
    await dismissDialogs(conn);
    await typePrompt(conn, text);
    const usersBefore = await evaluate(conn, pageSnapshotImages);

    let clicked = false;
    for (let i = 0; i < 20 && !clicked; i++) {
        checkAlive(s);
        clicked = await evaluate(conn, pageClickSend, PAGE_HOOKS);
        if (!clicked) await sleep(250);
    }
    if (!clicked) {
        await evaluate(conn, pageFocusComposer, PAGE_HOOKS);
        await pressKey(conn, 'End', 35);
        await pressKey(conn, 'Enter', 13, 0, '\r');
    }

    // Confirm ChatGPT accepted it: a new user message appears or the reply starts streaming.
    for (let i = 0; i < 30; i++) {
        checkAlive(s);
        await sleep(500);
        try {
            const st = await evaluate(conn, pageGenerationState, PAGE_HOOKS);
            // A usage limit or hard error shows up immediately; report it instead of waiting.
            if (st.failure) throw bridgeError(st.failure.code, failureMessage(st.failure));
            if (st.userMessages > usersBefore || st.streaming) return;
        } catch (e) {
            if (e.code) throw e;
        }
    }

    // Distinguish "ChatGPT moved its buttons" from "the send just didn't take".
    let hooks = null;
    try { hooks = await evaluate(conn, pageDiagnose, PAGE_HOOKS); } catch (e) {}
    if (hooks && (!hooks.composer || !hooks.send)) throw bridgeError('UI_CHANGED', UI_CHANGED_MESSAGE);
    throw bridgeError('SEND_FAILED', 'ChatGPT did not accept the prompt. Please try again.');
}

async function waitForImage(conn, s, progress) {
    const start = Date.now();
    let lastSrc = '';
    let stablePolls = 0;
    let textOnlySince = 0;

    for (;;) {
        checkAlive(s);
        let st = null;
        try { st = await evaluate(conn, pageGenerationState, PAGE_HOOKS, 15000); } catch (e) {}

        if (st) {
            // ChatGPT said outright that this failed — stop now instead of waiting out the timeout.
            if (st.failure) throw bridgeError(st.failure.code, failureMessage(st.failure));

            const settled = st.images.filter(img => img.complete && !img.blurred)
                .sort((a, b) => b.w * b.h - a.w * a.h)[0];
            if (settled) {
                stablePolls = settled.src === lastSrc ? stablePolls + 1 : 0;
                lastSrc = settled.src;
                // Once the reply has finished, a settled image is final; while ChatGPT still
                // looks busy, require it to stay unchanged longer so a preview isn't grabbed.
                if (stablePolls >= (st.streaming || st.busyUi ? 8 : 1)) return settled;
            } else {
                stablePolls = 0;
                lastSrc = '';
            }

            if (!st.images.length && !st.streaming && !st.busyUi && st.text) {
                // An outright refusal will never turn into an image; don't sit out the grace period.
                if (st.refusal) {
                    throw bridgeError('NO_IMAGE', 'ChatGPT declined to create this image: "' + st.text + '"');
                }
                textOnlySince = textOnlySince || Date.now();
                if (Date.now() - textOnlySince > TEXT_ONLY_REPLY_MS) {
                    throw bridgeError('NO_IMAGE', 'ChatGPT replied without an image: "' + st.text + '"');
                }
            } else {
                textOnlySince = 0;
            }
        }

        if (Date.now() - start > GENERATION_TIMEOUT_MS) {
            throw bridgeError('TIMEOUT', 'No image arrived within 6 minutes. ChatGPT may be busy — please try again.');
        }
        progress('ChatGPT is creating your image…', 'create');
        await sleep(1500);
    }
}

function downloadDirect(url) {
    return new Promise((resolve, reject) => {
        if (!/^https:\/\//i.test(url)) return reject(new Error('Unsupported image URL'));
        const req = https.get(url, { timeout: 60000 }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ b64: Buffer.concat(chunks).toString('base64'), type: String(res.headers['content-type'] || '') }));
        });
        req.on('timeout', () => req.destroy(new Error('Image download timed out')));
        req.on('error', reject);
    });
}

async function downloadImage(conn, image) {
    let data;
    try {
        data = await evaluate(conn, pageDownloadImage, image.src, 120000);
    } catch (pageErr) {
        try {
            data = await downloadDirect(image.src);
        } catch (e) {
            throw bridgeError('DOWNLOAD_FAILED', 'The image was created but could not be downloaded: ' + pageErr.message);
        }
    }
    const type = (data.type || '').toLowerCase();
    const format = type.indexOf('jpeg') !== -1 || type.indexOf('jpg') !== -1 ? 'jpg'
        : type.indexOf('webp') !== -1 ? 'webp' : 'png';
    return { b64: data.b64, format: format };
}

function buildPrompt(prompt, aspectRatio) {
    return 'Generate an image with aspect ratio ' + aspectRatio + '. Do not ask any follow-up questions, create the image directly: ' + prompt;
}

// ============================================================
// PUBLIC OPERATIONS
// ============================================================

function begin() {
    if (busy) throw bridgeError('BUSY', 'Lazy-Image is already working. Finish or close the current ChatGPT task first.');
    busy = true;
    cancelRequested = false;
}

function end() {
    busy = false;
}

function asProgress(fn) {
    return typeof fn === 'function' ? fn : function() {};
}

async function generate(prompt, aspectRatio, onProgress) {
    const progress = asProgress(onProgress);
    begin();
    try {
        try {
            return await attemptGenerate(prompt, aspectRatio, progress);
        } catch (e) {
            if (cancelRequested || !RETRYABLE[e.code]) throw e;
            progress('ChatGPT hiccuped — trying once more…', 'launch');
            await sleep(2000);
            return await attemptGenerate(prompt, aspectRatio, progress);
        }
    } finally {
        end();
    }
}

async function attemptGenerate(prompt, aspectRatio, progress) {
    let s = null;
    let conn = null;
    try {
        progress('Starting ChatGPT in the background…', 'launch');
        s = await launchBrowser(false, CHATGPT_URL);
        conn = await connectToChatGPT(s);
        progress('Loading ChatGPT…', 'load');
        await waitForChatGPT(conn, s);
        markAuthenticated(s.browser);

        progress('Sending prompt…', 'send');
        await sendPrompt(conn, s, buildPrompt(prompt, aspectRatio));
        const image = await waitForImage(conn, s, progress);

        progress('Downloading image…', 'download');
        const data = await downloadImage(conn, image);
        return {
            success: true,
            imageBase64: data.b64,
            format: data.format,
            dimensions: image.w + 'x' + image.h,
            provider: 'chatgpt'
        };
    } catch (e) {
        if (cancelRequested) throw bridgeError('CANCELLED', 'Generation cancelled.');
        if (e.code === 'NOT_LOGGED_IN' && s) clearAuthenticated(s.browser);
        throw e;
    } finally {
        if (conn) conn.close();
        await closeBrowser(s);
    }
}

// Checks the whole path without generating anything: browser, login, chat box, send button.
// Text typed to reveal the send button is cleared again and never sent.
async function diagnose() {
    begin();
    let s = null;
    let conn = null;
    const report = { browserName: null, loggedIn: false, composer: null, send: null, error: null };
    try {
        const browser = findBrowser();
        report.browserName = browser ? browser.name : null;
        if (!browser) {
            report.error = 'No supported browser was found. Please install Google Chrome or Microsoft Edge.';
            return report;
        }

        s = await launchBrowser(false, CHATGPT_URL);
        conn = await connectToChatGPT(s);
        try {
            await waitForChatGPT(conn, s);
            report.loggedIn = true;
            markAuthenticated(browser);
        } catch (e) {
            report.error = e.message;
            if (e.code === 'NOT_LOGGED_IN') {
                clearAuthenticated(browser);
                return report;
            }
            if (e.code !== 'UI_CHANGED') return report;
            report.loggedIn = true;   // logged in fine, only the chat box was missing
        }

        report.composer = (await evaluate(conn, pageDiagnose, PAGE_HOOKS)).composer;
        if (report.composer) {
            await evaluate(conn, pageFocusComposer, PAGE_HOOKS);
            await conn.send('Input.insertText', { text: 'test' });
            await sleep(400);
            report.send = (await evaluate(conn, pageDiagnose, PAGE_HOOKS)).send;
            await evaluate(conn, pageFocusComposer, PAGE_HOOKS);
            await pressKey(conn, 'Backspace', 8);
        }
        return report;
    } catch (e) {
        report.error = report.error || e.message;
        return report;
    } finally {
        if (conn) conn.close();
        await closeBrowser(s);
        end();
    }
}

// Silent check in the hidden browser; resolves true/false.
async function checkLoginHidden() {
    let s = null;
    let conn = null;
    try {
        s = await launchBrowser(false, CHATGPT_URL);
        conn = await connectToChatGPT(s);
        await waitForChatGPT(conn, s);
        markAuthenticated(s.browser);
        return true;
    } catch (e) {
        if (e.code === 'NOT_LOGGED_IN') {
            clearAuthenticated(s.browser);
            return false;
        }
        throw e;
    } finally {
        if (conn) conn.close();
        await closeBrowser(s);
    }
}

async function checkLogin() {
    begin();
    try { return await checkLoginHidden(); }
    finally { end(); }
}

// Reads login state from the visible login window without touching sign-in provider pages.
async function probeLoginWindow(s) {
    let targets;
    try { targets = await httpJson(s.port, '/json/list'); } catch (e) { return 'unknown'; }
    const pages = targets.filter(t => t.type === 'page');
    const onAuthPage = pages.some(t => AUTH_PAGE.test(t.url));
    const page = pages.find(t => CHATGPT_PAGE.test(t.url) && !AUTH_PAGE.test(t.url) && t.webSocketDebuggerUrl);
    if (!page) return onAuthPage ? 'logged_out' : 'unknown';

    let conn = null;
    try {
        conn = await openCdp(page.webSocketDebuggerUrl);
        const st = await evaluate(conn, pageSessionState, undefined, 10000);
        if (!st.known) return 'unknown';
        return st.loggedIn ? 'logged_in' : 'logged_out';
    } catch (e) {
        return 'unknown';
    } finally {
        if (conn) conn.close();
    }
}

// Restoring from minimized is the reliable way to bring a new window in front of After Effects.
async function raiseWindow(s) {
    let targets = [];
    for (let i = 0; i < 20 && !targets.length; i++) {
        try { targets = (await httpJson(s.port, '/json/list')).filter(t => t.type === 'page'); } catch (e) {}
        if (!targets.length) await sleep(250);
    }
    if (!targets.length) return;
    const conn = await openCdp('ws://127.0.0.1:' + s.port + s.browserPath);
    try {
        const win = await conn.send('Browser.getWindowForTarget', { targetId: targets[0].id });
        await conn.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'minimized' } });
        await sleep(150);
        await conn.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
    } finally {
        conn.close();
    }
}

// Opens a visible window for signing in. It closes by itself once a login completes;
// if the user was already logged in, it stays open until they close it (useful for
// verifications or ChatGPT notices). onProgress receives 'opened', 'already', 'verifying'.
async function login(onProgress) {
    const progress = asProgress(onProgress);
    begin();
    let s = null;
    try {
        s = await launchBrowser(true, LOGIN_URL);
        raiseWindow(s).catch(() => {});
        progress('opened');

        let sawLoggedOut = false;
        let alreadyLoggedIn = false;
        const deadline = Date.now() + LOGIN_TIMEOUT_MS;
        while (!s.exited && Date.now() < deadline) {
            checkCancelled();
            const state = await probeLoginWindow(s);
            if (state === 'logged_out') sawLoggedOut = true;
            if (state === 'logged_in') {
                markAuthenticated(s.browser);
                if (sawLoggedOut) {
                    await sleep(1500);
                    await closeBrowser(s);
                    return { loggedIn: true };
                }
                if (!alreadyLoggedIn) {
                    alreadyLoggedIn = true;
                    progress('already');
                }
            }
            await sleep(2000);
        }

        await closeBrowser(s);
        checkCancelled();
        if (alreadyLoggedIn) return { loggedIn: true };
        progress('verifying');
        return { loggedIn: await checkLoginHidden() };
    } catch (e) {
        if (cancelRequested) throw bridgeError('CANCELLED', 'Cancelled.');
        throw e;
    } finally {
        await closeBrowser(s);
        end();
    }
}

function cancel() {
    if (!busy) return;
    cancelRequested = true;
    if (session) closeBrowser(session);
}

// Synchronous teardown for panel unload: never leave Chrome running behind the panel.
function shutdown() {
    cancelRequested = true;
    if (session && !session.exited) forceKill(session);
    session = null;
}

function getStatus() {
    const browser = findBrowser();
    return {
        loggedIn: isAuthenticated(browser),
        browserName: browser ? browser.name : null,
        busy: busy,
        browserOpen: !!(session && !session.exited),
        windowVisible: !!(session && !session.exited && session.visible)
    };
}

// Each browser profile has its own ChatGPT session, so the "logged in" marker is per browser.
function authMarker(browser) {
    return path.join(APP_DIR, '.authenticated-' + browser.id);
}

function markAuthenticated(browser) {
    try {
        fs.mkdirSync(APP_DIR, { recursive: true });
        fs.writeFileSync(authMarker(browser), new Date().toISOString(), 'utf8');
    } catch (e) {
        console.error('[BrowserBridge] Failed to write auth marker:', e);
    }
}

function clearAuthenticated(browser) {
    try { fs.unlinkSync(authMarker(browser)); } catch (e) {}
    if (browser.id === 'chrome') {
        try { fs.unlinkSync(LEGACY_AUTH_MARKER); } catch (e) {}
    }
}

function isAuthenticated(browser) {
    browser = browser || findBrowser();
    if (!browser) return false;
    try {
        return fs.existsSync(authMarker(browser)) || (browser.id === 'chrome' && fs.existsSync(LEGACY_AUTH_MARKER));
    } catch (e) {
        return false;
    }
}

window.BrowserBridge = {
    generate,
    login,
    checkLogin,
    diagnose,
    cancel,
    shutdown,
    getStatus,
    findBrowser,
    isAuthenticated
};

})();
