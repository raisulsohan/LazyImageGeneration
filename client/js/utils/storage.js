// GImageStorage object
// Only stores settings now (no API keys)
//
// Methods:
//   saveSettings(settings) — saves to localStorage
//   getSettings() — returns settings with defaults
//   getDefaultSettings() — { lastProvider: 'chatgpt', lastRatio: '1:1' }

const GImageStorage = {
    saveSettings: function(settings) {
        try {
            localStorage.setItem('gimage_settings', JSON.stringify(settings));
        } catch (e) {
            console.error('Error saving settings:', e);
        }
    },
    
    getSettings: function() {
        try {
            const settings = localStorage.getItem('gimage_settings');
            if (settings) {
                return { ...this.getDefaultSettings(), ...JSON.parse(settings) };
            }
        } catch (e) {
            console.error('Error getting settings:', e);
        }
        return this.getDefaultSettings();
    },
    
    getDefaultSettings: function() {
        return {
            lastProvider: 'chatgpt',
            lastRatio: '1:1'
        };
    }
};
