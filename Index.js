import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { callPopup, toastr } from "../../../../popup.js";
import { getRequestHeaders } from "../../../../utils.js";
import { getWorldInfo } from "../../../../world-info.js"; // World Info integration

const EXTENSION_NAME = "FastTravelMap";

const defaultSettings = {
    waypoints: [],
    discoveredIds: [],
    worldInfoLocations: [], // Static locations from WI
    discoveryRadius: 5,
    showFogOfWar: true,
    mapImage: null,
    generationParams: {
        enabled: true,
        promptTemplate: "fantasy world map, {locations}, discovered regions detailed, undiscovered areas fade to parchment edges, hand-drawn cartography style, aged paper texture, compass rose, magical atmosphere, artstation trending",
        negativePrompt: "blurry, low quality, modern elements, text, watermark, UI, buttons",
        width: 1024,
        height: 1024,
        steps: 25,
        scale: 7
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

if (!extension_settings[EXTENSION_NAME]) {
    extension_settings[EXTENSION_NAME] = JSON.parse(JSON.stringify(defaultSettings));
}
const settings = extension_settings[EXTENSION_NAME];

let canvas, ctx, container, mapImageObj = null;
let isDragging = false, lastX, lastY;
let isTraveling = false;
let travelAbortController = null;

// Enhanced location patterns
const locationPatterns = [
    /\b(?:in|at|near|towards|reaches?|arrives? (?:at|in)|visit(?:ing)?|enter(?:ing)?|discovered|found|approaching|leaving)\s+(?:the\s+)?([A-Z][a-zA-Z\s']{1,30}(?:City|Town|Village|Forest|Mountains?|Castle|Tavern|Inn|Cave|Tower|Ruins|Temple|Bridge|River|Lake|Valley|Plains?|Desert|Island|Harbor|Keep|Dungeon|Grove|Cemetery|Shrine|Fort|Outpost|Camp|Meadow))?)\b/g,
    /\b(?:the\s+)?([A-Z][a-z]+(?:wood|dale|burg|heim|port|haven|gate|ford|crest|fall|peak|shore|keep|hall|crypt|grove|moor|wich| bury|stead|ton))\b/g
];

function initUI() {
    createFloatingButton();
    createMapContainer();
    createTravelOverlay();
    
    if (settings.mapImage) {
        mapImageObj = new Image();
        mapImageObj.onload = () => renderMap();
        mapImageObj.src = settings.mapImage;
    }
    
    // Initial World Info scan
    setTimeout(scanWorldInfo, 2000);
}

function createFloatingButton() {
    const fab = document.createElement('div');
    fab.id = 'ftm-fab';
    fab.innerHTML = `
        <div class="ftm-fab-icon">🗺️</div>
        <div class="ftm-fab-badge" style="display: none;">0</div>
        <div class="ftm-fab-tooltip">World Map</div>
    `;
    
    // Position
    fab.style.right = settings.floatButtonPos.x ? 'auto' : '20px';
    fab.style.left = settings.floatButtonPos.x || 'auto';
    fab.style.bottom = settings.floatButtonPos.y ? 'auto' : '100px';
    fab.style.top = settings.floatButtonPos.y || 'auto';
    
    // Drag logic
    let isDraggingFab = false, dragOffsetX, dragOffsetY;
    
    fab.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDraggingFab = true;
        const rect = fab.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        fab.style.transition = 'none';
        fab.style.cursor = 'grabbing';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDraggingFab) return;
        const x = e.clientX - dragOffsetX;
        const y = e.clientY - dragOffsetY;
        fab.style.left = `${Math.max(10, Math.min(x, window.innerWidth - 66))}px`;
        fab.style.top = `${Math.max(10, Math.min(y, window.innerHeight - 66))}px`;
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
        if (e.target.closest('.ftm-fab-tooltip')) return;
        toggleMap();
    });
    
    fab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showQuickTravelMenu();
    });
    
    document.body.appendChild(fab);
    updateFabBadge();
}

