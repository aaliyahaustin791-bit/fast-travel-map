import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { callPopup } from "../../../../popup.js";

const EXTENSION_NAME = "FastTravelMap";

// Default settings structure
const defaultSettings = {
    waypoints: [],      // Array of {id, name, mesId, x, y, discovered, timestamp}
    showUndiscovered: true,
    lastPosition: 0,    // For tracking "you are here"
    mapZoom: 1,
    panX: 0,
    panY: 0
};

// Initialize settings
if (!extension_settings[EXTENSION_NAME]) {
    extension_settings[EXTENSION_NAME] = JSON.parse(JSON.stringify(defaultSettings));
}
const settings = extension_settings[EXTENSION_NAME];

// Regex to detect locations in text (captures "in Paris", "at the Tavern", etc.)
const locationPatterns = [
    /\b(?:in|at|near|towards|reaches?|arrives? (?:at|in)|visit(?:ing)?|enter(?:ing)?)\s+(?:the\s+)?([A-Z][a-zA-Z\s]{1,20}(?:City|Town|Village|Forest|Mountains?|Castle|Tavern|Inn|Cave|Tower|Ruins|Temple|Bridge|River|Lake|Valley|Plains?|Desert|Island|Harbor)?)\b/g,
    /\b([A-Z][a-z]+(?:wood|dale|burg|heim|port|haven|gate|ford|crest|fall|peak|shore|keep|hall|crypt|grove))\b/g
];

let canvas, ctx, container;
let isDragging = false;
let lastX, lastY;

function initUI() {
    // Create toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'ftm-toggle';
    toggleBtn.innerHTML = '🗺️ World Map';
    toggleBtn.onclick = toggleMap;
    document.body.appendChild(toggleBtn);

    // Create map container
    container = document.createElement('div');
    container.id = 'ftm-container';
    container.innerHTML = `
        <div id="ftm-header">
            <span>Fast Travel Map</span>
            <div>
                <button id="ftm-clear" title="Clear All">🗑️</button>
                <button id="ftm-close" title="Close">✕</button>
            </div>
        </div>
        <canvas id="ftm-canvas" width="300" height="340"></canvas>
        <div id="ftm-tooltip"></div>
    `;
    document.body.appendChild(container);

    // Add event listeners
    document.getElementById('ftm-close').onclick = () => container.style.display = 'none';
    document.getElementById('ftm-clear').onclick = clearWaypoints;
    
    canvas = document.getElementById('ftm-canvas');
    ctx = canvas.getContext('2d');
    
    // Canvas interactions
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel);
    canvas.addEventListener('click', handleCanvasClick);
    
    renderMap();
}

function toggleMap() {
    const display = container.style.display === 'flex' ? 'none' : 'flex';
    container.style.display = display;
    if (display === 'flex') renderMap();
}

function extractLocations(text) {
    const locations = new Set();
    locationPatterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            locations.add(match[1].trim());
        }
    });
    return Array.from(locations);
}

function addWaypoint(name, mesId) {
    // Check if exists at this message
    if (settings.waypoints.find(w => w.mesId === mesId && w.name === name)) return;
    
    // Generate pseudo-random position based on name for consistency
    const hash = name.split('').reduce((a,b) => a + b.charCodeAt(0), 0);
    const x = 50 + (hash % 200);
    const y = 50 + ((hash * 7) % 240);
    
    settings.waypoints.push({
        id: Date.now() + Math.random(),
        name: name,
        mesId: mesId,
        x: x,
        y: y,
        discovered: true,
        timestamp: Date.now()
    });
    
    saveSettingsDebounced();
    if (container.style.display === 'flex') renderMap();
}

function onMessageReceived(data) {
    const context = getContext();
    const index = context.chat.length - 1;
    const message = context.chat[index];
    
    if (!message || !message.mes) return;
    
    // Extract locations from message
    const locations = extractLocations(message.mes);
    locations.forEach(loc => addWaypoint(loc, index));
    
    settings.lastPosition = index;
}

