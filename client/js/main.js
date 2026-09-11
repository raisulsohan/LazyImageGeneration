// === INITIALIZATION ===
const csInterface = new CSInterface();
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const IMAGE_FOLDER_NAME = 'chatgptimages';
const PROJECT_BIN_NAME = 'ChatGptImages';

// The same panel runs in After Effects and Premiere Pro; only the import step differs per host.
const HOST_ID = (csInterface.hostEnvironment && csInterface.hostEnvironment.appName) || 'AEFT';
const IS_PREMIERE = HOST_ID === 'PPRO';
const HOST_NAME = IS_PREMIERE ? 'Premiere Pro' : 'After Effects';

let isGenerating = false;
let isLoggingIn = false;
let isTesting = false;

// Only the paid build ships js/license.js; without it the panel is unrestricted.
const LICENSING = typeof window !== 'undefined' && !!window.LazyLicense;
let imageFolderWatcher = null;
let watchedImageFolder = null;

// === EVENT LISTENERS ===
document.addEventListener('DOMContentLoaded', () => {
    initializeUI();
    refreshLicenseUI();
    updateConnectionUI();
    refreshImageFolderWatch();
});

// The open project can change while the panel stays open; re-check whenever the panel is used.
window.addEventListener('focus', refreshImageFolderWatch);

// === UI INITIALIZATION ===
function initializeUI() {
    const hostTag = document.getElementById('hostTag');
    if (hostTag) hostTag.textContent = HOST_NAME;

    // Aspect ratio presets
    document.querySelectorAll('.ratio-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (btn.dataset.ratio !== 'custom') {
                document.getElementById('customRatioInput').style.display = 'none';
            } else {
                document.getElementById('customRatioInput').style.display = 'flex';
            }
        });
    });

    // Generate button
    document.getElementById('generateBtn').addEventListener('click', handleGenerate);

    // Ctrl+Enter to generate
    document.getElementById('promptInput').addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
            handleGenerate();
        }
    });

    // Cancel button
    const cancelBtn = document.getElementById('cancelBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', handleCancel);
    }

    // Login button
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
        loginBtn.addEventListener('click', handleLogin);
    }

    // Test button
    const testBtn = document.getElementById('testBtn');
    if (testBtn) {
        testBtn.addEventListener('click', handleTest);
    }

    // Activation (paid build only)
    const activateBtn = document.getElementById('activateBtn');
    if (activateBtn) activateBtn.addEventListener('click', handleActivate);
    const copyMachineBtn = document.getElementById('copyMachineBtn');
    if (copyMachineBtn) copyMachineBtn.addEventListener('click', handleCopyMachineId);

    // Copy button
    const copyBtn = document.getElementById('copyBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', handleCopyImage);
    }

    // Open folder button
    const openBtn = document.getElementById('openFolderBtn');
    if (openBtn) {
        openBtn.addEventListener('click', handleOpenFolder);
    }
}

// === HANDLE LOGIN ===
// Opens a visible browser window once; it closes by itself after a successful login.
async function handleLogin() {
    if (isLoggingIn || isGenerating) return;
    isLoggingIn = true;
    updateConnectionUI();
    showStatus('Opening a browser window for ChatGPT...', 'loading');

    try {
        const result = await BrowserBridge.login((event) => {
            if (event === 'opened') {
                const browserName = BrowserBridge.getStatus().browserName || 'browser';
                showStatus('🌐 Log in to ChatGPT in the ' + browserName + ' window — it closes by itself when you are done.', 'warning');
            } else if (event === 'already') {
                showStatus('✅ You are already logged in. Close the browser window when you are done.', 'success');
            } else if (event === 'verifying') {
                showStatus('Checking your ChatGPT login...', 'loading');
            }
        });

        if (result.loggedIn) {
            showStatus('✅ Logged in to ChatGPT! Generate images right here — no browser needed.', 'success');
        } else {
            showStatus('⚠️ Login was not completed. Click "Login to ChatGPT" to try again.', 'error');
        }
    } catch (e) {
        showStatus('❌ ' + e.message, 'error');
    } finally {
        isLoggingIn = false;
        updateConnectionUI();
    }
}

