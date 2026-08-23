// === CONFIG ===
const AE_SERVER = 'http://localhost:7890';
let isPolling = false;
let isConnected = false;
let lastError = null;

// === POLLING LOOP ===
// Polls GET AE_SERVER/api/pending for pending requests
chrome.alarms.create('pollAE', { periodInMinutes: 0.025 }); // ~1.5 seconds

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'pollAE') {
        await pollForRequests();
    }
});

async function pollForRequests() {
    if (isPolling) return;
    isPolling = true;
    
    try {
        const response = await fetch(`${AE_SERVER}/api/pending`);
        if (response.ok) {
            isConnected = true;
            const data = await response.json();
            if (data && data.id) {
                // Run in background without blocking poll loop
                handleRequest(data).catch(console.error);
            }
        } else {
            isConnected = false;
        }
    } catch (e) {
        isConnected = false;
        lastError = e.message;
    } finally {
        isPolling = false;
    }
}

async function handleRequest(request) {
    const { id, prompt, aspectRatio } = request;
    
    try {
        // Find or create ChatGPT tab
        const urlPattern = 'https://chatgpt.com/*';
        const targetUrl = 'https://chatgpt.com';
        
        let tabs = await chrome.tabs.query({ url: urlPattern });
        let tabId;
        
        if (tabs.length > 0) {
            tabId = tabs[0].id;
        } else {
            // Create new tab
            const newTab = await chrome.tabs.create({ url: targetUrl, active: false });
            tabId = newTab.id;
            await waitForTabLoad(tabId);
            await sleep(2000);
        }
        
        // Ensure the latest content script is active in the tab
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content-chatgpt.js']
            });
        } catch(e) {}

        // Focus tab so timers/observers are active
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true });
        await sleep(500);
        
        // Send message to content script
        const resultPromise = chrome.tabs.sendMessage(tabId, {
            action: 'generateImage',
            prompt: prompt,
            aspectRatio: aspectRatio
        });
        
        // Keep tab active while waiting
        const nudgeInterval = setInterval(async () => {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: () => {
                        const nudge = document.createElement('span');
                        nudge.id = 'lazy-image-nudge';
                        nudge.style.display = 'none';
                        document.body.appendChild(nudge);
                        nudge.remove();
                    }
                });
            } catch(e) {}
        }, 3000);
        
        const result = await resultPromise;
        clearInterval(nudgeInterval);
        
        // Post result back to AE server
        await fetch(`${AE_SERVER}/api/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: id,
                success: result.success,
                imageBase64: result.imageBase64 || null,
                error: result.error || null,
                dimensions: result.dimensions || null,
                provider: 'chatgpt',
                format: result.format || 'png'
            })
        });
        
    } catch (e) {
        // Post error back
        await fetch(`${AE_SERVER}/api/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: id,
                success: false,
                error: `Extension Error: ${e.message}. Make sure you are logged into ChatGPT in your browser.`,
                provider: 'chatgpt'
            })
        });
    }
}

function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        function listener(updatedTabId, info) {
            if (updatedTabId === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }, 30000);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Message handler for popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getStatus') {
        sendResponse({ isConnected, lastError });
    }
    return true;
});
