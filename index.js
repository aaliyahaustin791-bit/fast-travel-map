import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { callPopup, toastr } from "../../../../popup.js";
import { getRequestHeaders } from "../../../../utils.js";

const EXTENSION_NAME = "FastTravelMap";

const defaultSettings = {
    waypoints: [],
    discoveredIds: [],
    discoveryRadius: 5,
    showFogOfWar: true,
    mapImage: null,
    generationParams: {
        enabled: true,
        promptTemplate: "fantasy world map, {locations}, hand drawn style, parchment texture",
        negativePrompt: "blurry, low quality, modern, text",
        width: 1024,
        height: 1024
    },
    travelSpeed: 100,
    maxTravelTime: 8000,
    enableTravelAnimation: true,
    floatButtonPos: { x: null, y: null },
    lastPosition: 0,
    panX: 0, 
    panY: 0, 
    zoom: 1
};

// Initialize settings safely
if (!extension_settings[EXTENSION_NAME]) {
    extension_settings[EXTENSION_NAME] = structuredClone(defaultSettings);
}
const settings = extension_settings[EXTENSION_NAME];

let canvas, ctx, container, mapImageObj = null;
let isDragging = false, lastX, lastY;
let isTraveling = false;
let travelAbortController = null;

const locationPatterns = [
    /\b(?:in|at|near|towards|reaches?|arrives?|visit|enter|discovered|found)\s+(?:the\s+)?([A-Z][a-zA-Z\s']{1,25})\b/g
];

// Initialize when DOM is ready
function init() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
}

function initUI() {
    createFloatingButton();
    createMapContainer();
    createTravelOverlay();
    
    if (settings.mapImage) {
        mapImageObj = new Image();
        mapImageObj.onload = () => renderMap();
        mapImageObj.src = settings.mapImage;
    }
    
    updateFabBadge();
    
    // Hook into SillyTavern events
    const context = getContext();
    context.eventSource.on(context.event_types.MESSAGE_RECEIVED, onMessageReceived);
    context.eventSource.on(context.event_types.CHAT_CHANGED, onChatChanged);
}

function createFloatingButton() {
    const fab = document.createElement('div');
    fab.id = 'ftm-fab';
    fab.innerHTML = `
        <div class="ftm-fab-icon">🗺️</div>
        <div class="ftm-fab-badge" style="display: none;">0</div>
        <div class="ftm-fab-tooltip">World Map</div>
    `;
    
    // Default position
    fab.style.right = '20px';
    fab.style.bottom = '100px';
    
    // Apply saved position if exists
    if (settings.floatButtonPos.x) {
        fab.style.left = settings.floatButtonPos.x;
        fab.style.right = 'auto';
    }
    if (settings.floatButtonPos.y) {
        fab.style.top = settings.floatButtonPos.y;
        fab.style.bottom = 'auto';
    }
    
    // Drag logic
    let isDraggingFab = false;
    let startX, startY, initialX, initialY;
    
    fab.addEventListener('mousedown', (e) => {
        if (e.target.closest('.ftm-fab-tooltip')) return;
        isDraggingFab = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = fab.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;
        fab.style.transition = 'none';
        fab.style.cursor = 'grabbing';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDraggingFab) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        fab.style.left = `${Math.max(10, Math.min(initialX + dx, window.innerWidth - 70))}px`;
        fab.style.top = `${Math.max(10, Math.min(initialY + dy, window.innerHeight - 70))}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    });
    
    document.addEventListener('mouseup', () => {
        if (!isDraggingFab) return;
        isDraggingFab = false;
        fab.style.cursor = 'grab';
        fab.style.transition = 'transform 0.2s';
        const rect = fab.getBoundingClientRect();
        settings.floatButtonPos.x = rect.left + 'px';
        settings.floatButtonPos.y = rect.top + 'px';
        saveSettingsDebounced();
    });
    
    fab.addEventListener('click', (e) => {
        if (!isDraggingFab) toggleMap();
    });
    
    fab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showQuickTravelMenu();
    });
    
    document.body.appendChild(fab);
}

function createMapContainer() {
    if (document.getElementById('ftm-container')) return;
    
    container = document.createElement('div');
    container.id = 'ftm-container';
    container.innerHTML = `
        <div id="ftm-header">
            <span>🗺️ World Map <span id="ftm-discovered-count">(0)</span></span>
            <div class="ftm-header-controls">
                <button id="ftm-generate" title="Generate Map">🎨</button>
                <button id="ftm-settings" title="Settings">⚙️</button>
                <button id="ftm-clear" title="Clear">🗑️</button>
                <button id="ftm-close" title="Close">✕</button>
            </div>
        </div>
        <canvas id="ftm-canvas" width="320" height="400"></canvas>
        <div id="ftm-controls-hint">
            Scroll: Zoom • Drag: Pan • Click: Travel • Shift+Click: Add
        </div>
    `;
    
    document.body.appendChild(container);
    
    document.getElementById('ftm-close').onclick = () => container.style.display = 'none';
    document.getElementById('ftm-clear').onclick = clearWaypoints;
    document.getElementById('ftm-generate').onclick = generateMapImage;
    document.getElementById('ftm-settings').onclick = showSettings;
    
    canvas = document.getElementById('ftm-canvas');
    ctx = canvas.getContext('2d');
    
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('click', handleCanvasClick);
}

function createTravelOverlay() {
    if (document.getElementById('ftm-travel-overlay')) return;
    
    const overlay = document.createElement('div');
    overlay.id = 'ftm-travel-overlay';
    overlay.innerHTML = `
        <div class="ftm-travel-content">
            <div class="ftm-travel-portal">
                <div class="ftm-travel-sphere"></div>
                <div class="ftm-travel-ring"></div>
            </div>
            <div class="ftm-travel-text">Traveling...</div>
            <div class="ftm-travel-progress">
                <div class="ftm-travel-bar"></div>
            </div>
            <div class="ftm-travel-detail">Distance: <span>0</span> messages</div>
            <button class="ftm-travel-cancel">Cancel</button>
        </div>
    `;
    
    overlay.querySelector('.ftm-travel-cancel').onclick = cancelTravel;
    document.body.appendChild(overlay);
}

function extractLocations(text) {
    const locations = new Set();
    const patterns = [
        /\b(?:in|at|near|towards|reaches?|arrives?)\s+(?:the\s+)?([A-Z][a-zA-Z\s]{2,20})\b/g
    ];
    
    patterns.forEach(pattern => {
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
    const radius = 40 + (idx % 100);
    return {
        id: `wp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: name,
        mesId: mesId,
        x: 160 + Math.cos(angle) * radius,
        y: 200 + Math.sin(angle) * radius,
        timestamp: Date.now(),
        discovered: false
    };
}

function isDiscovered(wp) {
    if (!settings.showFogOfWar) return true;
    if (wp.mesId === -1) return true; // Manual/WI locations
    if (settings.discoveredIds.includes(wp.id)) return true;
    
    // Check proximity to current position
    if (wp.mesId >= 0) {
        const dist = Math.abs(wp.mesId - settings.lastPosition);
        return dist <= settings.discoveryRadius;
    }
    return false;
}

function discoverWaypoint(wp) {
    if (!settings.discoveredIds.includes(wp.id)) {
        settings.discoveredIds.push(wp.id);
        saveSettingsDebounced();
        updateFabBadge();
    }
}

function onMessageReceived() {
    const context = getContext();
    const idx = context.chat.length - 1;
    const message = context.chat[idx];
    
    if (!message?.mes) return;
    
    settings.lastPosition = idx;
    
    // Extract locations
    const locations = extractLocations(message.mes);
    locations.forEach(loc => {
        // Check if exists at this position
        const exists = settings.waypoints.some(w => 
            w.name === loc && w.mesId === idx
        );
        if (!exists) {
            const wp = createWaypoint(loc, idx);
            settings.waypoints.push(wp);
            
            // Auto-discover if within radius
            if (Math.abs(idx - settings.lastPosition) <= settings.discoveryRadius) {
                discoverWaypoint(wp);
            }
        }
    });
    
    // Check proximity discoveries
    settings.waypoints.forEach(wp => {
        if (Math.abs(wp.mesId - idx) <= settings.discoveryRadius) {
            discoverWaypoint(wp);
        }
    });
    
    saveSettingsDebounced();
    if (container && container.style.display === 'flex') renderMap();
    updateFabBadge();
}

function onChatChanged() {
    // Reset for new chat
    settings.waypoints = settings.waypoints.filter(w => w.mesId === -1); // Keep manual ones
    settings.discoveredIds = [];
    settings.lastPosition = 0;
    settings.mapImage = null;
    mapImageObj = null;
    if (container) container.style.display = 'none';
    updateFabBadge();
}

function toggleMap() {
    if (!container) initUI();
    const display = container.style.display === 'flex' ? 'none' : 'flex';
    container.style.display = display;
    if (display === 'flex') renderMap();
}

function calculateTravelTime(from, to) {
    const dist = Math.abs(from - to);
    if (dist <= 3) return 0;
    return Math.min(dist * settings.travelSpeed, settings.maxTravelTime);
}

async function fastTravel(wp) {
    if (isTraveling || !isDiscovered(wp)) return;
    
    const currentPos = settings.lastPosition;
    const targetPos = wp.mesId;
    const travelTime = calculateTravelTime(currentPos, targetPos);
    
    if (travelTime === 0) {
        performTravel(wp, true);
        return;
    }
    
    isTraveling = true;
    travelAbortController = new AbortController();
    const overlay = document.getElementById('ftm-travel-overlay');
    const bar = overlay.querySelector('.ftm-travel-bar');
    const distText = overlay.querySelector('.ftm-travel-detail span');
    
    overlay.style.display = 'flex';
    distText.textContent = Math.abs(targetPos - currentPos);
    
    const start = Date.now();
    const update = () => {
        if (!isTraveling) return;
        const elapsed = Date.now() - start;
        const pct = Math.min((elapsed / travelTime) * 100, 100);
        bar.style.width = pct + '%';
        
        if (pct < 100 && isTraveling) {
            requestAnimationFrame(update);
        }
    };
    requestAnimationFrame(update);
    
    try {
        await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, travelTime);
            travelAbortController.signal.addEventListener('abort', () => {
                clearTimeout(t);
                reject('cancelled');
            });
        });
        performTravel(wp, false);
    } catch (e) {
        if (e === 'cancelled') toastr.info('Travel cancelled');
    } finally {
        isTraveling = false;
        overlay.style.display = 'none';
    }
}