// === ACTIVATION (paid build only) ===
// Shows the activation screen until a key signed for this machine is stored.
function refreshLicenseUI() {
    const overlay = document.getElementById('activationOverlay');
    if (!overlay) return true;
    if (!LICENSING) {
        overlay.hidden = true;
        return true;
    }
    const status = window.LazyLicense.status();
    const idEl = document.getElementById('machineId');
    if (idEl) idEl.textContent = status.machineId;
    overlay.hidden = status.activated;
    return status.activated;
}

function handleActivate() {
    const input = document.getElementById('licenseKeyInput');
    const error = document.getElementById('activationError');
    const result = window.LazyLicense.activate(input ? input.value : '');
    if (result.valid) {
        if (error) error.hidden = true;
        if (input) input.value = '';
        refreshLicenseUI();
        showStatus('✅ Activated — thank you! Log in to ChatGPT to get started.', 'success');
    } else if (error) {
        error.textContent = result.reason;
        error.hidden = false;
    }
}

function handleCopyMachineId() {
    const idEl = document.getElementById('machineId');
    if (!idEl) return;
    const helper = document.createElement('textarea');
    helper.value = idEl.textContent;
    document.body.appendChild(helper);
    helper.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(helper);
    showToast('📋 Machine ID copied');
}

// === HANDLE TEST ===
// Checks browser, login and ChatGPT's chat box without generating anything.
async function handleTest() {
    if (isGenerating || isLoggingIn || isTesting) return;
    isTesting = true;
    updateConnectionUI();
    showStatus('🔍 Testing the ChatGPT connection…', 'loading');

    try {
        const report = await BrowserBridge.diagnose();
        const parts = [
            'Browser: ' + (report.browserName || 'not found'),
            'Login: ' + (report.loggedIn ? 'OK' : 'not logged in'),
            'Chat box: ' + (report.composer ? 'found' : 'not found'),
            'Send button: ' + (report.send ? 'found' : 'not found')
        ];
        const ok = report.loggedIn && report.composer && report.send;
        showStatus((ok ? '✅ Everything works — ' : '⚠️ ') + parts.join(' · ') +
            (report.error && !ok ? ' — ' + report.error : ''), ok ? 'success' : 'warning');
    } catch (e) {
        showStatus('❌ ' + e.message, 'error');
    } finally {
        isTesting = false;
        updateConnectionUI();
    }
}

// === HANDLE GENERATE ===
async function handleGenerate() {
    if (isGenerating) return;
    if (!refreshLicenseUI()) return;
    if (isTesting) {
        showStatus('Wait for the connection test to finish.', 'warning');
        return;
    }
    if (isLoggingIn) {
        showStatus('Finish the ChatGPT login (or close the browser window) first.', 'warning');
        return;
    }

    const prompt = document.getElementById('promptInput').value.trim();
    if (!prompt) {
        showStatus('Please enter an image prompt.', 'error');
        return;
    }

    // Get aspect ratio
    const activeRatioBtn = document.querySelector('.ratio-btn.active');
    let aspectRatio = activeRatioBtn ? activeRatioBtn.dataset.ratio : '1:1';
    if (aspectRatio === 'custom') {
        const w = document.getElementById('ratioW').value || '16';
        const h = document.getElementById('ratioH').value || '9';
        aspectRatio = w + ':' + h;
    }

    // Set generating state
    isGenerating = true;
    setGeneratingUI(true);
    showPreviewLoading();
    updateConnectionUI();

    const expectedCreateMs = loadExpectedCreateMs();
    let stage = 'launch';
    let stageMessage = 'Starting...';
    let createStartedAt = 0;
    const renderProgress = () => {
        const createElapsed = createStartedAt ? Date.now() - createStartedAt : 0;
        showStatus('🔄 ' + stageMessage + ' ' + estimateProgress(stage, createElapsed, expectedCreateMs) + '%', 'loading');
    };
    renderProgress();
    const ticker = setInterval(renderProgress, 1000);

    try {
        const result = await BrowserBridge.generate(prompt, aspectRatio, (message, newStage) => {
            if (newStage === 'create' && !createStartedAt) createStartedAt = Date.now();
            if (newStage === 'download' && stage === 'create') rememberCreateDuration(Date.now() - createStartedAt);
            stage = newStage || stage;
            stageMessage = message;
            renderProgress();
        });
        clearInterval(ticker);
        await processResult(result);
    } catch (e) {
        clearInterval(ticker);
        if (e.code === 'CANCELLED') {
            showStatus('Generation cancelled.', 'warning');
        } else if (NEEDS_YOU.indexOf(e.code) !== -1) {
            // Nothing is broken — ChatGPT needs something from the user, or has changed.
            showStatus('⚠️ ' + e.message, 'warning');
        } else {
            showStatus('❌ ' + e.message, 'error');
        }
    } finally {
        clearInterval(ticker);
        isGenerating = false;
        setGeneratingUI(false);
        hidePreviewLoading();
        updateConnectionUI();
    }
}