function createMapContainer() {
    container = document.createElement('div');
    container.id = 'ftm-container';
    container.innerHTML = `
        <div id="ftm-header">
            <span>🗺️ World Map <span id="ftm-discovered-count">(0)</span></span>
            <div class="ftm-header-controls">
                <button id="ftm-scan-wi" title="Scan World Info">📚</button>
                <button id="ftm-generate" title="Generate Map Image">🎨</button>
                <button id="ftm-settings" title="Settings">⚙️</button>
                <button id="ftm-clear" title="Clear Map">🗑️</button>
                <button id="ftm-close" title="Close">✕</button>
            </div>
        </div>
        <canvas id="ftm-canvas" width="320" height="400"></canvas>
        <div id="ftm-controls-hint">
            <span>Scroll: Zoom</span> • <span>Drag: Pan</span> • <span>Click: Travel</span> • <span>Shift+Click: Add WP</span>
        </div>
    `;
    document.body.appendChild(container);
    
    document.getElementById('ftm-close').onclick = () => container.style.display = 'none';
    document.getElementById('ftm-clear').onclick = clearWaypoints;
    document.getElementById('ftm-generate').onclick = generateMapImage;
    document.getElementById('ftm-settings').onclick = showSettings;
    document.getElementById('ftm-scan-wi').onclick = scanWorldInfo;
    
    canvas = document.getElementById('ftm-canvas');
    ctx = canvas.getContext('2d');
    
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel);
    canvas.addEventListener('click', handleCanvasClick);
}

function createTravelOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'ftm-travel-overlay';
    overlay.innerHTML = `
        <div class="ftm-travel-content">
            <div class="ftm-travel-portal">
                <div class="ftm-travel-sphere"></div>
                <div class="ftm-travel-ring"></div>
                <div class="ftm-travel-ring" style="animation-delay: -1s"></div>
            </div>
            <div class="ftm-travel-text">Initializing Journey...</div>
            <div class="ftm-travel-progress">
                <div class="ftm-travel-bar"></div>
            </div>
            <div class="ftm-travel-detail">Distance: <span id="ftm-travel-dist">0</span> messages</div>
            <button class="ftm-travel-cancel">Cancel Journey</button>
        </div>
    `;
    
    overlay.querySelector('.ftm-travel-cancel').onclick = cancelTravel;
    document.body.appendChild(overlay);
}

// World Info Integration
async function scanWorldInfo() {
    try {
        const wi = getWorldInfo();
        if (!wi || !wi.length) {
            toastr.info('No World Info entries found');
            return;
        }
        
        let foundCount = 0;
        
        wi.forEach(entry => {
            if (!entry.content) return;
            
            // Extract from entry keys and content
            const text = `${entry.key.join(' ')} ${entry.content}`;
            const locations = extractLocations(text);
            
            locations.forEach(loc => {
                // Check if already exists from WI
                const exists = settings.worldInfoLocations.some(w => 
                    w.name.toLowerCase() === loc.toLowerCase()
                );
                
                if (!exists) {
                    // WI locations are "known" but not "discovered" in chat yet
                    const waypoint = createWaypoint(loc, -1); // -1 indicates WI origin
                    waypoint.fromWorldInfo = true;
                    settings.worldInfoLocations.push(waypoint);
                    settings.waypoints.push(waypoint);
                    foundCount++;
                }
            });
        });
        
        if (foundCount > 0) {
            saveSettingsDebounced();
            renderMap();
            toastr.success(`Found ${foundCount} locations in World Info`);
        }
    } catch (err) {
        console.error('[FastTravelMap] WI Scan error:', err);
    }
}

