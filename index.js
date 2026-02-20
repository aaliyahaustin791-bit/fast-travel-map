// Fast Travel Map - Fixed Version (no toastr dependency)
import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const EXTENSION_NAME = "FastTravelMap";

const defaultSettings = {
    waypoints: [],
    discoveredIds: [],
    discoveryRadius: 5,
    showFogOfWar: true,
    mapImage: null,
    travelSpeed: 100,
    maxTravelTime: 5000,
    lastPosition: 0,
    panX: 0, 
    panY: 0, 
    zoom: 1
};

// Initialize settings
if (!extension_settings[EXTENSION_NAME]) {
    extension_settings[EXTENSION_NAME] = JSON.parse(JSON.stringify(defaultSettings));
}
const settings = extension_settings[EXTENSION_NAME];

let canvas, ctx, container;
let isDragging = false, lastX, lastY;
let isTraveling = false;
let mapImageObj = null;

const locationPatterns = [
    /\b(?:in|at|near|towards|reaches?|arrives?|visit|enter|found|discovered)\s+(?:the\s+)?([A-Z][a-zA-Z\s']{2,25})\b/g
];

// Safe notification function (no toastr)
function notify(message, title = 'Fast Travel Map') {
    console.log(`[FTM] ${title}: ${message}`);
    // Optional: uncomment next line if you want alerts
    // alert(`${title}: ${message}`);
}

function init() {
    console.log('[FastTravelMap] Initializing...');
    createFloatingButton();
    createMapContainer();
    createTravelOverlay();
    
    if (settings.mapImage) {
        mapImageObj = new Image();
        mapImageObj.onload = () => renderMap();
        mapImageObj.src = settings.mapImage;
    }
    
    const context = getContext();
    context.eventSource.on(context.event_types.MESSAGE_RECEIVED, onMessageReceived);
    context.eventSource.on(context.event_types.CHAT_CHANGED, onChatChanged);
    
    console.log('[FastTravelMap] Ready!');
}

function createFloatingButton() {
    const btn = document.createElement('button');
    btn.id = 'ftm-fab';
    btn.innerHTML = '🗺️';
    
    btn.style.cssText = `
        position: fixed !important;
        bottom: 100px !important;
        right: 20px !important;
        width: 60px !important;
        height: 60px !important;
        border-radius: 50% !important;
        border: 2px solid white !important;
        background: linear-gradient(135deg, #667eea, #764ba2) !important;
        color: white !important;
        font-size: 28px !important;
        cursor: pointer !important;
        z-index: 99999 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        box-shadow: 0 4px 15px rgba(0,0,0,0.4) !important;
        transition: transform 0.2s !important;
    `;
    
    btn.addEventListener('mouseenter', () => btn.style.transform = 'scale(1.1)');
    btn.addEventListener('mouseleave', () => btn.style.transform = 'scale(1)');
    
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMap();
    });
    
    document.body.appendChild(btn);
}

function createMapContainer() {
    if (document.getElementById('ftm-container')) return;
    
    container = document.createElement('div');
    container.id = 'ftm-container';
    container.style.cssText = `
        position: fixed;
        top: 60px;
        right: 20px;
        width: 340px;
        height: 460px;
        background: rgba(20,20,30,0.95);
        border: 2px solid #667eea;
        border-radius: 12px;
        z-index: 10000;
        display: none;
        flex-direction: column;
        overflow: hidden;
    `;
    
    container.innerHTML = `
        <div style="padding: 12px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; color: white; font-weight: bold;">
            <span>🗺️ World Map</span>
            <div style="display: flex; gap: 8px;">
                <button id="ftm-clear" style="background: #444; border: none; color: white; padding: 4px 8px; border-radius: 4px; cursor: pointer;">Clear</button>
                <button id="ftm-close" style="background: #444; border: none; color: white; padding: 4px 8px; border-radius: 4px; cursor: pointer;">✕</button>
            </div>
        </div>
        <canvas id="ftm-canvas" width="340" height="380" style="background: #0a0a15; cursor: crosshair;"></canvas>
        <div style="padding: 8px; font-size: 11px; color: #888; text-align: center; border-top: 1px solid #333;">
            Scroll: Zoom • Drag: Pan • Click: Travel • Shift+Click: Add
        </div>
    `;
    
    document.body.appendChild(container);
    
    document.getElementById('ftm-close').onclick = () => container.style.display = 'none';
    document.getElementById('ftm-clear').onclick = clearWaypoints;
    
    canvas = document.getElementById('ftm-canvas');
    ctx = canvas.getContext('2d');
    
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('click', handleCanvasClick);
}