// Failures the user can act on, shown as a warning rather than a red error.
const NEEDS_YOU = ['NOT_LOGGED_IN', 'CHALLENGE', 'DIALOG', 'RATE_LIMIT', 'CHATGPT_BLOCKED', 'UI_CHANGED', 'NO_IMAGE'];

// === PROGRESS ESTIMATE ===
// ChatGPT doesn't report real progress, so the percentage is an estimate: fixed steps while
// starting up, then a curve based on how long recent image creations took. It rises linearly
// up to the expected duration and then creeps toward (never reaching) 95% until the image arrives.
const STAGE_PROGRESS = { launch: 2, load: 6, send: 10, download: 97 };
const CREATE_ESTIMATE_KEY = 'lazyimage_expected_create_ms';
const DEFAULT_CREATE_MS = 40000;

function estimateProgress(stage, createElapsedMs, expectedCreateMs) {
    if (stage !== 'create') return STAGE_PROGRESS[stage] || 0;
    const x = createElapsedMs / expectedCreateMs;
    const f = x <= 1 ? 0.85 * x : 0.85 + 0.15 * (1 - Math.exp(-2 * (x - 1)));
    return Math.round(10 + 85 * f);
}

function loadExpectedCreateMs() {
    try {
        const ms = parseInt(localStorage.getItem(CREATE_ESTIMATE_KEY), 10);
        if (ms >= 10000 && ms <= 300000) return ms;
    } catch (e) {}
    return DEFAULT_CREATE_MS;
}

function rememberCreateDuration(ms) {
    try {
        const next = Math.round(0.6 * loadExpectedCreateMs() + 0.4 * ms);
        localStorage.setItem(CREATE_ESTIMATE_KEY, String(Math.min(300000, Math.max(10000, next))));
    } catch (e) {}
}

function handleCancel() {
    if (!isGenerating) return;
    showStatus('Cancelling...', 'warning');
    BrowserBridge.cancel();
}

// === FIND PROJECT FOLDER (asks the host app for the open project's file) ===
function getProjectFolder() {
    return new Promise((resolve) => {
        const script = IS_PREMIERE
            ? '(function(){ try { return (app.project && app.project.path) ? app.project.path : ""; } catch (e) { return ""; } })()'
            : '(function(){ try { return (app.project && app.project.file) ? app.project.file.fsName : ""; } catch (e) { return ""; } })()';
        csInterface.evalScript(script, (result) => {
            const dir = result && result.indexOf('EvalScript') !== 0 ? path.dirname(result) : null;
            resolve(dir && fs.existsSync(dir) ? dir : null);
        });
    });
}

// === IMAGE FOLDER: <project folder>/chatgptimages, or Documents/chatgptimages for unsaved projects ===
async function getImageFolder() {
    const projectFolder = await getProjectFolder();
    return path.join(projectFolder || path.join(os.homedir(), 'Documents'), IMAGE_FOLDER_NAME);
}

async function refreshImageFolderWatch() {
    watchImageFolder(await getImageFolder());
}

// Shows a tip whenever an image disappears from the image folder. Windows reports deletes,
// moves to the Recycle Bin and renames all as "rename"; a rename also makes a new name appear,
// so events are batched and only net disappearances count.
function watchImageFolder(folder) {
    if (folder === watchedImageFolder && imageFolderWatcher) return;
    if (imageFolderWatcher) imageFolderWatcher.close();
    imageFolderWatcher = null;
    watchedImageFolder = null;
    if (!fs.existsSync(folder)) return;

    let gone = 0;
    let appeared = 0;
    let batchTimer = null;
    let watcher;
    try {
        watcher = fs.watch(folder, (eventType, fileName) => {
            if (eventType !== 'rename' || !fileName || !/\.(png|jpe?g|webp)$/i.test(fileName)) return;
            if (fs.existsSync(path.join(folder, fileName))) appeared++;
            else gone++;
            clearTimeout(batchTimer);
            batchTimer = setTimeout(() => {
                const removed = gone - appeared;
                gone = 0;
                appeared = 0;
                if (removed > 0) showToast('🗑️ ' + (removed === 1 ? 'Image removed' : removed + ' images removed'));
            }, 400);
        });
    } catch (e) {
        return;
    }
    watcher.on('error', () => {
        watcher.close();
        if (imageFolderWatcher === watcher) {
            imageFolderWatcher = null;
            watchedImageFolder = null;
        }
    });
    imageFolderWatcher = watcher;
    watchedImageFolder = folder;
}