function createWaypoint(name, mesId) {
    // Position using golden ratio spiral for organic spread
    const idx = settings.waypoints.length;
    const angle = idx * 2.39996; // Golden angle
    const radius = 30 + (idx * 5) % 100; // Spiral out
    const x = 160 + radius * Math.cos(angle);
    const y = 200 + radius * Math.sin(angle);
    
    return {
        id: `wp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: name,
        mesId: mesId,
        x: x,
        y: y,
        timestamp: Date.now(),
        biome: determineBiome(name),
        fromWorldInfo: mesId === -1
    };
}

function determineBiome(name) {
    const lower = name.toLowerCase();
    if (lower.includes('forest') || lower.includes('wood') || lower.includes('grove')) return 'forest';
    if (lower.includes('mountain') || lower.includes('peak') || lower.includes('cliff')) return 'mountain';
    if (lower.includes('water') || lower.includes('lake') || lower.includes('river') || lower.includes('sea')) return 'water';
    if (lower.includes('desert') || lower.includes('sand') || lower.includes('dune')) return 'desert';
    if (lower.includes('city') || lower.includes('town') || lower.includes('burg') || lower.includes('capital')) return 'city';
    if (lower.includes('cave') || lower.includes('dungeon') || lower.includes('crypt')) return 'dungeon';
    if (lower.includes('temple') || lower.includes('shrine')) return 'temple';
    return 'plains';
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

// Discovery Logic
function isDiscovered(waypoint) {
    if (!settings.showFogOfWar) return true;
    if (waypoint.fromWorldInfo) return true; // WI locations are known lore
    if (settings.discoveredIds.includes(waypoint.id)) return true;
    
    // Within discovery radius of current position
    const dist = Math.abs(waypoint.mesId - settings.lastPosition);
    return dist <= settings.discoveryRadius;
}

function discoverWaypoint(waypoint) {
    if (!settings.discoveredIds.includes(waypoint.id) && !waypoint.fromWorldInfo) {
        settings.discoveredIds.push(waypoint.id);
        saveSettingsDebounced();
        updateFabBadge();
        
        // Animation effect on map
        if (container.style.display === 'flex') {
            drawDiscoveryPulse(waypoint);
        }
        
        toastr.success(`Discovered: ${waypoint.name}!`, 'New Location', {
            timeOut: 2000,
            positionClass: 'toast-bottom-right'
        });
    }
}

function drawDiscoveryPulse(waypoint) {
    const screenX = (waypoint.x * settings.zoom) + settings.panX;
    const screenY = (waypoint.y * settings.zoom) + settings.panY;
    
    const pulse = document.createElement('div');
    pulse.className = 'ftm-discovery-pulse';
    pulse.style.left = screenX + 'px';
    pulse.style.top = screenY + 'px';
    container.appendChild(pulse);
    
    setTimeout(() => pulse.remove(), 1000);
}

// Travel System
function calculateTravelTime(fromMesId, toMesId) {
    const distance = Math.abs(fromMesId - toMesId);
    if (distance <= 3) return 0; // Instant for nearby
    return Math.min(distance * settings.travelSpeed, settings.maxTravelTime);
}

async function fastTravel(waypoint) {
    if (isTraveling) {
        toastr.warning('Already traveling!', 'Warp Active');
        return;
    }
    
    if (!isDiscovered(waypoint)) {
        toastr.error('Cannot travel to undiscovered location!', 'Unknown Territory');
        return;
    }
    
    const currentPos = settings.lastPosition;
    const targetPos = waypoint.mesId;
    const distance = Math.abs(currentPos - targetPos);
    const travelTime = calculateTravelTime(currentPos, targetPos);
    
    if (travelTime === 0) {
        performTravel(waypoint, true);
        return;
    }
    
    isTraveling = true;
    travelAbortController = new AbortController();
    const signal = travelAbortController.signal;
    
    const overlay = document.getElementById('ftm-travel-overlay');
    const progressBar = overlay.querySelector('.ftm-travel-bar');
    const distText = document.getElementById('ftm-travel-dist');
    const statusText = overlay.querySelector('.ftm-travel-text');
    
    overlay.style.display = 'flex';
    distText.textContent = distance;
    
    if (container.style.display === 'flex' && settings.enableTravelAnimation) {
        animateMapJourney(currentPos, targetPos, travelTime);
    }
    
    const startTime = Date.now();
    
    const updateProgress = () => {
        if (signal.aborted) return;
        const elapsed = Date.now() - startTime;
        const progress = Math.min((elapsed / travelTime) * 100, 100);
        progressBar.style.width = progress + '%';
        
        if (progress < 30) statusText.textContent = `Departing...`;
        else if (progress < 70) statusText.textContent = `Traversing ${waypoint.biome}...`;
        else statusText.textContent = `Arriving at ${waypoint.name}...`;
        
        if (progress < 100 && isTraveling) requestAnimationFrame(updateProgress);
    };
    requestAnimationFrame(updateProgress);
    
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, travelTime);
            signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(new Error('cancelled'));
            });
        });
        
        performTravel(waypoint, false);
    } catch (err) {
        if (err.message === 'cancelled') {
            toastr.info('Journey aborted', 'Travel Cancelled');
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
        toastr.error('Location not found in chat history');
        return;
    }
    
    messageElement.scrollIntoView({ behavior: instant ? 'smooth' : 'auto', block: 'center' });
    
    // Flash effect
    const flash = document.createElement('div');
    flash.className = 'ftm-arrival-flash';
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 1000);
    
    // Highlight
    messageElement.style.backgroundColor = 'rgba(102, 126, 234, 0.3)';
    messageElement.style.transition = 'background-color 0.5s';
    setTimeout(() => messageElement.style.backgroundColor = '', 3000);
    
    settings.lastPosition = waypoint.mesId;
    
    // Discover surroundings on arrival
    settings.waypoints.forEach(wp => {
        if (Math.abs(wp.mesId - waypoint.mesId) <= settings.discoveryRadius) {
            discoverWaypoint(wp);
        }
    });
    
    renderMap();
    updateFabBadge();
    
    if (!instant) {
        toastr.success(`Arrived at ${waypoint.name}`, 'Destination Reached');
    }
}

function cancelTravel() {
    if (travelAbortController) {
        travelAbortController.abort();
        isTraveling = false;
        document.getElementById('ftm-travel-overlay').style.display = 'none';
    }
}

function animateMapJourney(fromMesId, toMesId, duration) {
    const targetWp = settings.waypoints.find(w => w.mesId === toMesId);
    if (!targetWp) return;
    
    const startX = settings.panX;
    const startY = settings.panY;
    const targetX = (canvas.width / 2) - (targetWp.x * settings.zoom);
    const targetY = (canvas.height / 2) - (targetWp.y * settings.zoom);
    const startTime = Date.now();
    
    const animate = () => {
        const elapsed = Date.now() - startTime;
        const t = Math.min(elapsed / duration, 1);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        
        settings.panX = startX + (targetX - startX) * ease;
        settings.panY = startY + (targetY - startY) * ease;
        renderMap();
        
        if (t < 1 && isTraveling) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
}

// AI Generation
async function generateMapImage() {
    const discovered = settings.waypoints.filter(w => isDiscovered(w));
    if (discovered.length === 0) {
        toastr.warning('Discover locations first!');
        return;
    }
    
    const locDescs = discovered.slice(0, 15).map(w => `${w.name}(${w.biome})`).join(', ');
    const prompt = settings.generationParams.promptTemplate.replace('{locations}', locDescs);
    
    toastr.info('Generating world map...', 'AI Cartographer');
    
    try {
        const response = await fetch('/api/image', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                prompt: prompt,
                negative_prompt: settings.generationParams.negativePrompt,
                width: settings.generationParams.width,
                height: settings.generationParams.height,
                steps: settings.generationParams.steps,
                scale: settings.generationParams.scale,
                model: 'sd' // Adjust based on user's setup
            })
        });
        
        if (!response.ok) throw new Error('Generation failed');
        
        const data = await response.json();
        if (data.image) {
            settings.mapImage = data.image;
            mapImageObj = new Image();
            mapImageObj.onload = () => {
                renderMap();
                toastr.success('Map updated!', 'Generation Complete');
            };
            mapImageObj.src = data.image;
            saveSettingsDebounced();
        }
    } catch (err) {
        toastr.error('Check console for details', 'Generation Failed');
        console.error(err);
    }
}

// Rendering
function renderMap() {
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, w, h);
    
    // Draw map background
    if (mapImageObj) {
        const scale = Math.max(w / mapImageObj.width, h / mapImageObj.height);
        const x = (w / 2) - (mapImageObj.width / 2) * scale;
        const y = (h / 2) - (mapImageObj.height / 2) * scale;
        ctx.globalAlpha = 0.7;
        ctx.drawImage(mapImageObj, x, y, mapImageObj.width * scale, mapImageObj.height * scale);
        ctx.globalAlpha = 1;
    } else {
        drawProceduralBackground();
    }
    
    ctx.save();
    ctx.translate(settings.panX, settings.panY);
    ctx.scale(settings.zoom, settings.zoom);
    
    // Render waypoints
    const discovered = settings.waypoints.filter(w => isDiscovered(w));
    const undiscovered = settings.waypoints.filter(w => !isDiscovered(w));
    
    // Draw path lines between sequential discovered locations
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.3)';
    ctx.lineWidth = 2 / settings.zoom;
    ctx.setLineDash([5, 5]);
    for (let i = 0; i < discovered.length - 1; i++) {
        const curr = discovered[i];
        const next = discovered.find(w => w.mesId > curr.mesId);
        if (next && next.mesId - curr.mesId < 50) { // Only connect nearby in time
            ctx.beginPath();
            ctx.moveTo(curr.x, curr.y);
            ctx.lineTo(next.x, next.y);
            ctx.stroke();
        }
    }
    ctx.setLineDash([]);
    
    // Undiscovered hints (very faint)
    undiscovered.forEach(wp => {
        const dist = Math.abs(wp.mesId - settings.lastPosition);
        if (dist <= settings.discoveryRadius + 5 && !wp.fromWorldInfo) {
            ctx.beginPath();
            ctx.arc(wp.x, wp.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(100, 100, 100, ${0.3 - (dist * 0.05)})`;
            ctx.fill();
        }
    });
    
    // Discovered waypoints
    discovered.forEach(wp => {
        // Glow
        const grad = ctx.createRadialGradient(wp.x, wp.y, 0, wp.x, wp.y, 20);
        grad.addColorStop(0, 'rgba(102, 126, 234, 0.4)');
        grad.addColorStop(1, 'rgba(102, 126, 234, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, 20, 0, Math.PI * 2);
        ctx.fill();
        
        // Color by biome
        const colors = {
            forest: '#228B22', mountain: '#8B4513', water: '#1E90FF',
            desert: '#FFA500', city: '#FFD700', plains: '#90EE90',
            dungeon: '#4a4a4a', temple: '#9370DB'
        };
        
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = colors[wp.biome] || '#667eea';
        ctx.fill();
        
        // Border - white for current, gold for WI, default for others
        ctx.strokeStyle = wp.mesId === settings.lastPosition ? '#fff' : (wp.fromWorldInfo ? '#FFD700' : '#333');
        ctx.lineWidth = wp.mesId === settings.lastPosition ? 3 : 2;
        ctx.stroke();
        
        // Current position indicator
        if (wp.mesId === settings.lastPosition) {
            ctx.beginPath();
            ctx.arc(wp.x, wp.y, 14, 0, Math.PI * 2);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        
        // Label
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px Arial';
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 3;
        ctx.fillText(wp.name, wp.x + 12, wp.y + 4);
        ctx.shadowBlur = 0;
    });
    
    ctx.restore();
    
    // Fog overlay
    if (settings.showFogOfWar) {
        drawFogOverlay();
    }
    
    // UI Text
    ctx.fillStyle = '#fff';
    ctx.font = '12px Arial';
    const discCount = settings.discoveredIds.length + settings.worldInfoLocations.length;
    ctx.fillText(`Discovered: ${discounted}/${settings.waypoints.length}`, 10, 20);
}

function drawProceduralBackground() {
    // Subtle noise/terrain
    settings.waypoints.filter(w => isDiscovered(w)).forEach(wp => {
        const sx = (wp.x * settings.zoom) + settings.panX;
        const sy = (wp.y * settings.zoom) + settings.panY;
        const colors = {
            forest: 'rgba(34,139,34,0.15)', mountain: 'rgba(139,69,19,0.15)',
            water: 'rgba(30,144,255,0.15)', city: 'rgba(255,215,0,0.1)'
        };
        ctx.fillStyle = colors[wp.biome] || 'rgba(100,100,100,0.1)';
        ctx.beginPath();
        ctx.arc(sx, sy, 50 * settings.zoom, 0, Math.PI * 2);
        ctx.fill();
    });
}

function drawFogOverlay() {
    const currentWp = settings.waypoints.find(w => w.mesId === settings.lastPosition);
    if (!currentWp) return;
    
    const cx = (currentWp.x * settings.zoom) + settings.panX;
    const cy = (currentWp.y * settings.zoom) + settings.panY;
    
    const grad = ctx.createRadialGradient(cx, cy, 30, cx, cy, 150);
    grad.addColorStop(0, 'rgba(0,0,10,0)');
    grad.addColorStop(1, 'rgba(0,0,10,0.6)');
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Input Handling
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
    const oldZoom = settings.zoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    settings.zoom = Math.max(0.5, Math.min(3, settings.zoom * delta));
    
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    settings.panX = mx - (mx - settings.panX) * (settings.zoom / oldZoom);
    settings.panY = my - (my - settings.panY) * (settings.zoom / oldZoom);
    
    renderMap();
    saveSettingsDebounced();
}

function handleCanvasClick(e) {
    if (isTraveling) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - settings.panX) / settings.zoom;
    const y = (e.clientY - rect.top - settings.panY) / settings.zoom;
    
    // Check waypoints (reverse for top-first)
    for (let i = settings.waypoints.length - 1; i >= 0; i--) {
        const wp = settings.waypoints[i];
        const dist = Math.hypot(x - wp.x, y - wp.y);
        if (dist < 15) {
            fastTravel(wp);
            return;
        }
    }
    
    // Add custom waypoint
    if (e.shiftKey) {
        createCustomWaypoint(x, y);
    }
}