function performTravel(wp, instant) {
    const el = document.querySelector(`.mes[mesid="${wp.mesId}"]`);
    if (el) {
        el.scrollIntoView({ behavior: instant ? 'smooth' : 'auto', block: 'center' });
        el.style.backgroundColor = 'rgba(102, 126, 234, 0.3)';
        setTimeout(() => el.style.backgroundColor = '', 2000);
    }
    
    settings.lastPosition = wp.mesId;
    
    // Discover surroundings
    settings.waypoints.forEach(w => {
        if (Math.abs(w.mesId - wp.mesId) <= settings.discoveryRadius) {
            discoverWaypoint(w);
        }
    });
    
    renderMap();
    updateFabBadge();
}

function cancelTravel() {
    if (travelAbortController) {
        travelAbortController.abort();
        isTraveling = false;
        document.getElementById('ftm-travel-overlay').style.display = 'none';
    }
}

function renderMap() {
    if (!canvas) return;
    const w = canvas.width, h = canvas.height;
    
    // Clear
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, w, h);
    
    // Background image
    if (mapImageObj) {
        ctx.globalAlpha = 0.6;
        ctx.drawImage(mapImageObj, 0, 0, w, h);
        ctx.globalAlpha = 1;
    }
    
    ctx.save();
    ctx.translate(settings.panX, settings.panY);
    ctx.scale(settings.zoom, settings.zoom);
    
    // Draw waypoints
    settings.waypoints.forEach((wp, i) => {
        if (!isDiscovered(wp)) return;
        
        // Shadow
        ctx.beginPath();
        ctx.arc(wp.x + 2, wp.y + 2, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();
        
        // Point
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = wp.mesId === settings.lastPosition ? '#ffeb3b' : (wp.mesId === -1 ? '#ffd700' : '#4CAF50');
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Label
        ctx.fillStyle = '#fff';
        ctx.font = '11px Arial';
        ctx.fillText(wp.name, wp.x + 10, wp.y + 4);
    });
    
    ctx.restore();
    
    // Update counter
    const counter = document.getElementById('ftm-discovered-count');
    if (counter) {
        const disc = settings.waypoints.filter(isDiscovered).length;
        counter.textContent = `(${disc}/${settings.waypoints.length})`;
    }
}