// === AUTO-IMPORT INTO THE PROJECT AND TIMELINE ===
function autoImportToTimeline(filePath) {
    try {
        const safePath = filePath.replace(/\\/g, '/').replace(/"/g, '\\"');
        const script = (IS_PREMIERE ? buildPremiereImportScript(safePath) : buildAfterEffectsImportScript(safePath))
            .replace(/[\r\n]+/g, ' ');

        csInterface.evalScript(script, (result) => {
            console.log(HOST_NAME + ' import result:', result);
            if (result && result.startsWith('SUCCESS|')) {
                showStatus('✅ Generated & added to timeline (' + result.substring(8) + ')', 'success');
            } else if (result && result.startsWith('SUCCESS_BIN_ONLY|')) {
                showStatus('✅ Generated & added to the ' + PROJECT_BIN_NAME + ' bin (no free video track at the playhead in ' + result.substring(17) + ')', 'warning');
            } else if (result === 'SUCCESS_PROJECT') {
                showStatus('✅ Generated & imported into ' + PROJECT_BIN_NAME + ' (open a ' + (IS_PREMIERE ? 'sequence' : 'comp') + ' to add it to the timeline)', 'warning');
            } else if (result && result.startsWith('ERROR|')) {
                console.error('Import error detail:', result);
                showStatus('✅ Saved to disk. ' + HOST_NAME + ' import: ' + result.substring(6), 'warning');
            } else {
                showStatus('✅ Saved to disk, but ' + HOST_NAME + ' could not import it (' + result + ')', 'warning');
            }
        });
    } catch(e) {
        console.error('Timeline import error:', e);
    }
}

// After Effects: import into the ChatGptImages folder and add a layer at the playhead of the
// active comp (or the first comp in the project).
function buildAfterEffectsImportScript(safePath) {
    return `
(function() {
    try {
        var f = new File("${safePath}");
        if (!f.exists) return "FILE_NOT_FOUND";

        app.beginUndoGroup("Lazy-Image: Auto Import");
        var io = new ImportOptions(f);
        io.importAs = ImportAsType.FOOTAGE;
        io.sequence = false;
        var footage = app.project.importFile(io);
        if (!footage) {
            app.endUndoGroup();
            return "IMPORT_FAILED";
        }

        var bin = null;
        for (var b = 1; b <= app.project.numItems; b++) {
            var candidate = app.project.item(b);
            if (candidate instanceof FolderItem && candidate.name.toLowerCase() === "${PROJECT_BIN_NAME}".toLowerCase()) {
                bin = candidate;
                break;
            }
        }
        if (!bin) bin = app.project.items.addFolder("${PROJECT_BIN_NAME}");
        footage.parentFolder = bin;

        var targetComp = null;
        if (app.project.activeItem && app.project.activeItem instanceof CompItem) {
            targetComp = app.project.activeItem;
        } else {
            for (var i = 1; i <= app.project.numItems; i++) {
                var it = app.project.item(i);
                if (it instanceof CompItem) {
                    targetComp = it;
                    break;
                }
            }
        }

        if (targetComp) {
            var layer = targetComp.layers.add(footage);
            try { layer.startTime = targetComp.time; } catch(tErr) {}
            app.endUndoGroup();
            return "SUCCESS|" + targetComp.name;
        } else {
            app.endUndoGroup();
            return "SUCCESS_PROJECT";
        }
    } catch(e) {
        try { app.endUndoGroup(); } catch(err) {}
        return "ERROR|" + e.toString();
    }
})();
`;
}

// Premiere Pro: import into the ChatGptImages bin and place the still at the playhead of the
// active sequence, on the video track just above everything the still would cover (a track is
// added when the top track is taken). Existing clips are never overwritten: if no free track is
// found, the image stays in the bin. Track indices are re-checked after adding a track, so this
// stays safe wherever Premiere inserts it.
function buildPremiereImportScript(safePath) {
    return `
(function() {
    try {
        var filePath = "${safePath}";
        var BIN_TYPE = (typeof ProjectItemType !== "undefined") ? ProjectItemType.BIN : 2;
        var root = app.project.rootItem;
        var findBin = function() {
            for (var i = 0; i < root.children.numItems; i++) {
                var child = root.children[i];
                if (child && child.type === BIN_TYPE && child.name.toLowerCase() === "${PROJECT_BIN_NAME}".toLowerCase()) return child;
            }
            return null;
        };
        var bin = findBin();
        if (!bin) {
            root.createBin("${PROJECT_BIN_NAME}");
            bin = findBin();
        }
        if (!bin) bin = root;
        if (!app.project.importFiles([filePath], true, bin, false)) return "IMPORT_FAILED";

        var normalize = function(p) { return String(p).split(String.fromCharCode(92)).join("/").toLowerCase(); };
        var item = null;
        for (var j = bin.children.numItems - 1; j >= 0; j--) {
            var candidate = bin.children[j];
            if (candidate && candidate.type !== BIN_TYPE && normalize(candidate.getMediaPath()) === normalize(filePath)) {
                item = candidate;
                break;
            }
        }
        var seq = app.project.activeSequence;
        if (!item || !seq) return "SUCCESS_PROJECT";

        var pos = seq.getPlayerPosition();
        var t = pos.seconds;
        var duration = 5;
        try {
            var d = item.getOutPoint().seconds - item.getInPoint().seconds;
            if (d > 0 && d < 600) duration = d;
        } catch (dErr) {}
        var trackCount = function(s) {
            var n = s.videoTracks.numTracks;
            return (typeof n === "number") ? n : -1;
        };
        var topBusyTrack = function(s) {
            var top = -1;
            for (var k = 0; k < trackCount(s); k++) {
                var clips = s.videoTracks[k].clips;
                if (typeof clips.numItems !== "number") {
                    top = k;
                    continue;
                }
                for (var m = 0; m < clips.numItems; m++) {
                    if (clips[m].start.seconds < t + duration && clips[m].end.seconds > t) {
                        top = k;
                        break;
                    }
                }
            }
            return top;
        };
        if (trackCount(seq) < 0) return "SUCCESS_BIN_ONLY|" + seq.name;
        var target = topBusyTrack(seq) + 1;
        if (target >= trackCount(seq)) {
            try {
                app.enableQE();
                qe.project.getActiveSequence().addTracks(1, trackCount(seq), 0);
            } catch (qeErr) {}
            seq = app.project.activeSequence;
            target = topBusyTrack(seq) + 1;
        }
        if (target >= trackCount(seq)) return "SUCCESS_BIN_ONLY|" + seq.name;

        var before = seq.videoTracks[target].clips.numItems;
        try { seq.videoTracks[target].overwriteClip(item, pos.ticks); } catch (e1) {}
        if (seq.videoTracks[target].clips.numItems === before) {
            try { seq.videoTracks[target].overwriteClip(item, t); } catch (e2) {}
        }
        if (seq.videoTracks[target].clips.numItems === before) return "SUCCESS_BIN_ONLY|" + seq.name;
        return "SUCCESS|" + seq.name;
    } catch (e) {
        return "ERROR|" + e.toString();
    }
})();
`;
}

// === PROCESS RESULT ===
async function processResult(result) {
    if (!result) return;

    if (!result.success) {
        showStatus(result.error || 'Failed to generate image.', 'error');
        return;
    }

    // Save image to disk
    showStatus('Saving image to project folder...', 'loading');

    const imageBuffer = Buffer.from(result.imageBase64, 'base64');
    const format = result.format || 'png';

    const saveDir = await getImageFolder();
    if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
    }

    const fileName = 'lazy_image_' + (result.provider || 'chatgpt') + '_' + Date.now() + '.' + format;
    const filePath = path.join(saveDir, fileName);
    fs.writeFileSync(filePath, imageBuffer);
    watchImageFolder(saveDir);

    // Show preview in panel
    showPreviewImage(filePath);

    // Update footer meta
    const footerMeta = document.querySelector('.footer-meta');
    if (footerMeta) {
        footerMeta.textContent = (result.dimensions || '') + ' ' + format.toUpperCase();
    }

    // Automatically import into active comp / timeline
    autoImportToTimeline(filePath);

    window.currentGeneratedImagePath = filePath;
    const btnContainer = document.getElementById('actionButtons');
    if (btnContainer) btnContainer.style.display = 'flex';
}

