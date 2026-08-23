document.addEventListener('DOMContentLoaded', () => {
    updateStatus();
    setInterval(updateStatus, 3000);
});

async function updateStatus() {
    // 1. Get AE server status from background
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
        const aeDot = document.getElementById('ae-dot');
        const aeText = document.getElementById('ae-text');
        const errorMsg = document.getElementById('error-message');
        
        if (chrome.runtime.lastError || !response) {
            setDisconnected(aeDot, aeText, 'Disconnected');
        } else if (response.isConnected) {
            setConnected(aeDot, aeText, 'Connected');
            errorMsg.style.display = 'none';
        } else {
            setDisconnected(aeDot, aeText, 'Disconnected');
            if (response.lastError) {
                errorMsg.textContent = response.lastError;
                errorMsg.style.display = 'block';
            } else {
                errorMsg.style.display = 'none';
            }
        }
    });

    // 2. Check ChatGPT login status
    try {
        const gptRes = await fetch('https://chatgpt.com/api/auth/session');
        if (gptRes.ok) {
            const data = await gptRes.json();
            if (data && data.accessToken) {
                setConnected(document.getElementById('gpt-dot'), document.getElementById('gpt-text'), 'Logged In');
            } else {
                setDisconnected(document.getElementById('gpt-dot'), document.getElementById('gpt-text'), 'Not Logged In');
            }
        } else {
            setDisconnected(document.getElementById('gpt-dot'), document.getElementById('gpt-text'), 'Not Logged In');
        }
    } catch(e) {
        setDisconnected(document.getElementById('gpt-dot'), document.getElementById('gpt-text'), 'Not Logged In');
    }
}

function setConnected(dot, text, label) {
    if (!dot || !text) return;
    dot.className = 'dot connected';
    text.textContent = label;
    text.style.color = '#00c853';
}

function setDisconnected(dot, text, label) {
    if (!dot || !text) return;
    dot.className = 'dot disconnected';
    text.textContent = label;
    text.style.color = '#ff4444';
}
