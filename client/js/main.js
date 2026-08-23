// === INITIALIZATION ===
const csInterface = new CSInterface();
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const cp = require('child_process');

const SERVER_PORT = 7890;
let httpServer = null;
let pendingRequest = null;
let currentResult = null;
let currentProvider = 'chatgpt';
let isGenerating = false;
let chromeConnected = false;
let lastPingTime = 0;

// === HTTP SERVER ===
function startHttpServer() {
    httpServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        
        const parsedUrl = url.parse(req.url, true);
        
        if (parsedUrl.pathname === '/api/ping' && req.method === 'GET') {
            lastPingTime = Date.now();
            chromeConnected = true;
            updateConnectionUI();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
        }
        else if (parsedUrl.pathname === '/api/pending' && req.method === 'GET') {
            lastPingTime = Date.now();
            chromeConnected = true;
            updateConnectionUI();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (pendingRequest) {
                const request = { ...pendingRequest };
                pendingRequest = null;
                res.end(JSON.stringify(request));
            } else {
                res.end(JSON.stringify(null));
            }
        }
        else if (parsedUrl.pathname === '/api/result' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    currentResult = JSON.parse(body);
                    processResult(currentResult);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ received: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
        }
        else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });
    
    httpServer.listen(SERVER_PORT, '127.0.0.1', () => {
        console.log('Lazy-Image HTTP server running on http://127.0.0.1:' + SERVER_PORT);
    });
    
    httpServer.on('error', (err) => {
        console.error('HTTP Server error:', err);
        if (err.code === 'EADDRINUSE') {
            setTimeout(() => httpServer.listen(SERVER_PORT + 1, '127.0.0.1'), 1000);
        }
    });
}

// === CONNECTION MONITORING ===
setInterval(() => {
    const wasConnected = chromeConnected;
    chromeConnected = (Date.now() - lastPingTime) < 5000;
    if (wasConnected !== chromeConnected) {
        updateConnectionUI();
    }
}, 2000);

// === EVENT LISTENERS ===
document.addEventListener('DOMContentLoaded', () => {
    startHttpServer();
    initializeUI();
});

function initializeUI() {
    currentProvider = 'chatgpt';
    
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

// === HANDLE GENERATE ===
async function handleGenerate() {
    if (isGenerating) return;
    
    const prompt = document.getElementById('promptInput').value.trim();
    if (!prompt) {
        showStatus('Please enter an image prompt.', 'error');
        return;
    }
    
    if (!chromeConnected) {
        showStatus('Chrome Extension is not connected. Is Lazy-Image Extension running in Chrome?', 'error');
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
    setButtonLoading(true);
    showPreviewLoading();
    showStatus('Generating image with AI...', 'loading');
    
    // Create pending request for Chrome Extension to pick up
    const requestId = 'req_' + Date.now();
    pendingRequest = {
        id: requestId,
        prompt: prompt,
        provider: currentProvider,
        aspectRatio: aspectRatio
    };
    
    // Timeout after 180 seconds
    setTimeout(() => {
        if (isGenerating && pendingRequest && pendingRequest.id === requestId) {
            pendingRequest = null;
            isGenerating = false;
            setButtonLoading(false);
            hidePreviewLoading();
            showStatus('Timeout — Image generation took too long. Please try again.', 'error');
        }
    }, 180000);
}

// === FIND AE PROJECT FOLDER (reads AE preferences MRU list) ===
function findAEProjectFolder() {
    try {
        const aePrefsRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'After Effects');
        if (!fs.existsSync(aePrefsRoot)) return null;
        
        // Find all version folders sorted descending (newest first)
        const versionDirs = fs.readdirSync(aePrefsRoot)
            .filter(d => /^\d/.test(d))
            .sort((a, b) => parseFloat(b) - parseFloat(a));
        
        // Collect all MRU paths from all versions
        let mruPaths = [];
        for (const ver of versionDirs) {
            const prefsDir = path.join(aePrefsRoot, ver);
            if (!fs.existsSync(prefsDir)) continue;
            const files = fs.readdirSync(prefsDir).filter(f => f.endsWith('Prefs.txt'));
            for (const pf of files) {
                try {
                    const content = fs.readFileSync(path.join(prefsDir, pf), 'utf8');
                    const regex = /"MRU Project Path ID # \d+, File Path"\s*=\s*"([^"]+\.aep)"/g;
                    let m;
                    while ((m = regex.exec(content)) !== null) {
                        mruPaths.push(m[1]);
                    }
                } catch(e) {}
            }
        }
        
        // Find which MRU path actually exists AND was most recently modified
        let bestPath = null;
        let bestTime = 0;
        for (const p of mruPaths) {
            try {
                if (fs.existsSync(p)) {
                    const stat = fs.statSync(p);
                    if (stat.mtimeMs > bestTime) {
                        bestTime = stat.mtimeMs;
                        bestPath = p;
                    }
                }
            } catch(e) {}
        }
        
        if (bestPath) {
            return path.dirname(bestPath);
        }
    } catch(e) {
        console.log('AE project folder detection skipped:', e.message);
    }
    return null;
}

