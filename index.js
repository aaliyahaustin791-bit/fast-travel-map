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
    // Travel time settings
    travelSpeed: 100, // ms per message distance
    maxTravelTime: 8000, // cap at 8 seconds
    enableTravelAnimation: true,
    // Floating button position
    floatButtonPos: { x: null, y: null }, // null = default position
    lastPosition: 0,
    panX: 0, panY: 0, zoom: 1
};

if (!extension_settings[EXTENSION_NAME]) {
    extension_settings[EXTENSION_NAME] = JSON.parse(JSON.stringify(defaultSettings));
}
const settings = extension_settings[EXTENSION_NAME];

let canvas, ctx, container, mapImageObj;
let isDragging = false, lastX, lastY;
let isTraveling = false; // Lock during travel
let travelAbortController = null;

// Location patterns (same as before)
const locationPatterns = [
    /\b(?:in|at|near|towards|reaches?|arrives? (?:at|in)|visit(?:ing)?|enter(?:ing)?|discovered|found)\s+(?:the\s+)?([A-Z][a-zA-Z\s']{1,25}(?:City|Town|Village|Forest|Mountains?|Castle|Tavern|Inn|Cave|Tower|Ruins|Temple|Bridge|River|Lake|Valley|Plains?|Desert|Island|Harbor|Keep|Dungeon|Grove|Cemetery|Shrine)?)\b/g,
    /\b(?:the\s+)?([A-Z][a-z]+(?:wood|dale|burg|heim|port|haven|gate|ford|crest|fall|peak|shore|keep|hall|crypt|grove|moor|wich|bury))\b/g
];

function initUI() {
    // Existing map container setup...
    createMapUI();
    
    // Create floating action button
    createFloatingButton();
    
    // Create travel overlay
    createTravelOverlay();
}

function createFloatingButton() {
    const fab = document.createElement('div');
    fab.id = 'ftm-fab';
    fab.innerHTML = `
        <div class="ftm-fab-icon">🗺️</div>
        <div class="ftm-fab-badge" style="display: none;">0</div>
        <div class="ftm-fab-tooltip">World Map</div>
    `;
    
    // Position from saved settings or default
    const defaultRight = '20px';
    const defaultBottom = '100px'; // Above input area
    fab.style.right = settings.floatButtonPos.x ? 'auto' : defaultRight;
    fab.style.left = settings.floatButtonPos.x ? settings.floatButtonPos.x : 'auto';
    fab.style.bottom = settings.floatButtonPos.y ? settings.floatButtonPos.y : defaultBottom;
    
    // Make draggable
    let isDraggingFab = false;
    let fabStartX, fabStartY, fabInitialLeft, fabInitialTop;
    
    fab.addEventListener('mousedown', (e) => {
        if (e.target.closest('.ftm-fab-tooltip')) return;
        isDraggingFab = true;
        fabStartX = e.clientX;
        fabStartY = e.clientY;
        const rect = fab.getBoundingClientRect();
        fabInitialLeft = rect.left;
        fabInitialTop = rect.top;
        fab.style.transition = 'none';
        fab.style.cursor = 'grabbing';
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDraggingFab) return;
        e.preventDefault();
        const dx = e.clientX - fabStartX;
        const dy = e.clientY - fabStartY;
        
        // Calculate new position relative to viewport edges
        const newLeft = fabInitialLeft + dx;
        const newTop = fabInitialTop + dy;
        
        // Constrain to viewport
        const maxX = window.innerWidth - 60;
        const maxY = window.innerHeight - 60;
        
        fab.style.left = Math.max(10, Math.min(newLeft, maxX)) + 'px';
        fab.style.top = Math.max(10, Math.min(newTop, maxY)) + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    });
    
    document.addEventListener('mouseup', () => {
        if (isDraggingFab) {
            isDraggingFab = false;
            fab.style.cursor = 'grab';
            fab.style.transition = 'transform 0.2s, box-shadow 0.2s';
            // Save position
            const rect = fab.getBoundingClientRect();
            settings.floatButtonPos.x = rect.left + 'px';
            settings.floatButtonPos.y = rect.top + 'px';
            saveSettingsDebounced();
        }
    });
    
    // Click to toggle map
    fab.addEventListener('click', (e) => {
        if (!isDraggingFab) toggleMap();
    });
    
    // Context menu for quick actions
    fab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showQuickTravelMenu();
    });
    
    document.body.appendChild(fab);
    updateFabBadge();
}

function createTravelOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'ftm-travel-overlay';
    overlay.innerHTML = `
        <div class="ftm-travel-content">
            <div class="ftm-travel-spinner"></div>
            <div class="ftm-travel-text">Initializing Warp...</div>
            <div class="ftm-travel-progress">
                <div class="ftm-travel-bar"></div>
            </div>
            <div class="ftm-travel-distance">Distance: <span>0</span> messages</div>
            <button class="ftm-travel-cancel">Cancel Journey</button>
        </div>
    `;
    
    overlay.querySelector('.ftm-travel-cancel').onclick = cancelTravel;
    document.body.appendChild(overlay);
}

function calculateTravelTime(fromMesId, toMesId) {
    const distance = Math.abs(fromMesId - toMesId);
    const time = Math.min(
        distance * settings.travelSpeed,
        settings.maxTravelTime
    );
    // Minimum 500ms even for adjacent messages
    return Math.max(time, 500);
}

async function fastTravel(waypoint) {
    if (isTraveling) {
        toastr.warning('Already traveling!', 'Please Wait');
        return;
    }
    
    if (!isDiscovered(waypoint)) {
        toastr.error('Location not discovered yet!', 'Unknown Territory');
        return;
    }
    
    const currentPos = settings.lastPosition;
    const targetPos = waypoint.mesId;
    const distance = Math.abs(currentPos - targetPos);
    
    // If distance is small (within 3 messages), instant travel
    if (distance <= 3) {
        performTravel(waypoint, true);
        return;
    }
    
    // Start journey
    isTraveling = true;
    travelAbortController = new AbortController();
    const signal = travelAbortController.signal;
    
    const travelTime = calculateTravelTime(currentPos, targetPos);
    const overlay = document.getElementById('ftm-travel-overlay');
    const progressBar = overlay.querySelector('.ftm-travel-bar');
    const distanceText = overlay.querySelector('.ftm-travel-distance span');
    const statusText = overlay.querySelector('.ftm-travel-text');
    
    overlay.style.display = 'flex';
    distanceText.textContent = distance;
    statusText.textContent = `Traveling to ${waypoint.name}...`;
    
    // Animate map if open
    if (container.style.display === 'flex' && settings.enableTravelAnimation) {
        animateMapJourney(currentPos, targetPos, travelTime);
    }
    
    // Progress animation
    const startTime = Date.now();
    const updateProgress = () => {
        if (signal.aborted) return;
        const elapsed = Date.now() - startTime;
        const progress = Math.min((elapsed / travelTime) * 100, 100);
        progressBar.style.width = progress + '%';
        
        // Update status text based on progress
        if (progress < 30) statusText.textContent = `Departing from current location...`;
        else if (progress < 70) statusText.textContent = `Traversing ${waypoint.biome || 'wilderness'}...`;
        else statusText.textContent = `Arriving at ${waypoint.name}...`;
        
        if (progress < 100 && isTraveling) {
            requestAnimationFrame(updateProgress);
        }
    };
    requestAnimationFrame(updateProgress);
    
    // Wait for travel time
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, travelTime);
            signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(new Error('Travel cancelled'));
            });
        });
        
        // Arrive
        performTravel(waypoint, false);
        
    } catch (err) {
        if (err.message === 'Travel cancelled') {
            toastr.info('Journey cancelled', 'Travel Aborted');
        }
    } finally {
        isTraveling = false;
        overlay.style.display = 'none';
        travelAbortController = null;
    }
}

function performTravel(waypoint, instant) {
    const messageElement = document.querySelector(`.mes[mesid="${waypoint.mesId}"]`);
    if (!messageElement) {
        toastr.error('Could not find location in chat history');
        return;
    }
    
    // Scroll to message
    messageElement.scrollIntoView({ behavior: instant ? 'smooth' : 'auto', block: 'center' });
    
    // Visual arrival effect
    const arrivalFlash = document.createElement('div');
    arrivalFlash.className = 'ftm-arrival-flash';
    document.body.appendChild(arrivalFlash);
    
    setTimeout(() => arrivalFlash.remove(), 1000);
    
    // Highlight message
    messageElement.style.backgroundColor = 'rgba(76, 175, 80, 0.3)';
    messageElement.style.transition = 'background-color 0.5s';
    setTimeout(() => {
        messageElement.style.backgroundColor = '';
    }, 3000);
    
    settings.lastPosition = waypoint.mesId;
    
    // Discover nearby
    settings.waypoints.forEach(wp => {
        if (Math.abs(wp.mesId - waypoint.mesId) <= settings.discoveryRadius) {
            discoverWaypoint(wp);
        }
    });
    
    renderMap();
    updateFabBadge();
    
    toastr.success(`Arrived at ${waypoint.name}${instant ? '' : ' after a long journey'}`, 'Destination Reached');
}