async function generateMapImage() {
    if (!settings.generationParams.enabled) {
        toastr.warning('Image generation disabled');
        return;
    }
    
    const discovered = settings.waypoints.filter(isDiscovered);
    if (discovered.length === 0) {
        toastr.warning('Discover locations first!');
        return;
    }
    
    const locs = discovered.map(w => w.name).join(', ');
    const prompt = settings.generationParams.promptTemplate.replace('{locations}', locs);
    
    toastr.info('Generating...', 'AI Map');
    
    try {
        const res = await fetch('/api/image', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                prompt: prompt,
                width: settings.generationParams.width,
                height: settings.generationParams.height
            })
        });
        
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        
        if (data.image) {
            settings.mapImage = data.image;
            mapImageObj = new Image();
            mapImageObj.onload = () => {
                renderMap();
                toastr.success('Map generated!');
            };
            mapImageObj.src = data.image;
            saveSettingsDebounced();
        }
    } catch (e) {
        toastr.error('Generation failed');
        console.error(e);
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
    const old = settings.zoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    settings.zoom = Math.max(0.5, Math.min(3, settings.zoom * delta));
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    settings.panX = x - (x - settings.panX) * (settings.zoom / old);
    settings.panY = y - (y - settings.panY) * (settings.zoom / old);
    
    renderMap();
}

