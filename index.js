// index.js - Robust loading version
(function() {
    'use strict';
    
    console.log('[FastTravelMap] Extension initializing...');
    
    let attempts = 0;
    const maxAttempts = 50; // Try for 5 seconds
    
    function tryCreateButton() {
        attempts++;
        
        // Wait for body and main UI
        if (!document.body || !document.getElementById('chat')) {
            if (attempts < maxAttempts) {
                console.log('[FastTravelMap] Waiting for UI...');
                setTimeout(tryCreateButton, 100);
                return;
            }
        }
        
        // Remove existing
        const existing = document.getElementById('ftm-fab');
        if (existing) existing.remove();
        
        // Create button with maximum visibility
        const btn = document.createElement('button');
        btn.id = 'ftm-fab';
        btn.innerHTML = '🗺️';
        
        // More aggressive styling to ensure visibility
        btn.style.position = 'fixed';
        btn.style.bottom = '120px';
        btn.style.right = '20px';
        btn.style.width = '60px';
        btn.style.height = '60px';
        btn.style.borderRadius = '50%';
        btn.style.border = '3px solid white';
        btn.style.background = 'linear-gradient(135deg, #667eea, #764ba2)';
        btn.style.color = 'white';
        btn.style.fontSize = '30px';
        btn.style.cursor = 'pointer';
        btn.style.zIndex = '99999'; // Very high
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.boxShadow = '0 0 20px rgba(102, 126, 234, 0.8)';
        btn.style.pointerEvents = 'auto'; // Ensure clickable
        
        btn.onclick = function(e) {
            e.stopPropagation();
            alert('🗺️ Fast Travel Map is working!');
            console.log('[FastTravelMap] Clicked!', settings);
        };
        
        // Append to body specifically
        document.body.appendChild(btn);
        
        // Verify it exists
        const created = document.getElementById('ftm-fab');
        if (created) {
            console.log('[FastTravelMap] ✓ Button created and in DOM');
            console.log('[FastTravelMap] Button element:', created);
            console.log('[FastTravelMap] Button visible?', created.offsetParent !== null);
        } else {
            console.error('[FastTravelMap] ✗ Failed to create button');
        }
    }
    
    // Start trying
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryCreateButton);
    } else {
        tryCreateButton();
    }
    
    // Also expose for debugging
    window.ftmDebug = function() {
        const btn = document.getElementById('ftm-fab');
        console.log('Button exists:', !!btn);
        if (btn) {
            console.log('Button styles:', window.getComputedStyle(btn));
            console.log('Position:', btn.getBoundingClientRect());
        }
    };
})();
