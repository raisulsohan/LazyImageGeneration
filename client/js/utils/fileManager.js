const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const GImageFileManager = {
    /**
     * Creates directory recursively if not exists
     * @param {string} dirPath 
     * @returns {boolean}
     */
    ensureDirectory: function(dirPath) {
        try {
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
            return true;
        } catch (error) {
            console.error('Error creating directory:', error);
            return false;
        }
    },

    /**
     * Saves image buffer to disk
     * @param {Buffer} buffer 
     * @param {string} provider 
     * @param {string} format 
     * @param {string} projectFolder 
     * @returns {string} absolute file path
     */
    saveImage: function(buffer, provider, format, projectFolder) {
        try {
            let outputDir;
            if (projectFolder) {
                outputDir = path.join(projectFolder, 'AI_Generated');
            } else {
                outputDir = path.join(os.tmpdir(), 'GImage_Generated');
            }

            this.ensureDirectory(outputDir);

            const timestamp = Date.now();
            const safeProvider = (provider || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '');
            const safeFormat = (format || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
            
            const fileName = `gimage_${safeProvider}_${timestamp}.${safeFormat}`;
            const filePath = path.join(outputDir, fileName);

            fs.writeFileSync(filePath, buffer);
            return filePath;
        } catch (error) {
            console.error('Error saving image:', error);
            throw error;
        }
    },

    /**
     * Returns file info
     * @param {string} filePath 
     * @returns {Object}
     */
    getImageInfo: function(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                return {
                    exists: true,
                    size: stats.size,
                    extension: path.extname(filePath).toLowerCase(),
                    fileName: path.basename(filePath)
                };
            }
        } catch (error) {
            console.error('Error getting image info:', error);
        }
        return { exists: false, size: 0, extension: '', fileName: '' };
    },

    /**
     * Removes gimage_* files older than maxAgeHours
     * @param {string} directory 
     * @param {number} maxAgeHours 
     */
    cleanupOldFiles: function(directory, maxAgeHours = 24) {
        try {
            if (!fs.existsSync(directory)) return;

            const files = fs.readdirSync(directory);
            const now = Date.now();
            const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

            for (const file of files) {
                if (file.startsWith('gimage_')) {
                    const filePath = path.join(directory, file);
                    const stats = fs.statSync(filePath);
                    
                    if (now - stats.mtimeMs > maxAgeMs) {
                        fs.unlinkSync(filePath);
                        console.log(`Cleaned up old file: ${file}`);
                    }
                }
            }
        } catch (error) {
            console.error('Error cleaning up files:', error);
        }
    },

    /**
     * Downloads image from URL using Node.js
     * @param {string} imageUrl 
     * @returns {Promise<Buffer>}
     */
    downloadImageFromUrl: function(imageUrl) {
        return new Promise((resolve, reject) => {
            const timeout = 30000; // 30 seconds
            
            const makeRequest = (urlToFetch, redirectCount = 0) => {
                if (redirectCount > 5) {
                    return reject(new Error('Too many redirects'));
                }

                const client = urlToFetch.startsWith('https') ? https : http;
                
                const req = client.get(urlToFetch, (res) => {
                    // Handle redirects
                    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                        return makeRequest(res.headers.location, redirectCount + 1);
                    }

                    if (res.statusCode !== 200) {
                        return reject(new Error(`Failed to fetch image, status code: ${res.statusCode}`));
                    }

                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        resolve(buffer);
                    });
                });

                req.on('error', (err) => reject(err));
                
                req.setTimeout(timeout, () => {
                    req.abort();
                    reject(new Error('Request timed out'));
                });
            };

            makeRequest(imageUrl);
        });
    }
};

// Make available globally in CEP mixed-context
if (typeof window !== 'undefined') {
    window.GImageFileManager = GImageFileManager;
}