async function createCustomWaypoint(x, y) {
    const name = await callPopup('Enter location name:', 'input');
    if (!name) return;
    
    const context = getContext();
    const wp = {
        id: `wp_${Date.now()}`,
        name: name,
        mesId: context.chat.length - 1,
        x: x,
        y: y,
        timestamp: Date.now(),
        biome: determineBiome(name),
        fromWorldInfo: false
    };
    
    settings.waypoints.push(wp);
    discoverWaypoint(wp);
    saveSettingsDebounced();
    renderMap();
}

function showQuickTravelMenu() {
    const recent = settings.waypoints
        .filter(w => isDiscovered(w))
        .sort((a, b) => b.mesId - a.mesId)
        .slice(0, 6);
    
    if (recent.length === 0) {
        toastr.info('No locations discovered yet!');
        return;
    }
    
    // Remove existing
    const existing = document.getElementById('ftm-quick-menu');
    if (existing) existing.remove();
    
    const menu = document.createElement('div');
    menu.id = 'ftm-quick-menu';
    menu.innerHTML = `
        <div class="ftm-quick-header">⚡ Quick Travel</div>
        ${recent.map(w => `
            <div class="ftm-quick-item" data-id="${w.id}">
                <span class="ftm-quick-name">${w.fromWorldInfo ? '📚 ' : ''}${w.name}</span>
                <span class="ftm-quick-dist">${w.mesId >= 0 ? Math.abs(w.mesId - settings.lastPosition) + 'msg' : 'Lore'}</span>
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
    
    const fab = document.getElementById('ftm-fab');
    const rect = fab.getBoundingClientRect();
    menu.style.left = Math.max(10, rect.left - 220) + 'px';
    menu.style.top = rect.top + 'px';
    
    document.body.appendChild(menu);
    
    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            if (!menu.contains(e.target) && e.target !== fab) {
                menu.remove();
                document.removeEventListener('click', close);
            }
        });
    }, 100);
}