function renderMap() {
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, width, height);
    
    // Draw grid
    ctx.strokeStyle = '#1a1a3a';
    ctx.lineWidth = 1;
    const gridSize = 40 * settings.mapZoom;
    const offsetX = settings.panX % gridSize;
    const offsetY = settings.panY % gridSize;
    
    for (let x = offsetX; x < width; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = offsetY; y < height; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    
    const context = getContext();
    
    // Draw waypoints
    settings.waypoints.forEach((wp, idx) => {
        if (!wp.discovered && !settings.showUndiscovered) return;
        
        const x = (wp.x * settings.mapZoom) + settings.panX;
        const y = (wp.y * settings.mapZoom) + settings.panY;
        
        // Skip if off-screen
        if (x < -10 || x > width + 10 || y < -10 || y > height + 10) return;
        
        // Draw connection line to previous waypoint
        if (idx > 0) {
            const prev = settings.waypoints[idx - 1];
            const px = (prev.x * settings.mapZoom) + settings.panX;
            const py = (prev.y * settings.mapZoom) + settings.panY;
            ctx.strokeStyle = 'rgba(100, 200, 255, 0.2)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(x, y);
            ctx.stroke();
        }
        
        // Draw waypoint circle
        ctx.beginPath();
        ctx.arc(x, y, 6 * settings.mapZoom, 0, Math.PI * 2);
        ctx.fillStyle = wp.discovered ? '#4CAF50' : '#555';
        ctx.fill();
        ctx.strokeStyle = wp.mesId === settings.lastPosition ? '#ffeb3b' : '#fff';
        ctx.lineWidth = wp.mesId === settings.lastPosition ? 3 : 2;
        ctx.stroke();
        
        // Draw glow for current location
        if (wp.mesId === settings.lastPosition) {
            ctx.beginPath();
            ctx.arc(x, y, 12 * settings.mapZoom, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 235, 59, 0.3)';
            ctx.fill();
        }
        
        // Draw label
        if (settings.mapZoom > 0.7) {
            ctx.fillStyle = '#fff';
            ctx.font = `${12 * settings.mapZoom}px Arial`;
            ctx.fillText(wp.name, x + 10, y + 4);
        }
    });
    
    // Draw "You Are Here" indicator
    if (settings.waypoints.length > 0) {
        ctx.fillStyle = '#ffeb3b';
        ctx.font = 'bold 14px Arial';
        ctx.fillText(`📍 Current: ${context.chat.length} messages`, 10, 30);
    }
}

function handleCanvasClick(e) {
    if (isDragging) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Find clicked waypoint
    for (const wp of settings.waypoints) {
        const wpx = (wp.x * settings.mapZoom) + settings.panX;
        const wpy = (wp.y * settings.mapZoom) + settings.panY;
        const dist = Math.hypot(x - wpx, y - wpy);
        
        if (dist < 15 * settings.mapZoom) {
            fastTravel(wp);
            return;
        }
    }
    
    // Right-click to add custom waypoint (optional)
    if (e.shiftKey) {
        createCustomWaypoint(x, y);
    }
}

function fastTravel(waypoint) {
    // Scroll to message in chat
    const messageElement = document.querySelector(`.mes[mesid="${waypoint.mesId}"]`);
    if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageElement.style.backgroundColor = 'rgba(76, 175, 80, 0.2)';
        setTimeout(() => {
            messageElement.style.backgroundColor = '';
        }, 3000);
        
        settings.lastPosition = waypoint.mesId;
        renderMap();
        
        // Optional: Show cooldown or confirmation
        console.log(`[FastTravel] Traveled to: ${waypoint.name}`);
    }
}

function handleMouseDown(e) {
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
}

function handleMouseMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    settings.panX += dx;
    settings.panY += dy;
    lastX = e.clientX;
    lastY = e.clientY;
    renderMap();
}

function handleMouseUp() {
    isDragging = false;
    canvas.style.cursor = 'crosshair';
    saveSettingsDebounced();
}

function handleWheel(e) {
    e.preventDefault();
    const zoomSpeed = 0.1;
    const oldZoom = settings.mapZoom;
    
    if (e.deltaY < 0) {
        settings.mapZoom = Math.min(settings.mapZoom + zoomSpeed, 3);
    } else {
        settings.mapZoom = Math.max(settings.mapZoom - zoomSpeed, 0.5);
    }
    
    // Zoom towards mouse pointer
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    settings.panX = mouseX - (mouseX - settings.panX) * (settings.mapZoom / oldZoom);
    settings.panY = mouseY - (mouseY - settings.panY) * (settings.mapZoom / oldZoom);
    
    renderMap();
    saveSettingsDebounced();
}

async function createCustomWaypoint(x, y) {
    const name = await callPopup('Enter location name:', 'input');
    if (name) {
        const context = getContext();
        settings.waypoints.push({
            id: Date.now(),
            name: name,
            mesId: context.chat.length - 1,
            x: (x - settings.panX) / settings.mapZoom,
            y: (y - settings.panY) / settings.mapZoom,
            discovered: true,
            timestamp: Date.now()
        });
        saveSettingsDebounced();
        renderMap();
    }
}

function clearWaypoints() {
    if (confirm('Clear all waypoints?')) {
        settings.waypoints = [];
        saveSettingsDebounced();
        renderMap();
    }
}

// Initialize when extension loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
} else {
    initUI();
}

// Hook into SillyTavern events
const context = getContext();
context.eventSource.on(context.event_types.MESSAGE_RECEIVED, onMessageReceived);
context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
    // Clear waypoints when switching chats or load chat-specific waypoints
    settings.waypoints = [];
    renderMap();
});

console.log('[FastTravelMap] Extension loaded');