function createTravelOverlay() {
    if (document.getElementById('ftm-travel')) return;
    
    const overlay = document.createElement('div');
    overlay.id = 'ftm-travel';
    overlay.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.9);
        z-index: 10001;
        display: none;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        color: white;
    `;
    
    overlay.innerHTML = `
        <div style="font-size: 24px; margin-bottom: 20px;">Traveling...</div>
        <div style="width: 200px; height: 4px; background: #333; border-radius: 2px; overflow: hidden;">
            <div id="ftm-progress" style="width: 0%; height: 100%; background: #667eea; transition: width 0.1s;"></div>
        </div>
        <button id="ftm-cancel" style="margin-top: 20px; background: transparent; border: 1px solid #fff; color: white; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Cancel</button>
    `;
    
    overlay.querySelector('#ftm-cancel').onclick = () => {
        isTraveling = false;
        overlay.style.display = 'none';
    };
    
    document.body.appendChild(overlay);
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

function createWaypoint(name, mesId) {
    const idx = settings.waypoints.length;
    const angle = idx * 2.39996;
    const radius = 40 + (idx % 120);
    
    return {
        id: `wp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: name,
        mesId: mesId,
        x: 170 + Math.cos(angle) * radius,
        y: 190 + Math.sin(angle) * radius,
        discovered: mesId === -1
    };
}

function isDiscovered(wp) {
    if (!settings.showFogOfWar) return true;
    if (wp.mesId === -1) return true;
    if (settings.discoveredIds.includes(wp.id)) return true;
    const dist = Math.abs(wp.mesId - settings.lastPosition);
    return dist <= settings.discoveryRadius;
}

function discoverWaypoint(wp) {
    if (!settings.discoveredIds.includes(wp.id) && !wp.discovered) {
        settings.discoveredIds.push(wp.id);
        saveSettingsDebounced();
        notify(`Discovered: ${wp.name}`, 'New Location');
    }
}

function onMessageReceived() {
    const context = getContext();
    const idx = context.chat.length - 1;
    const message = context.chat[idx];
    if (!message?.mes) return;
    
    settings.lastPosition = idx;
    
    const locations = extractLocations(message.mes);
    let newFound = false;
    
    locations.forEach(loc => {
        const exists = settings.waypoints.some(w => w.name === loc && w.mesId === idx);
        if (!exists) {
            const wp = createWaypoint(loc, idx);
            settings.waypoints.push(wp);
            newFound = true;
            if (Math.abs(idx - settings.lastPosition) <= settings.discoveryRadius) {
                discoverWaypoint(wp);
            }
        }
    });
    
    settings.waypoints.forEach(wp => {
        if (Math.abs(wp.mesId - idx) <= settings.discoveryRadius) {
            discoverWaypoint(wp);
        }
    });
    
    if (newFound) saveSettingsDebounced();
    if (container && container.style.display === 'flex') renderMap();
}

function onChatChanged() {
    settings.waypoints = settings.waypoints.filter(w => w.mesId === -1);
    settings.discoveredIds = [];
    settings.lastPosition = 0;
    settings.mapImage = null;
    mapImageObj = null;
    saveSettingsDebounced();
}

function toggleMap() {
    if (!container) createMapContainer();
    const show = container.style.display === 'none';
    container.style.display = show ? 'flex' : 'none';
    if (show) renderMap();
}

function calculateTravelTime(from, to) {
    const dist = Math.abs(from - to);
    if (dist <= 3) return 0;
    return Math.min(dist * settings.travelSpeed, settings.maxTravelTime);
}

async function fastTravel(waypoint) {
    if (isTraveling || !isDiscovered(waypoint)) {
        if (!isDiscovered(waypoint)) notify('Location not discovered yet!', 'Travel');
        return;
    }
    
    const currentPos = settings.lastPosition;
    const targetPos = waypoint.mesId;
    const time = calculateTravelTime(currentPos, targetPos);
    
    if (time === 0) {
        performTravel(waypoint);
        return;
    }
    
    isTraveling = true;
    const overlay = document.getElementById('ftm-travel');
    const progress = document.getElementById('ftm-progress');
    overlay.style.display = 'flex';
    
    const start = Date.now();
    const interval = setInterval(() => {
        if (!isTraveling) {
            clearInterval(interval);
            return;
        }
        
        const elapsed = Date.now() - start;
        const pct = Math.min((elapsed / time) * 100, 100);
        progress.style.width = pct + '%';
        
        if (elapsed >= time) {
            clearInterval(interval);
            isTraveling = false;
            overlay.style.display = 'none';
            performTravel(waypoint);
        }
    }, 50);
}