// === MANUAL ACTIONS ===
function handleCopyImage() {
    if (!window.currentGeneratedImagePath) return;

    try {
        const safePath = window.currentGeneratedImagePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        const cmd = 'powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile(\'' + safePath + '\'))"';
        cp.exec(cmd, { windowsHide: true }, (err) => {
            if (err) {
                showStatus('❌ Failed to copy: ' + err.message, 'error');
            } else {
                showStatus('✅ Image copied to clipboard!', 'success');
            }
        });
    } catch (e) {
        showStatus('❌ Failed to copy: ' + e.message, 'error');
    }
}

function handleOpenFolder() {
    if (!window.currentGeneratedImagePath) return;
    try {
        const folderPath = path.dirname(window.currentGeneratedImagePath);
        cp.exec('explorer "' + folderPath + '"');
        showStatus('📂 Folder opened', 'success');
    } catch (e) {
        showStatus('❌ Failed to open folder: ' + e.message, 'error');
    }
}

// === UI HELPER FUNCTIONS ===

function updateConnectionUI() {
    const badge = document.querySelector('.connection-badge');
    const loginBtn = document.getElementById('loginBtn');
    if (!badge || !loginBtn) return;

    const status = BrowserBridge.getStatus();
    const busy = isLoggingIn || isGenerating || isTesting;
    loginBtn.disabled = busy;
    const testBtn = document.getElementById('testBtn');
    if (testBtn) {
        testBtn.disabled = busy;
        testBtn.textContent = isTesting ? '⏳ Testing...' : '🔍 Test';
    }

    if (isLoggingIn) {
        badge.textContent = 'Browser open';
        badge.className = 'connection-badge ready';
        loginBtn.textContent = '⏳ Waiting for login...';
    } else if (status.loggedIn) {
        badge.textContent = 'Logged in';
        badge.className = 'connection-badge connected';
        loginBtn.textContent = '🌐 Open ChatGPT';
        loginBtn.classList.add('subtle');
        loginBtn.title = 'Open ChatGPT in a browser window — only needed to switch accounts or complete a verification';
    } else {
        badge.textContent = 'Login required';
        badge.className = 'connection-badge login-required';
        loginBtn.textContent = '🌐 Login to ChatGPT';
        loginBtn.classList.remove('subtle');
        loginBtn.title = 'Open a browser window once to log in to ChatGPT';
    }
}