function cancelTravel() {
    if (travelAbortController) {
        travelAbortController.abort();
        isTraveling = false;
        document.getElementById('ftm-travel-overlay').style.display = 'none';
    }
}

function animateMapJourney(fromMesId, toMesId, duration) {
    // Find waypoints closest to these positions
    const fromWp = settings.waypoints.find(w => w.mesId === fromMesId) || 
                   settings.waypoints.reduce((prev, curr) => 
                       Math.abs(curr.mesId - fromMesId) < Math.abs(prev.mesId - fromMesId) ? curr : prev
                   );
    const toWp = settings.waypoints.find(w => w.mesId === toMesId);
    
    if (!fromWp || !toWp) return;
    
    const startX = settings.panX;
    const startY = settings.panY;
    const startZoom = settings.zoom;
    
    // Target: center the destination
    const targetX = (canvas.width / 2) - (toWp.x * startZoom);
    const targetY = (canvas.height / 2) - (toWp.y * startZoom);
    
    const startTime = Date.now();
    
    const animate = () => {
        const elapsed = Date.now() - startTime;
        const t = Math.min(elapsed / duration, 1);
        
        // Easing function (ease-in-out)
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        
        settings.panX = startX + (targetX - startX) * ease;
        settings.panY = startY + (targetY - startY) * ease;
        
        renderMap();
        
        if (t < 1 && isTraveling) {
            requestAnimationFrame(animate);
        }
    };
    
    requestAnimationFrame(animate);
}

function updateFabBadge() {
    const fab = document.getElementById('ftm-fab');
    if (!fab) return;
    
    const badge = fab.querySelector('.ftm-fab-badge');
    const nearbyUndiscovered = settings.waypoints.filter(w => {
        const dist = Math.abs(w.mesId - settings.lastPosition);
        return dist <= settings.discoveryRadius + 2 && !settings.discoveredIds.includes(w.id);
    }).length;
    
    if (nearbyUndiscovered > 0) {
        badge.textContent = nearbyUndiscovered;
        badge.style.display = 'flex';
        fab.classList.add('has-notification');
    } else {
        badge.style.display = 'none';
        fab.classList.remove('has-notification');
    }
}

function showQuickTravelMenu() {
    // Show recent discovered locations for quick access
    const recent = settings.waypoints
        .filter(w => settings.discoveredIds.includes(w.id))
        .sort((a, b) => b.mesId - a.mesId)
        .slice(0, 5);
    
    if (recent.length === 0) {
        toastr.info('No discovered locations yet. Keep exploring!');
        return;
    }
    
    const menu = document.createElement('div');
    menu.id = 'ftm-quick-menu';
    menu.innerHTML = `
        <div class="ftm-quick-header">Quick Travel</div>
        ${recent.map(w => `
            <div class="ftm-quick-item" data-id="${w.id}">
                <span class="ftm-quick-name">${w.name}</span>
                <span class="ftm-quick-dist">${Math.abs(w.mesId - settings.lastPosition)}msg</span>
            </div>
        `).join('')}
    `;
    
    menu.querySelectorAll('.ftm-quick-item').forEach(item => {
        item.onclick = () => {
            const wp = settings.waypoints.find(w => w.id === item.dataset.id);
            if (wp) fastTravel(wp);
            menu.remove();
        };
    });
    
    // Position near FAB
    const fab = document.getElementById('ftm-fab');
    const rect = fab.getBoundingClientRect();
    menu.style.left = (rect.left - 200) + 'px';
    menu.style.top = rect.top + 'px';
    
    document.body.appendChild(menu);
    
    // Close on click outside
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 100);
}

// Update existing functions to include badge updates...
const originalDiscoverWaypoint = discoverWaypoint;
discoverWaypoint = function(waypoint) {
    const wasNew = !settings.discoveredIds.includes(waypoint.id);
    originalDiscoverWaypoint(waypoint);
    if (wasNew) updateFabBadge();
};

// Event hooks (add updateFabBadge to message received)
const originalOnMessageReceived = onMessageReceived;
onMessageReceived = function(data) {
    originalOnMessageReceived(data);
    updateFabBadge();
};