function showSettings() {
    const html = `
        <div style="text-align: left; max-height: 70vh; overflow-y: auto;">
            <h3>🔍 Discovery</h3>
            <label>Discovery Radius (messages): 
                <input type="number" id="ftm-radius" value="${settings.discoveryRadius}" min="1" max="50" style="width: 60px;">
            </label><br>
            <label><input type="checkbox" id="ftm-fog" ${settings.showFogOfWar ? 'checked' : ''}> Enable Fog of War</label>
            
            <h3>⏱️ Travel</h3>
            <label>Speed (ms/msg): <input type="number" id="ftm-speed" value="${settings.travelSpeed}" min="0" max="1000"></label><br>
            <label>Max Time (ms): <input type="number" id="ftm-max" value="${settings.maxTravelTime}" min="1000" max="30000"></label><br>
            <label><input type="checkbox" id="ftm-anim" ${settings.enableTravelAnimation ? 'checked' : ''}> Animate Map During Travel</label>
            
            <h3>🎨 AI Generation</h3>
            <label><input type="checkbox" id="ftm-gen" ${settings.generationParams.enabled ? 'checked' : ''}> Enable Image Gen</label><br>
            <label>Width: <input type="number" id="ftm-w" value="${settings.generationParams.width}" step="64"></label>
            <label>Height: <input type="number" id="ftm-h" value="${settings.generationParams.height}" step="64"></label><br>
            <label>Prompt Template:<br>
                <textarea id="ftm-prompt" rows="3" style="width: 100%;">${settings.generationParams.promptTemplate}</textarea>
            </label>
            
            <h3>⚙️ Debug</h3>
            <button id="ftm-reveal" style="background: #ff4444; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">
                Reveal All (Cheat)
            </button>
            <button id="ftm-rescan" style="background: #4444ff; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; margin-left: 5px;">
                Rescan World Info
            </button>
        </div>
    `;
    
    callPopup(html, 'confirm', null, { okButton: 'Save', cancelButton: 'Cancel' }).then(result => {
        if (result) {
            settings.discoveryRadius = parseInt(document.getElementById('ftm-radius').value);
            settings.showFogOfWar = document.getElementById('ftm-fog').checked;
            settings.travelSpeed = parseInt(document.getElementById('ftm-speed').value);
            settings.maxTravelTime = parseInt(document.getElementById('ftm-max').value);
            settings.enableTravelAnimation = document.getElementById('ftm-anim').checked;
            settings.generationParams.enabled = document.getElementById('ftm-gen').checked;
            settings.generationParams.width = parseInt(document.getElementById('ftm-w').value);
            settings.generationParams.height = parseInt(document.getElementById('ftm-h').value);
            settings.generationParams.promptTemplate = document.getElementById('ftm-prompt').value;
            
            saveSettingsDebounced();
            renderMap();
            toastr.success('Settings saved');
        }
    });
    
    document.getElementById('ftm-reveal').onclick = () => {
        settings.waypoints.forEach(discoverWaypoint);
        renderMap();
    };
    
    document.getElementById('ftm-rescan').onclick = () => {
        scanWorldInfo();
        document.querySelector('.popup_wrapper').click();
    };
}

