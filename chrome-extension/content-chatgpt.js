// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'generateImage') {
        handleGenerationDOM(message.prompt, message.aspectRatio)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep message channel open for async response
    }
});

async function handleGenerationDOM(prompt, aspectRatio) {
    return new Promise((resolve, reject) => {
        try {
            const editor = document.querySelector('#prompt-textarea');
            if (!editor) {
                return reject(new Error('ChatGPT chat box not found. Please log in to chatgpt.com and keep a chat open.'));
            }

            const stopBtn = document.querySelector('[aria-label="Stop generating"]');
            if (stopBtn) {
                return reject(new Error('A previous generation is still running. Please wait.'));
            }

            // Snapshot ALL current images on the page before we generate
            const initialImages = getValidImageSrcs();

            const fullPrompt = `Generate an image with aspect ratio ${aspectRatio}: ${prompt}`;
            
            // Simulate user typing
            editor.focus();
            
            const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: new DataTransfer()
            });
            pasteEvent.clipboardData.setData('text/plain', fullPrompt);
            
            if (editor.tagName.toLowerCase() === 'textarea' || editor.tagName.toLowerCase() === 'input') {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(editor, fullPrompt);
                } else {
                    editor.value = fullPrompt;
                }
            } 
            
            editor.dispatchEvent(pasteEvent);
            editor.dispatchEvent(new Event('input', { bubbles: true }));

            // Small delay to let React update the UI and enable the send button
            setTimeout(() => {
                const sendBtn = document.querySelector('[data-testid="send-button"]');
                if (!sendBtn || sendBtn.disabled) {
                    return reject(new Error('Send button is not clickable or disabled.'));
                }
                
                // Click the send button
                sendBtn.click();
                
                // Wait for the new image to appear
                waitForNewImage(initialImages, resolve, reject);
            }, 800);

        } catch (e) {
            reject(new Error('UI Automation Error: ' + e.message));
        }
    });
}

function getValidImageSrcs() {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs.map(img => img.src).filter(src => {
        if (!src) return false;
        const lowerSrc = src.toLowerCase();
        if (lowerSrc.includes('svg') || lowerSrc.includes('avatar') || lowerSrc.includes('profile')) return false;
        return true;
    });
}

function waitForNewImage(initialImages, resolve, reject) {
    let settled = false;
    const startTime = Date.now();
    const timeout = 120000;
    
    function cleanup() {
        if (observer) observer.disconnect();
        if (backupInterval) clearInterval(backupInterval);
    }
    
    async function tryCapture(src) {
        if (settled) return;
        settled = true;
        cleanup();
        
        try {
            const base64 = await downloadAndConvertToBase64(src);
            resolve({
                success: true,
                imageBase64: base64,
                format: 'png',
                dimensions: null
            });
        } catch (e) {
            const img = document.querySelector('img[src="' + CSS.escape(src) + '"]');
            if (img && img.naturalWidth > 0) {
                try {
                    const canvasBase64 = getBase64FromCanvas(img);
                    resolve({ success: true, imageBase64: canvasBase64, format: 'png', dimensions: null });
                    return;
                } catch(e2) {}
            }
            settled = false;
        }
    }
    
    function checkForNewImage() {
        if (settled) return;
        
        if (Date.now() - startTime > timeout) {
            settled = true;
            cleanup();
            reject(new Error('Timeout: No image generated within 120 seconds.'));
            return;
        }
        
        const errorElements = document.querySelectorAll('.text-red-500, .text-danger');
        for (let err of errorElements) {
            if (err.innerText && err.innerText.trim().length > 0) {
                settled = true;
                cleanup();
                return reject(new Error('ChatGPT Error: ' + err.innerText.trim()));
            }
        }
        
        const currentImgs = Array.from(document.querySelectorAll('img'));
        
        for (let img of currentImgs) {
            const src = img.src;
            if (!src) continue;
            
            const lowerSrc = src.toLowerCase();
            if (lowerSrc.includes('svg') || lowerSrc.includes('avatar') || lowerSrc.includes('profile')) continue;
            if (lowerSrc.startsWith('data:')) continue;
            
            if (!initialImages.includes(src)) {
                tryCapture(src);
                return;
            }
        }
    }
    
    const observer = new MutationObserver(() => {
        checkForNewImage();
    });
    
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
    });
    
    const backupInterval = setInterval(checkForNewImage, 2000);
    checkForNewImage();
}

async function downloadAndConvertToBase64(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function getBase64FromCanvas(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
}
