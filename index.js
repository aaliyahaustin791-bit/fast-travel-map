// index.js - ULTRA VISIBLE TEST
(function() {
    'use strict';
    
    console.log('[FastTravelMap] Starting...');
    
    function createButton() {
        // Remove any existing
        const old = document.getElementById('ftm-fab');
        if (old) old.remove();
        
        const btn = document.createElement('button');
        btn.id = 'ftm-fab';
        btn.innerHTML = '🗺️ MAP';
        
        // ULTRA VISIBLE STYLING
        btn.style.cssText = `
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            width: 200px !important;
            height: 200px !important;
            background: #ff0000 !important;
            color: white !important;
            font-size: 40px !important;
            font-weight: bold !important;
            border: 10px solid yellow !important;
            border-radius: 20px !important;
            z-index: 999999 !important;
            cursor: pointer !important;
            box-shadow: 0 0 50px red !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
        `;
        
        btn.onclick = () => alert('IT WORKS! The button is clickable!');
        
        // Try multiple append locations
        document.body.appendChild(btn);
        console.log('[FastTravelMap] HUGE RED BUTTON SHOULD BE CENTERED ON SCREEN');
        
        // Backup: also add click listener to whole page to test
        document.addEventListener('click', function(e) {
            if (e.target === btn) {
                console.log('[FastTravelMap] Button clicked!');
            }
        });
    }
    
    // Try immediately and after delay
    if (document.body) {
        createButton();
    } else {
        document.addEventListener('DOMContentLoaded', createButton);
    }
    setTimeout(createButton, 1000); // Backup attempt
    
})();
