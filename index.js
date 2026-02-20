import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { callPopup, toastr } from "../../../../popup.js";
import { getRequestHeaders } from "../../../../utils.js";

const EXTENSION_NAME = "FastTravelMap";

const defaultSettings = {
    waypoints: [],
    discoveredIds: [], // Track which waypoints have been revealed
    discoveryRadius: 5, // Messages within this range are visible
    showFogOfWar: true,
    mapImage: null, // Base64 of generated map
    generationParams: {
        enabled: true,
        promptTemplate: "fantasy world map, {locations}, hand drawn style, parchment texture, cartography, detailed landscape, artstation",
        negativePrompt: "blurry, low quality, modern, text, watermark",
        width: 1024,
        height: 1024
    },
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

let canvas, ctx, container, mapImageObj = null;
let isDragging = false, lastX, lastY;

// Location extraction patterns (enhanced)
const locationPatterns = [
    /\b(?:in|at|near|towards|reaches?|arrives? (?:at|in)|visit(?:ing)?|enter(?:ing)?|discovered|found)\s+(?:the\s+)?([A-Z][a-zA-Z\s']{1,25}(?:City|Town|Village|Forest|Mountains?|Castle|Tavern|Inn|Cave|Tower|Ruins|Temple|Bridge|River|Lake|Valley|Plains?|Desert|Island|Harbor|Keep|Dungeon|Grove|Cemetery|Shrine)?)\b/g,
    /\b(?:the\s+)?([A-Z][a-z]+(?:wood|dale|burg|heim|port|haven|gate|ford|crest|fall|peak|shore|keep|hall|crypt|grove|moor|wich|bury))\b/g
];

function initUI() {
    // Create toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'ftm-toggle';
    toggleBtn.innerHTML = '🗺️ World Map';
    toggleBtn.title = 'Open Fast Travel Map';
    toggleBtn.onclick = toggleMap;
    document.body.appendChild(toggleBtn);

    // Create map container with new controls
    container = document.createElement('div');
    container.id = 'ftm-container';
    container.innerHTML = `
        <div id="ftm-header">
            <span>🗺️ World Map <span id="ftm-discovered-count">(0 found)</span></span>
            <div>
                <button id="ftm-generate" title="Generate Map Image">🎨</button>
                <button id="ftm-settings" title="Settings">⚙️</button>
                <button id="ftm-clear" title="Clear Map">🗑️</button>
                <button id="ftm-close" title="Close">✕</button>
            </div>
        </div>
        <div id="ftm-canvas-container">
            <canvas id="ftm-canvas" width="300" height="340"></canvas>
            <div id="ftm-fog-overlay"></div>
        </div>
        <div id="ftm-tooltip"></div>
        <div id="ftm-controls-hint">
            Scroll: Zoom | Drag: Pan | Click: Travel | Shift+Click: Custom WP
        </div>
    `;
    document.body.appendChild(container);

    // Event listeners
    document.getElementById('ftm-close').onclick = () => container.style.display = 'none';
    document.getElementById('ftm-clear').onclick = clearWaypoints;
    document.getElementById('ftm-generate').onclick = generateMapImage;
    document.getElementById('ftm-settings').onclick = showSettings;
    
    canvas = document.getElementById('ftm-canvas');
    ctx = canvas.getContext('2d');
    
    // Canvas interactions
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel);
    canvas.addEventListener('click', handleCanvasClick);
    
    // Load existing map image if available
    if (settings.mapImage) {
        mapImageObj = new Image();
        mapImageObj.onload = () => renderMap();
        mapImageObj.src = settings.mapImage;
    }
    
    updateDiscoveredCount();
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

// Check if a waypoint should be visible based on discovery rules
function isDiscovered(waypoint) {
    // Always show if fog of war disabled
    if (!settings.showFogOfWar) return true;
    
    // Show if explicitly discovered
    if (settings.discoveredIds.includes(waypoint.id)) return true;
    
    // Show if within discovery radius of current position
    const dist = Math.abs(waypoint.mesId - settings.lastPosition);
    return dist <= settings.discoveryRadius;
}

function discoverWaypoint(waypoint) {
    if (!settings.discoveredIds.includes(waypoint.id)) {
        settings.discoveredIds.push(waypoint.id);
        saveSettingsDebounced();
        updateDiscoveredCount();
        
        // Visual notification
        toastr.success(`Discovered: ${waypoint.name}!`, 'New Location', {
            timeOut: 2000,
            positionClass: 'toast-bottom-right'
        });
    }
}

function addWaypoint(name, mesId) {
    // Check if exists at this message
    const existing = settings.waypoints.find(w => w.mesId === mesId && w.name === name);
    if (existing) {
        // Auto-discover if we're at this message
        if (mesId === settings.lastPosition) {
            discoverWaypoint(existing);
        }
        return;
    }
    
    // Generate pseudo-random position based on name for consistency
    const hash = name.split('').reduce((a,b) => a + b.charCodeAt(0), 0);
    // Use golden ratio spiral for better distribution
    const angle = hash * 2.39996; // golden angle
    const radius = 20 + (hash % 120);
    const x = 150 + radius * Math.cos(angle);
    const y = 170 + radius * Math.sin(angle);
    
    const waypoint = {
        id: `wp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: name,
        mesId: mesId,
        x: x,
        y: y,
        timestamp: Date.now(),
        biome: determineBiome(name) // For map generation prompts
    };
    
    settings.waypoints.push(waypoint);
    
    // Auto-discover if within radius or it's the current message
    if (Math.abs(mesId - settings.lastPosition) <= settings.discoveryRadius) {
        discoverWaypoint(waypoint);
    }
    
    saveSettingsDebounced();
    if (container.style.display === 'flex') renderMap();
}

function determineBiome(name) {
    const lower = name.toLowerCase();
    if (lower.includes('forest') || lower.includes('wood') || lower.includes('grove')) return 'forest';
    if (lower.includes('mountain') || lower.includes('peak')) return 'mountain';
    if (lower.includes('water') || lower.includes('lake') || lower.includes('river')) return 'water';
    if (lower.includes('desert') || lower.includes('sand')) return 'desert';
    if (lower.includes('city') || lower.includes('town') || lower.includes('burg')) return 'city';
    return 'plains';
}

function onMessageReceived(data) {
    const context = getContext();
    const index = context.chat.length - 1;
    const message = context.chat[index];
    
    if (!message || !message.mes) return;
    
    settings.lastPosition = index;
    
    // Extract and add waypoints
    const locations = extractLocations(message.mes);
    locations.forEach(loc => addWaypoint(loc, index));
    
    // Check discovery for nearby waypoints (walking into range)
    settings.waypoints.forEach(wp => {
        if (Math.abs(wp.mesId - index) <= settings.discoveryRadius) {
            discoverWaypoint(wp);
        }
    });
    
    if (container.style.display === 'flex') renderMap();
}

// AI Image Generation Integration
async function generateMapImage() {
    if (!settings.generationParams.enabled) {
        toastr.warning('Image generation is disabled in settings');
        return;
    }
    
    const discoveredWps = settings.waypoints.filter(w => 
        settings.discoveredIds.includes(w.id)
    );
    
    if (discoveredWps.length === 0) {
        toastr.warning('Discover some locations first!');
        return;
    }
    
    // Build prompt from discovered locations
    const locationDescs = discoveredWps.map(w => {
        const biome = w.biome || 'location';
        return `${w.name} (${biome})`;
    }).join(', ');
    
    const prompt = settings.generationParams.promptTemplate
        .replace('{locations}', locationDescs)
        .replace('{count}', discoveredWps.length);
    
    toastr.info('Generating map image... This may take a moment.', 'AI Map');
    
    try {
        // Method 1: Use SillyTavern's internal image generation if available
        // This assumes SD or NovelAI is configured in SillyTavern
        const imageData = await generateImageViaAPI(prompt);
        
        if (imageData) {
            settings.mapImage = imageData;
            mapImageObj = new Image();
            mapImageObj.onload = () => {
                renderMap();
                toastr.success('Map generated successfully!');
            };
            mapImageObj.src = imageData;
            saveSettingsDebounced();
        }
    } catch (error) {
        console.error('[FastTravelMap] Generation error:', error);
        toastr.error('Failed to generate map. Check console for details.');
    }
}

// Generate image using SillyTavern's backend endpoints
async function generateImageViaAPI(prompt) {
    const context = getContext();
    
    // Option 1: Try to use text2img endpoint (requires SillyTavern backend)
    const response = await fetch('/api/image', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            prompt: prompt,
            negative_prompt: settings.generationParams.negativePrompt,
            width: settings.generationParams.width,
            height: settings.generationParams.height,
            steps: 20,
            scale: 7,
            // Use the user's currently selected image generation source
            source: 'sd', // or 'novelai', 'openai', etc.
        })
    });
    
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    return data.image; // Base64 string
}

function renderMap() {
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, width, height);
    
    // Draw generated map background if available
    if (mapImageObj) {
        // Calculate cover fit
        const scale = Math.max(width / mapImageObj.width, height / mapImageObj.height);
        const x = (width / 2) - (mapImageObj.width / 2) * scale;
        const y = (height / 2) - (mapImageObj.height / 2) * scale;
        
        ctx.globalAlpha = 0.8;
        ctx.drawImage(mapImageObj, x, y, mapImageObj.width * scale, mapImageObj.height * scale);
        ctx.globalAlpha = 1.0;
    } else {
        // Fallback procedural background
        drawProceduralBackground();
    }
    
    // Apply transforms
    ctx.save();
    ctx.translate(settings.panX, settings.panY);
    ctx.scale(settings.zoom, settings.zoom);
    
    const context = getContext();
    const discoveredWps = settings.waypoints.filter(w => isDiscovered(w));
    const undiscoveredWps = settings.waypoints.filter(w => !isDiscovered(w));
    
    // Draw connections between discovered waypoints
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
    ctx.lineWidth = 2 / settings.zoom;
    ctx.setLineDash([5, 5]);
    
    for (let i = 0; i < discoveredWps.length - 1; i++) {
        const curr = discoveredWps[i];
        const next = discoveredWps.find(w => w.mesId > curr.mesId);
        if (next) {
            ctx.beginPath();
            ctx.moveTo(curr.x, curr.y);
            ctx.lineTo(next.x, next.y);
            ctx.stroke();
        }
    }
    ctx.setLineDash([]);
    
    // Draw undiscovered waypoints (faded/fogged)
    if (settings.showFogOfWar) {
        undiscoveredWps.forEach(wp => {
            // Only show hint if very close to discovery
            const dist = Math.abs(wp.mesId - settings.lastPosition);
            if (dist <= settings.discoveryRadius + 3) {
                ctx.beginPath();
                ctx.arc(wp.x, wp.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(100, 100, 100, 0.3)';
                ctx.fill();
            }
        });
    }
    
    // Draw discovered waypoints
    discoveredWps.forEach(wp => {
        // Outer glow
        const gradient = ctx.createRadialGradient(wp.x, wp.y, 0, wp.x, wp.y, 20);
        gradient.addColorStop(0, 'rgba(76, 175, 80, 0.3)');
        gradient.addColorStop(1, 'rgba(76, 175, 80, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, 20, 0, Math.PI * 2);
        ctx.fill();
        
        // Pin color based on biome
        const colors = {
            forest: '#228B22',
            mountain: '#8B4513',
            water: '#1E90FF',
            desert: '#FFA500',
            city: '#FFD700',
            plains: '#90EE90'
        };
        const color = colors[wp.biome] || '#4CAF50';
        
        // Draw pin
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = wp.mesId === settings.lastPosition ? '#fff' : '#333';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Current location indicator
        if (wp.mesId === settings.lastPosition) {
            ctx.beginPath();
            ctx.arc(wp.x, wp.y, 12, 0, Math.PI * 2);
            ctx.strokeStyle = '#ffeb3b';
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
    
    // Draw fog of war overlay (radial gradient from current position)
    if (settings.showFogOfWar && discoveredWps.length > 0) {
        const currentWp = discoveredWps.find(w => w.mesId === settings.lastPosition) || discoveredWps[discoveredWps.length - 1];
        
        // Create fog overlay
        const fogGradient = ctx.createRadialGradient(
            currentWp.x, currentWp.y, 50,
            currentWp.x, currentWp.y, 200
        );
        fogGradient.addColorStop(0, 'rgba(0,0,0,0)');
        fogGradient.addColorStop(1, 'rgba(0,0,10,0.6)');
        
        // This is a bit tricky with transform, so we do it in screen space
        ctx.restore();
        ctx.save();
        ctx.fillStyle = fogGradient;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
        ctx.save();
        ctx.translate(settings.panX, settings.panY);
        ctx.scale(settings.zoom, settings.zoom);
    }
    
    ctx.restore();
    
    // UI Overlay
    ctx.fillStyle = '#fff';
    ctx.font = '12px Arial';
    const status = `Discovered: ${discoveredWps.length} | Radius: ${settings.discoveryRadius}msg`;
    ctx.fillText(status, 10, 20);
}

function drawProceduralBackground() {
    // Simple noise/terrain generation based on waypoints
    const time = Date.now() * 0.0001;
    const width = canvas.width;
    const height = canvas.height;
    
    // Draw some "terrain" circles around waypoints
    settings.waypoints.forEach(wp => {
        if (!isDiscovered(wp)) return;
        
        const x = (wp.x * settings.zoom) + settings.panX;
        const y = (wp.y * settings.zoom) + settings.panY;
        
        // Biome colors
        const biomeColors = {
            forest: 'rgba(34, 139, 34, 0.1)',
            mountain: 'rgba(139, 69, 19, 0.1)',
            water: 'rgba(30, 144, 255, 0.1)',
            desert: 'rgba(255, 165, 0, 0.1)',
            city: 'rgba(255, 215, 0, 0.1)',
            plains: 'rgba(144, 238, 144, 0.1)'
        };
        
        ctx.fillStyle = biomeColors[wp.biome] || 'rgba(100,100,100,0.05)';
        ctx.beginPath();
        ctx.arc(x, y, 40 * settings.zoom, 0, Math.PI * 2);
        ctx.fill();
    });
}

// Settings panel
function showSettings() {
    const html = `
        <div style="text-align: left; padding: 10px;">
            <h3>Discovery Settings</h3>
            <label>Discovery Radius (messages): 
                <input type="number" id="ftm-radius" value="${settings.discoveryRadius}" min="1" max="50" style="width: 60px;">
            </label>
            <br><br>
            <label>
                <input type="checkbox" id="ftm-fog" ${settings.showFogOfWar ? 'checked' : ''}>
                Enable Fog of War (hide undiscovered)
            </label>
            
            <h3 style="margin-top: 20px;">AI Map Generation</h3>
            <label>
                <input type="checkbox" id="ftm-gen-enabled" ${settings.generationParams.enabled ? 'checked' : ''}>
                Enable Image Generation
            </label>
            <br><br>
            <label>Prompt Template:<br>
                <textarea id="ftm-prompt" rows="3" style="width: 100%;">${settings.generationParams.promptTemplate}</textarea>
            </label>
            <br><small>Use {locations} for discovered places list</small>
            <br><br>
            <label>Width: <input type="number" id="ftm-width" value="${settings.generationParams.width}" step="64"></label><br>
            <label>Height: <input type="number" id="ftm-height" value="${settings.generationParams.height}" step="64"></label>
            
            <br><br>
            <button id="ftm-reveal-all" style="background: #ff4444; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">
                Reveal All Locations (Cheat)
            </button>
        </div>
    `;
    
    callPopup(html, 'confirm', null, { 
        okButton: 'Save',
        cancelButton: 'Cancel'
    }).then(result => {
        if (result) {
            settings.discoveryRadius = parseInt(document.getElementById('ftm-radius').value);
            settings.showFogOfWar = document.getElementById('ftm-fm-fog').checked;
            settings.generationParams.enabled = document.getElementById('ftm-gen-enabled').checked;
            settings.generationParams.promptTemplate = document.getElementById('ftm-prompt').value;
            settings.generationParams.width = parseInt(document.getElementById('ftm-width').value);
            settings.generationParams.height = parseInt(document.getElementById('ftm-height').value);
            
            saveSettingsDebounced();
            renderMap();
        }
    });
    
    document.getElementById('ftm-reveal-all').onclick = () => {
        settings.waypoints.forEach(w => discoverWaypoint(w));
        renderMap();
        toastr.success('All locations revealed!');
    };
}

// ... (keep existing handleMouseDown, handleMouseMove, handleMouseUp, handleWheel from previous code)

function handleCanvasClick(e) {
    if (isDragging) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - settings.panX) / settings.zoom;
    const y = (e.clientY - rect.top - settings.panY) / settings.zoom;
    
    // Reverse iterate to click top items first
    for (let i = settings.waypoints.length - 1; i >= 0; i--) {
        const wp = settings.waypoints[i];
        if (!isDiscovered(wp)) continue; // Can't fast travel to undiscovered!
        
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

function fastTravel(waypoint) {
    const messageElement = document.querySelector(`.mes[mesid="${waypoint.mesId}"]`);
    if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Highlight effect
        const originalBg = messageElement.style.backgroundColor;
        messageElement.style.backgroundColor = 'rgba(76, 175, 80, 0.3)';
        messageElement.style.transition = 'background-color 0.5s';
        
        setTimeout(() => {
            messageElement.style.backgroundColor = originalBg;
        }, 2000);
        
        settings.lastPosition = waypoint.mesId;
        
        // Discover nearby when traveling
        settings.waypoints.forEach(wp => {
            if (Math.abs(wp.mesId - waypoint.mesId) <= settings.discoveryRadius) {
                discoverWaypoint(wp);
            }
        });
        
        renderMap();
        toastr.info(`Traveled to ${waypoint.name}`, 'Fast Travel');
    }
}

function updateDiscoveredCount() {
    const count = settings.discoveredIds.length;
    const total = settings.waypoints.length;
    const el = document.getElementById('ftm-discovered-count');
    if (el) el.textContent = `(${count}/${total} discovered)`;
}

// ... (keep createCustomWaypoint, clearWaypoints from previous code)

// Initialize
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
} else {
    initUI();
}

// Event hooks
const context = getContext();
context.eventSource.on(context.event_types.MESSAGE_RECEIVED, onMessageReceived);

// Chat change - clear or load specific waypoints
context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
    // You could load chat-specific waypoints here based on character name
    settings.waypoints = [];
    settings.discoveredIds = [];
    settings.lastPosition = 0;
    if (mapImageObj) {
        settings.mapImage = null;
        mapImageObj = null;
    }
    renderMap();
    updateDiscoveredCount();
});

console.log('[FastTravelMap] Discovery & AI Mode loaded');
