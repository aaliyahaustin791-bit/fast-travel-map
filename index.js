// index.js - Minimal working version
(function() {
    'use strict';
    
    console.log('[FastTravelMap] Extension loading...');
    
    // Create button when DOM is ready
    function createButton() {
        // Remove existing if any
        const existing = document.getElementById('ftm-fab');
        if (existing) existing.remove();
        
        const btn = document.createElement('button');
        btn.id = 'ftm-fab';
        btn.innerHTML = '🗺️';
        btn.style.cssText = `
            position: fixed;
            bottom: 100px;
            right: 20px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            border: none;
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            font-size: 30px;
            cursor: pointer;
            z-index: 9999;
            box-shadow: 0 4px 15px rgba(0,0,0,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        
        btn.onclick = function() {
            alert('🗺️ Fast Travel Map is working!\n\nNow we can add the full features back.');
            console.log('[FastTravelMap] Clicked!');
        };
        
        document.body.appendChild(btn);
        console.log('[FastTravelMap] Button created successfully');
    }
    
    // Run when page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createButton);
    } else {
        createButton();
    }
})();