// === AUTO-IMPORT FOOTAGE TO TIMELINE ===
function autoImportToTimeline(filePath) {
    try {
        const safePath = filePath.replace(/\\/g, '/').replace(/"/g, '\\"');
        
        const script = `
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
`.replace(/[\r\n]+/g, ' ');

        csInterface.evalScript(script, (result) => {
            console.log('AE Import result:', result);
            if (result && result.startsWith('SUCCESS|')) {
                const compName = result.substring(8);
                showStatus('✅ Generated & added to timeline (' + compName + ')', 'success');
            } else if (result === 'SUCCESS_PROJECT') {
                showStatus('✅ Generated & imported into project (Open a comp to add to timeline)', 'warning');
            } else if (result && result.startsWith('ERROR|')) {
                console.error('Import error detail:', result);
                showStatus('✅ Saved to disk. AE Import: ' + result.substring(6), 'warning');
            }
        });
    } catch(e) {
        console.error('Timeline import error:', e);
    }
}

// === PROCESS RESULT ===
function processResult(result) {
    if (!result) return;
    isGenerating = false;
    setButtonLoading(false);
    hidePreviewLoading();
    
    if (!result.success) {
        showStatus(result.error || 'Failed to generate image.', 'error');
        return;
    }
    
    // Save image to disk
    showStatus('Saving image to project folder...', 'loading');
    
    const imageBuffer = Buffer.from(result.imageBase64, 'base64');
    const format = result.format || 'png';
    
    // Find AE project folder
    let saveDir = null;
    const aeFolder = findAEProjectFolder();
    if (aeFolder) {
        saveDir = path.join(aeFolder, 'AI_Generated');
    } else {
        // Fallback silently to Documents
        saveDir = path.join(os.homedir(), 'Documents', 'GImage_Generated');
    }
    
    if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
    }
    
    const fileName = 'lazy_image_' + result.provider + '_' + Date.now() + '.' + format;
    const filePath = path.join(saveDir, fileName);
    fs.writeFileSync(filePath, imageBuffer);
    
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
        cp.exec(cmd, (err) => {
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

function updateActiveTab() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.engine === currentProvider);
    });
}

function updateConnectionUI() {
    const badge = document.querySelector('.connection-badge');
    if (!badge) return;
    if (chromeConnected) {
        badge.textContent = 'Connected';
        badge.className = 'connection-badge connected';
    } else {
        badge.textContent = 'Disconnected';
        badge.className = 'connection-badge disconnected';
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

function setButtonLoading(loading) {
    const btn = document.getElementById('generateBtn');
    if (!btn) return;
    btn.disabled = loading;
    btn.innerHTML = loading 
        ? '<span class="btn-spinner"></span> Generating...'
        : '✨ Generate Image';
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
