/**
 * CSInterface for Adobe CEP extensions.
 * Provides the communication bridge between CEP HTML/JS panel and After Effects ExtendScript engine.
 */

function CSInterface() {
    this.hostEnvironment = {
        appName: 'AEFT',
        appVersion: '0.0',
        appLocale: 'en_US'
    };
    if (typeof __adobe_cep__ !== 'undefined' && typeof __adobe_cep__.getHostEnvironment === 'function') {
        try {
            this.hostEnvironment = JSON.parse(__adobe_cep__.getHostEnvironment());
        } catch(e) {}
    }
}

/**
 * Evaluates an ExtendScript expression in the host application.
 * @param {string} script - The ExtendScript code to evaluate
 * @param {function} callback - Callback with the result string
 */
CSInterface.prototype.evalScript = function(script, callback) {
    if (callback === null || callback === undefined) {
        callback = function(result) {};
    }
    try {
        if (typeof __adobe_cep__ !== 'undefined' && typeof __adobe_cep__.evalScript === 'function') {
            window.__adobe_cep__.evalScript(script, callback);
        } else {
            console.warn('CSInterface: Not running in CEP environment.');
            if (callback) callback('EvalScript_Error: Not in CEP environment');
        }
    } catch (e) {
        console.error('CSInterface.evalScript error:', e);
        if (callback) callback('EvalScript_Error: ' + e.message);
    }
};

/**
 * Gets the system path of the extension.
 * @param {string} pathType - The type of path (SystemPath.EXTENSION, etc.)
 * @returns {string} The system path
 */
CSInterface.prototype.getSystemPath = function(pathType) {
    try {
        if (typeof __adobe_cep__ !== 'undefined' && typeof __adobe_cep__.getSystemPath === 'function') {
            return __adobe_cep__.getSystemPath(pathType);
        }
    } catch (e) {
        console.error('CSInterface.getSystemPath error:', e);
    }
    return '';
};

/**
 * System path constants
 */
var SystemPath = {
    USER_DATA: 'userData',
    COMMON_FILES: 'commonFiles',
    MY_DOCUMENTS: 'myDocuments',
    APPLICATION: 'application',
    EXTENSION: 'extension',
    HOST_APPLICATION: 'hostApplication'
};