function showStatus(message, type) {
    const statusBar = document.getElementById('statusBar');
    const statusText = document.querySelector('.status-text');
    if (!statusBar || !statusText) return;

    statusBar.style.display = 'flex';
    statusText.textContent = message;
    statusBar.className = 'status-bar status-' + type;
}

let toastTimer = null;

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

function setGeneratingUI(loading) {
    const btn = document.getElementById('generateBtn');
    if (btn) {
        btn.disabled = loading;
        btn.innerHTML = loading
            ? '<span class="btn-spinner"></span> Generating...'
            : '✨ Generate Image';
    }
    const cancelBtn = document.getElementById('cancelBtn');
    if (cancelBtn) cancelBtn.hidden = !loading;
}

function showPreviewLoading() {
    const area = document.getElementById('previewArea');
    if (area) area.classList.add('loading');
}

function hidePreviewLoading() {
    const area = document.getElementById('previewArea');
    if (area) area.classList.remove('loading');
}

function showPreviewImage(filePath) {
    const area = document.getElementById('previewArea');
    const emptyState = area.querySelector('.empty-state');
    if (emptyState) emptyState.style.display = 'none';

    // Remove existing image if any
    const existingImg = area.querySelector('img');
    if (existingImg) existingImg.remove();

    const img = document.createElement('img');
    img.src = 'file:///' + filePath.replace(/\\/g, '/') + '?t=' + Date.now();
    img.alt = 'Generated Image';
    img.className = 'preview-image';
    area.appendChild(img);
}

// === CLEANUP on panel close: never leave the browser running behind the panel ===
window.addEventListener('beforeunload', () => {
    BrowserBridge.shutdown();
    if (imageFolderWatcher) imageFolderWatcher.close();
});