function updateFabBadge() {
    const fab = document.getElementById('ftm-fab');
    if (!fab) return;
    
    const badge = fab.querySelector('.ftm-fab-badge');
    const nearby = settings.waypoints.filter(w => {
        if (w.fromWorldInfo) return false;
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

function clearWaypoints() {
    if (!confirm('Clear all discovered progress? World Info locations will remain.')) return;
    
    settings.waypoints = settings.waypoints.filter(w => w.fromWorldInfo);
    settings.discoveredIds = settings.worldInfoLocations.map(w => w.id);
    settings.lastPosition = 0;
    saveSettingsDebounced();
    renderMap();
    updateFabBadge();
    toastr.success('Map cleared');
}

// Event Listeners
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
} else {
    initUI();
}

const context = getContext();

// Handle new messages
context.eventSource.on(context.event_types.MESSAGE_RECEIVED, (data) => {
    const idx = context.chat.length - 1;
    const msg = context.chat[idx];
    if (!msg?.mes) return;
    
    settings.lastPosition = idx;
    
    // Extract from message
    const locations = extractLocations(msg.mes);
    locations.forEach(loc => {
        // Check if exists
        const exists = settings.waypoints.find(w => 
            w.name.toLowerCase() === loc.toLowerCase() && w.mesId === idx
        );
        if (!exists) {
            const wp = createWaypoint(loc, idx);
            settings.waypoints.push(wp);
            discoverWaypoint(wp);
        }
    });
    
    // Check proximity discoveries
    settings.waypoints.forEach(wp => {
        if (Math.abs(wp.mesId - idx) <= settings.discoveryRadius) {
            discoverWaypoint(wp);
        }
    });
    
    saveSettingsDebounced();
    if (container.style.display === 'flex') renderMap();
    updateFabBadge();
});

// Chat change - reset dynamic waypoints but keep WI
context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
    settings.waypoints = settings.waypoints.filter(w => w.fromWorldInfo);
    settings.discoveredIds = settings.worldInfoLocations.map(w => w.id);
    settings.lastPosition = 0;
    settings.mapImage = null;
    mapImageObj = null;
    updateFabBadge();
    if (container?.style.display === 'flex') renderMap();
    
    // Rescan WI for new chat
    setTimeout(scanWorldInfo, 1000);
});

console.log('[FastTravelMap] Definitive Edition loaded');
