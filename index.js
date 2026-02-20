// Ultra-minimal Fast Travel Map - Test version
(function() {
    'use strict';
    
    // Wait for SillyTavern to be ready
    if (typeof jQuery === 'undefined') {
        console.error('[FTM] jQuery not loaded');
        return;
    }
    
    const EXTENSION_NAME = "FastTravelMap";
    
    // Default settings
    const defaultSettings = {
        enabled: true,
        lastPosition: 0
    };
    
    // Safe settings init
    if (!window.extension_settings) {
        console.error('[FTM] extension_settings not available');
        return;
    }
    
    if (!window.extension_settings[EXTENSION_NAME]) {
        window.extension_settings[EXTENSION_NAME] = Object.assign({}, defaultSettings);
    }
    
    const settings = window.extension_settings[EXTENSION_NAME];
    
    console.log('[FTM] Extension loaded successfully');
    
    // Create simple button
    function createButton() {
        const btn = document.createElement('button');
        btn.textContent = '🗺️';
        btn.style.cssText = `
            position: fixed;
            bottom: 100px;
            right: 20px;
            width: 50px;
            height: 50px;
            border-radius: 50%;
            border: none;
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            font-size: 24px;
            cursor: pointer;
            z-index: 9999;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        `;
        
        btn.onclick = function() {
            alert('Fast Travel Map working! Check console (F12) for details.');
            console.log('[FTM] Button clicked', settings);
        };
        
        document.body.appendChild(btn);
        console.log('[FTM] Button created');
    }
    
    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createButton);
    } else {
        createButton();
    }
    
})();