function handleCanvasClick(e) {
    if (isDragging) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - settings.panX) / settings.zoom;
    const y = (e.clientY - rect.top - settings.panY) / settings.zoom;
    
    for (let i = settings.waypoints.length - 1; i >= 0; i--) {
        const wp = settings.waypoints[i];
        const dist = Math.hypot(x - wp.x, y - wp.y);
        if (dist < 15) {
            fastTravel(wp);
            return;
        }
    }
    
    if (e.shiftKey) {
        createCustomWaypoint(x, y);
    }
}

async function createCustomWaypoint(x, y) {
    const name = prompt('Enter location name:'); // Simple prompt instead of callPopup for compatibility
    if (!name) return;
    
    const context = getContext();
    const wp = {
        id: `wp_${Date.now()}`,
        name: name,
        mesId: -1, // Manual
        x: x,
        y: y,
        timestamp: Date.now(),
        discovered: true
    };
    
    settings.waypoints.push(wp);
    saveSettingsDebounced();
    renderMap();
}

function showQuickTravelMenu() {
    const recent = settings.waypoints
        .filter(isDiscovered)
        .sort((a, b) => b.mesId - a.mesId)
        .slice(0, 5);
    
    if (recent.length === 0) return;
    
    // Simple implementation - in real use you'd make a custom menu
    const names = recent.map((w, i) => `${i + 1}. ${w.name}`).join('\n');
    const choice = prompt(`Quick Travel:\n${names}\n\nEnter number:`);
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < recent.length) {
        fastTravel(recent[idx]);
    }
}

function showSettings() {
    const r = prompt(`Discovery Radius (current: ${settings.discoveryRadius}):`, settings.discoveryRadius);
    if (r) {
        settings.discoveryRadius = parseInt(r) || 5;
        saveSettingsDebounced();
        renderMap();
    }
}

function clearWaypoints() {
    if (confirm('Clear all waypoints?')) {
        settings.waypoints = [];
        settings.discoveredIds = [];
        saveSettingsDebounced();
        renderMap();
    }
}

function updateFabBadge() {
    const fab = document.getElementById('ftm-fab');
    if (!fab) return;
    
    const badge = fab.querySelector('.ftm-fab-badge');
    const nearby = settings.waypoints.filter(w => {
        if (w.mesId === -1) return false;
        const dist = Math.abs(w.mesId - settings.lastPosition);
        return dist <= settings.discoveryRadius + 2 && !settings.discoveredIds.includes(w.id);
    }).length;
    
    if (nearby > 0) {
        badge.textContent = nearby;
        badge.style.display = 'flex';
        fab.classList.add('has-notification');
    } else {
        badge.style.display = 'none';
        fab.classList.remove('has-notification');
    }
}

// Start
init();