function performTravel(waypoint) {
    const msgEl = document.querySelector(`.mes[mesid="${waypoint.mesId}"]`);
    if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgEl.style.backgroundColor = 'rgba(102, 126, 234, 0.3)';
        setTimeout(() => msgEl.style.backgroundColor = '', 2000);
    }
    
    settings.lastPosition = waypoint.mesId;
    
    settings.waypoints.forEach(wp => {
        if (Math.abs(wp.mesId - waypoint.mesId) <= settings.discoveryRadius) {
            discoverWaypoint(wp);
        }
    });
    
    saveSettingsDebounced();
    renderMap();
    notify(`Arrived at ${waypoint.name}`, 'Travel Complete');
}

function renderMap() {
    if (!canvas) return;
    const w = canvas.width, h = canvas.height;
    
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, w, h);
    
    if (mapImageObj) {
        ctx.globalAlpha = 0.6;
        ctx.drawImage(mapImageObj, 0, 0, w, h);
        ctx.globalAlpha = 1;
    }
    
    ctx.save();
    ctx.translate(settings.panX, settings.panY);
    ctx.scale(settings.zoom, settings.zoom);
    
    settings.waypoints.forEach(wp => {
        if (!isDiscovered(wp)) return;
        
        // Draw connections
        const next = settings.waypoints.find(n => n.mesId > wp.mesId && isDiscovered(n));
        if (next && next.mesId - wp.mesId < 50) {
            ctx.strokeStyle = 'rgba(102, 126, 234, 0.3)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(wp.x, wp.y);
            ctx.lineTo(next.x, next.y);
            ctx.stroke();
        }
        
        // Draw waypoint
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = wp.mesId === settings.lastPosition ? '#ffeb3b' : '#4CAF50';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        if (wp.mesId === settings.lastPosition) {
            ctx.beginPath();
            ctx.arc(wp.x, wp.y, 10, 0, Math.PI * 2);
            ctx.strokeStyle = '#ffeb3b';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        
        ctx.fillStyle = '#fff';
        ctx.font = '11px Arial';
        ctx.fillText(wp.name, wp.x + 8, wp.y + 4);
    });
    
    ctx.restore();
    
    const discovered = settings.waypoints.filter(isDiscovered).length;
    const header = document.querySelector('#ftm-container span');
    if (header) header.textContent = `🗺️ World Map (${discovered}/${settings.waypoints.length})`;
}

// Mouse handlers
function handleMouseDown(e) {
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
}

function handleMouseMove(e) {
    if (!isDragging) return;
    settings.panX += e.clientX - lastX;
    settings.panY += e.clientY - lastY;
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
    const oldZoom = settings.zoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    settings.zoom = Math.max(0.5, Math.min(4, settings.zoom * delta));
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    settings.panX = x - (x - settings.panX) * (settings.zoom / oldZoom);
    settings.panY = y - (y - settings.panY) * (settings.zoom / oldZoom);
    
    renderMap();
}

function handleCanvasClick(e) {
    if (isDragging) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - settings.panX) / settings.zoom;
    const y = (e.clientY - rect.top - settings.panY) / settings.zoom;
    
    for (let i = settings.waypoints.length - 1; i >= 0; i--) {
        const wp = settings.waypoints[i];
        if (Math.hypot(x - wp.x, y - wp.y) < 12) {
            fastTravel(wp);
            return;
        }
    }
    
    if (e.shiftKey) {
        const name = prompt('Enter location name:');
        if (name) {
            const wp = createWaypoint(name, -1);
            wp.x = x;
            wp.y = y;
            wp.discovered = true;
            settings.waypoints.push(wp);
            saveSettingsDebounced();
            renderMap();
        }
    }
}

function clearWaypoints() {
    if (confirm('Clear all discovered locations?')) {
        settings.waypoints = settings.waypoints.filter(w => w.mesId === -1);
        settings.discoveredIds = [];
        saveSettingsDebounced();
        renderMap();
    }
}

// Initialize
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
