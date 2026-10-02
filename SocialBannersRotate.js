/**
 * Social Banner Rotator - Controller Logic
 *
 * Purpose: Manages banner queue sequences, custom legibility card wrappers,
 * CSS dynamic parameter injects, and cross-platform instant chat command triggers.
 *
 * Architectural Features:
 * - Dynamic split timing speeds implemented (Intro & Outro have independent configuration) .
 * - Supports granular override ranks: Broadcaster, Moderator, VIP, or Everyone.
 * - Customizable inter-banner delay gap configuration implemented.
 * - Centralized multi-platform message parser (`processIncomingMessage`).
 * - Full direct WebSocket connection (Pusher 8.4.0 protocols) to stream chat directly from Kick.
 * - Whitelisting and role evaluation works on both Twitch and Kick streams seamlessly.
 */

let fieldData; // StreamElements configuration reference
let kickWs = null; // Socket connection tracker

// Global Timing Configuration State
const WidgetState = {
    images: [],             // Clean chronological list of generated or uploaded banner records
    activeQueue: [],        // Copy of banners currently running (useful for dynamic shuffle)
    currentIndex: 0,
    currentTimeoutId: null, // Primary sequence tracking handle

    // Config values fetched on Widget load
    displayDurationMs: 5000,
    animInDurationMs: 1000,
    animOutDurationMs: 1000,
    interBannerGapMs: 500,
    pauseDurationMs: 60000,
    randomizeOrder: false,
    imageFit: 'contain',
    animInClass: 'slideInLeft',
    animOutClass: 'slideOutRight',
    chatCommand: '!socials',
    commandPermission: 'broadcaster+mod', // Default fallback setting
    activationMode: 'both',
    bannerTheme: 'midnightGlass',
    showPlatformLogos: true,
    previewMode: false
};

// Platform metadata is kept in code so generated banners need no external artwork.
// Simple Icons supplies compact SVGs; a readable initial remains if its CDN is unavailable.
const SocialPlatforms = [
    { key: 'twitch', label: 'Twitch', color: '#9146FF', rgb: '145,70,255', icon: 'twitch' },
    { key: 'discord', label: 'Discord', color: '#5865F2', rgb: '88,101,242', icon: 'discord' },
    { key: 'youtube', label: 'YouTube', color: '#FF0033', rgb: '255,0,51', icon: 'youtube' },
    { key: 'twitter', label: 'X / Twitter', color: '#1D9BF0', rgb: '29,155,240', icon: 'x' },
    { key: 'kick', label: 'Kick', color: '#53FC18', rgb: '83,252,24', icon: 'kick' },
    { key: 'tiktok', label: 'TikTok', color: '#FE2C55', rgb: '254,44,85', icon: 'tiktok' },
    { key: 'patreon', label: 'Patreon', color: '#FF424D', rgb: '255,66,77', icon: 'patreon' },
    { key: 'instagram', label: 'Instagram', color: '#D62976', rgb: '214,41,118', icon: 'instagram' },
    { key: 'bluesky', label: 'Bluesky', color: '#1185FE', rgb: '17,133,254', icon: 'bluesky' }
];

// --- Core Helper Functions & Resolvers ---

/**
 * Attempts to automatically resolve a Kick channel name into a numerical Chatroom ID via API.
 * Contains safeguards against Cloudflare blocks when run from browser sources.
 *
 * @param {string} input - The user's input (can be "username" or "1234567").
 * @returns {Promise<string|null>} - The numerical ID as a string, or null if failed.
 */
async function resolveKickChatroomId(input) {
    const cleanInput = input.trim();

    // If it's already a clean number, skip the API call.
    if (/^\d+$/.test(cleanInput)) {
        console.log(`[Social Rotator] Kick ID Input "${cleanInput}" is purely numeric. Bypassing API fetch.`);
        return cleanInput;
    }

    console.log(`[Social Rotator] Kick Input "${cleanInput}" appears to be a username. Attempting to fetch Chatroom ID via Kick API...`);

    try {
        const response = await fetch(`https://kick.com/api/v2/channels/${cleanInput}`);
        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}: API denied the request.`);
        }
        const data = await response.json();

        if (data && data.chatroom && data.chatroom.id) {
            const fetchedId = data.chatroom.id.toString();
            console.log(`[Social Rotator] SUCCESS: Resolved Kick username "${cleanInput}" to Chatroom ID: ${fetchedId}`);
            return fetchedId;
        } else {
            throw new Error("Invalid Kick API response structure.");
        }
    } catch (error) {
        console.error(`[Social Rotator] FAILED to auto-resolve Kick username "${cleanInput}".`, error);
        console.warn(`[Social Rotator] CRITICAL: StreamElements/OBS might be blocked by Cloudflare from making this API request. Please manually enter your numeric Kick Chatroom ID in the widget settings.`);
        return null;
    }
}

/**
 * Connects directly to Kick's Chat WebSocket (Pusher) without needing third-party bots.
 * Normalizes incoming Kick messages to perfectly match the StreamElements data structure,
 * allowing the existing command logic to process them flawlessly.
 *
 * @param {string} chatroomId - The channel's resolved Kick Chatroom ID.
 */
function connectKickChat(chatroomId) {
    if (!chatroomId) return;

    // Modern Kick public Pusher App Key
    const kickPusherKey = "32cbd69e4b950bf97679";
    const wsUrl = `wss://ws-us2.pusher.com/app/${kickPusherKey}?protocol=7&client=js&version=8.4.0&flash=false`;

    console.log(`[Social Rotator] Initializing WebSocket connection to Kick: ${wsUrl}`);
    kickWs = new WebSocket(wsUrl);

    kickWs.onopen = () => {
        console.log(`[Social Rotator] Kick WebSocket handshake initiated.`);
    };

    kickWs.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            const eventType = payload.event || "";

            // Pusher Heartbeats
            if (eventType === "pusher:ping") {
                if (kickWs.readyState === WebSocket.OPEN) {
                    kickWs.send(JSON.stringify({ event: "pusher:pong", data: {} }));
                }
                return;
            }

            // Subscriptions Setup
            if (eventType === "pusher:connection_established") {
                console.log(`[Social Rotator] Kick Pusher handshake complete. Subscribing to channel: chatrooms.${chatroomId}.v2`);
                kickWs.send(JSON.stringify({
                    event: "pusher:subscribe",
                    data: { auth: "", channel: `chatrooms.${chatroomId}.v2` }
                }));
                return;
            }

            if (eventType === "pusher_internal:subscription_succeeded") {
                console.log(`[Social Rotator] SUCCESS: Subscribed to Kick chat stream. Native Cross-Platform Chat is active!`);
                return;
            }

            // Message Processing
            if (eventType.includes("ChatMessage") || eventType.includes("Message")) {
                let innerData = payload.data;

                // Unpack double-stringified payloads
                if (typeof innerData === 'string') {
                    try {
                        innerData = JSON.parse(innerData);
                    } catch (e) {
                        return; // Ignore invalid payload
                    }
                }

                if (innerData.aiModerated === true) return;

                let content = "";
                let senderName = "";
                let senderId = "";
                let badgesArray = [];

                const msgBlock = innerData.message;
                if (msgBlock && msgBlock.sender) {
                    content = msgBlock.content || msgBlock.message || innerData.content;
                    senderName = msgBlock.sender.username;
                    senderId = (msgBlock.sender.id || "").toString();
                    if (msgBlock.sender.identity && msgBlock.sender.identity.badges) {
                        badgesArray = msgBlock.sender.identity.badges;
                    }
                } else {
                    content = innerData.content || innerData.message;
                    const senderBlock = innerData.sender || {};
                    senderName = senderBlock.username;
                    senderId = (senderBlock.id || "").toString();
                    if (senderBlock.identity && senderBlock.identity.badges) {
                        badgesArray = senderBlock.identity.badges;
                    }
                }

                if (!content || !senderName) return;

                // Normalize data model to replicate SE Twitch structure
                const normalizedData = {
                    text: content,
                    userId: senderId,
                    nick: senderName,
                    displayName: senderName,
                    tags: {},
                    badges: []
                };

                // Translate Kick badges to corresponding roles
                badgesArray.forEach(badge => {
                    if (badge.type === 'broadcaster' || badge.type === 'creator') {
                        normalizedData.badges.push({ type: 'broadcaster' });
                    }
                    if (badge.type === 'moderator') {
                        normalizedData.badges.push({ type: 'moderator' });
                    }
                    if (badge.type === 'vip') {
                        normalizedData.badges.push({ type: 'vip' });
                    }
                });

                processIncomingMessage(normalizedData);
            }
        } catch (error) {
            console.error("[Social Rotator] Failed to parse Kick websocket message:", error);
        }
    };

    kickWs.onclose = () => {
        console.warn("[Social Rotator] Kick WebSocket disconnected. Attempting to reconnect in 6 seconds...");
        setTimeout(() => connectKickChat(chatroomId), 6000);
    };

    kickWs.onerror = (err) => {
        console.error("[Social Rotator] Kick WebSocket encountered an error:", err);
    };
}

/**
 * Triggered by StreamElements when the widget initializes.
 * Populates options, sets global CSS variables, and launches the runtime sequence.
 */
window.addEventListener('onWidgetLoad', async function (obj) {
    try {
        fieldData = obj.detail.fieldData;

        // --- Initiate Native Kick Connection ---
        if (fieldData.kickChatroomId && fieldData.kickChatroomId.trim() !== '') {
            const resolvedId = await resolveKickChatroomId(fieldData.kickChatroomId);
            if (resolvedId) {
                connectKickChat(resolvedId);
            }
        } else {
            console.warn("[Social Rotator] No Kick ID/Username provided in settings. Kick chat integration disabled.");
        }

        // Parse Core Timing Parameters (Seconds to Milliseconds conversion)
        WidgetState.displayDurationMs = (fieldData.displayDuration || 5) * 1000;
        WidgetState.pauseDurationMs = (fieldData.pauseDuration || 60) * 1000;
        WidgetState.interBannerGapMs = (fieldData.interBannerGap !== undefined ? parseFloat(fieldData.interBannerGap) : 0.5) * 1000;

        // Parse Split Animation Speeds
        WidgetState.animInDurationMs = (fieldData.animInDuration !== undefined ? parseFloat(fieldData.animInDuration) : 1.0) * 1000;
        WidgetState.animOutDurationMs = (fieldData.animOutDuration !== undefined ? parseFloat(fieldData.animOutDuration) : 1.0) * 1000;

        WidgetState.randomizeOrder = fieldData.randomizeOrder === true;
        WidgetState.activationMode = fieldData.activationMode || 'both';
        WidgetState.bannerTheme = fieldData.bannerTheme || 'midnightGlass';
        WidgetState.showPlatformLogos = fieldData.showPlatformLogos !== false;

        const width = Math.max(360, Math.min(1200, Number(fieldData.bannerWidth) || 760));
        const height = Math.max(110, Math.min(400, Number(fieldData.bannerHeight) || 178));
        document.documentElement.style.setProperty('--banner-width', `${width}px`);
        document.documentElement.style.setProperty('--banner-height', `${height}px`);

        // Visual Fit & Image Settings
        WidgetState.imageFit = fieldData.imageFit || 'contain';
        document.documentElement.style.setProperty('--image-fit', WidgetState.imageFit);

        // Parse Animations and Chat Rules
        WidgetState.animInClass = fieldData.animIn || 'slideInLeft';
        WidgetState.animOutClass = fieldData.animOut || 'slideOutRight';
        WidgetState.chatCommand = (fieldData.chatCommand || '').trim().toLowerCase();
        WidgetState.commandPermission = fieldData.commandPermission || 'broadcaster+mod';

        // Parse Graphic Transparency Shadows
        if (fieldData.enableShadow === true) {
            const color = fieldData.shadowColor || 'rgba(0, 0, 0, 0.5)';
            const blur = fieldData.shadowBlur !== undefined ? fieldData.shadowBlur : 15;
            const offsetX = fieldData.shadowOffsetX !== undefined ? fieldData.shadowOffsetX : 0;
            const offsetY = fieldData.shadowOffsetY !== undefined ? fieldData.shadowOffsetY : 8;

            const filterStr = `drop-shadow(${offsetX}px ${offsetY}px ${blur}px ${color})`;
            document.documentElement.style.setProperty('--shadow-filter', filterStr);
        } else {
            document.documentElement.style.setProperty('--shadow-filter', 'none');
        }

        // Parse and configure dynamic Legibility Backing Panel options
        if (fieldData.enableBackingCard === true) {
            const backingColor = fieldData.backingColor || 'rgba(0, 0, 0, 0.4)';
            const radius = fieldData.backingBorderRadius !== undefined ? fieldData.backingBorderRadius : 15;
            const padding = fieldData.backingPadding !== undefined ? fieldData.backingPadding : 20;
            const glowColor = fieldData.backingGlowColor || 'rgba(0, 0, 0, 0.2)';
            const glowBlur = fieldData.backingGlowBlur !== undefined ? fieldData.backingGlowBlur : 30;

            document.documentElement.style.setProperty('--backing-color', backingColor);
            document.documentElement.style.setProperty('--backing-radius', `${radius}px`);
            document.documentElement.style.setProperty('--backing-padding', `${padding}px`);
            document.documentElement.style.setProperty('--backing-shadow', `0 0 ${glowBlur}px ${glowColor}`);
        } else {
            document.documentElement.style.setProperty('--backing-color', 'transparent');
            document.documentElement.style.setProperty('--backing-radius', '0px');
            document.documentElement.style.setProperty('--backing-padding', '0px');
            document.documentElement.style.setProperty('--backing-shadow', 'none');
        }

        // Build either an uploaded-art queue or a generated social-profile queue.
        WidgetState.images = [];
        if (WidgetState.bannerTheme === 'uploaded') {
            for (let i = 1; i <= 12; i++) {
                const imgUrl = fieldData[`image${i}`];
                if (imgUrl && typeof imgUrl === 'string' && imgUrl.trim() !== '') {
                    WidgetState.images.push({ type: 'image', url: imgUrl.trim(), label: `Social banner ${i}` });
                }
            }
        } else {
            SocialPlatforms.forEach(platform => {
                const handle = String(fieldData[`${platform.key}Handle`] || '').trim();
                if (handle) WidgetState.images.push({ type: 'generated', handle, platform });
            });
        }

        console.log(`[Social Rotator] Initialization success. Detected ${WidgetState.images.length} banners.`);

        if (WidgetState.images.length > 0 && WidgetState.activationMode !== 'command') {
            startSequence();
        } else {
            console.log('[Social Rotator] Waiting for a command/preview, or for banner content to be configured.');
        }

    } catch (err) {
        console.error('[Social Rotator] Fatal initialization error:', err);
    }
});

/**
 * Checks if the message sender holds the required permission level.
 * Robustly parses badges array and fallback Twitch tags.
 *
 * @param {Object} eventData - StreamElements event data payload.
 * @returns {boolean} - True if user meets the rank requirements, false otherwise.
 */
function checkUserPermission(eventData) {
    if (!eventData) return false;

    const permissionSetting = WidgetState.commandPermission;
    if (permissionSetting === 'everyone') {
        return true;
    }

    const badges = eventData.badges || [];
    const badgeTypes = Array.isArray(badges) ? badges.map(b => (b && typeof b === 'object') ? b.type : b) : [];

    // Extrapolate fallback tags in case browser rendering skips standard formatting
    const tags = eventData.tags || {};
    const rawBadgesStr = tags.badges || '';

    // Verify Rank States
    const isBroadcaster = badgeTypes.includes('broadcaster') ||
                          tags.broadcaster === '1' ||
                          rawBadgesStr.includes('broadcaster');

    const isModerator = badgeTypes.includes('moderator') ||
                        tags.mod === '1' ||
                        rawBadgesStr.includes('moderator');

    const isVip = badgeTypes.includes('vip') ||
                  tags.vip === '1' ||
                  rawBadgesStr.includes('vip');

    // Permission Evaluation Hierarchy
    if (permissionSetting === 'broadcaster+mod+vip') {
        return isBroadcaster || isModerator || isVip;
    }
    if (permissionSetting === 'broadcaster+mod') {
        return isBroadcaster || isModerator;
    }
    if (permissionSetting === 'broadcaster') {
        return isBroadcaster;
    }

    return false;
}

/**
 * Unified evaluator for message events across all integrated stream chats (Twitch, Kick, YouTube).
 * Checks triggers and permissions to decide whether to override current state.
 *
 * @param {Object} eventData - Normalized messaging details.
 */
function processIncomingMessage(eventData) {
    if (!WidgetState.chatCommand || WidgetState.activationMode === 'auto') return; // Command disabled

    const userMessage = (eventData.text || '').trim().toLowerCase();

    if (userMessage === WidgetState.chatCommand) {
        // Assert user command rank clearance
        if (checkUserPermission(eventData)) {
            console.log(`[Social Rotator] Chat override validated for user: ${eventData.displayName || eventData.nick}`);
            triggerOverrideSequence();
        } else {
            console.log(`[Social Rotator] Override bypassed: User '${eventData.displayName || eventData.nick}' lacks command clearance.`);
        }
    }
}

/**
 * Triggered by StreamElements on events (e.g. Twitch/YouTube Chat Messages).
 */
window.addEventListener('onEventReceived', function (obj) {
    try {
        const listener = obj.detail.listener;
        if (listener === 'message') {
            processIncomingMessage(obj.detail.event.data);
        } else if (listener === 'widget-button') {
            const buttonName = obj.detail.event && (obj.detail.event.field || obj.detail.event.name);
            if (buttonName === 'previewNext') previewNextBanner();
        }
    } catch (err) {
        console.error('[Social Rotator] Event process error:', err);
    }
});

/**
 * Shuffles clean arrays to randomize chronological delivery on each rotation.
 * Keeps original arrays un-mutated.
 */
function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
    }
    return arr;
}

/**
 * Instantly shuts down runtime sequences, cancels timeouts, and rebuilds
 * the rotation loop starting from index 0.
 */
function triggerOverrideSequence() {
    if (WidgetState.images.length === 0) return;

    if (WidgetState.currentTimeoutId) clearTimeout(WidgetState.currentTimeoutId);

    const wrapperEl = document.getElementById('banner-wrapper');
    const imgEl = document.getElementById('banner-image');

    // Instantly hide and clear animations to prevent overlapping
    wrapperEl.style.display = 'none';
    wrapperEl.className = '';
    imgEl.src = '';

    // Reset loop index and start instantly
    startSequence();
}

/** Shows exactly one subsequent banner from the editor's Preview Next button. */
function previewNextBanner() {
    if (!WidgetState.images.length) return;
    if (WidgetState.currentTimeoutId) clearTimeout(WidgetState.currentTimeoutId);
    if (!WidgetState.activeQueue.length) WidgetState.activeQueue = [...WidgetState.images];
    else WidgetState.currentIndex = (WidgetState.currentIndex + 1) % WidgetState.activeQueue.length;
    WidgetState.previewMode = true;
    showBanner();
}

/**
 * Begins loop sequence. Prepares arrays (handling randomize states).
 */
function startSequence() {
    WidgetState.previewMode = false;
    WidgetState.currentIndex = 0;

    if (WidgetState.randomizeOrder) {
        WidgetState.activeQueue = shuffleArray(WidgetState.images);
    } else {
        WidgetState.activeQueue = [...WidgetState.images];
    }

    showBanner();
}

/**
 * Inserts the asset source, resets wrapper layout frames,
 * runs the entry animation, and transitions to scheduled exit timing.
 */
function showBanner() {
    const wrapperEl = document.getElementById('banner-wrapper');
    const imgEl = document.getElementById('banner-image');
    const activeBanner = WidgetState.activeQueue[WidgetState.currentIndex];
    const generatedEl = document.getElementById('generated-banner');
    const logoShellEl = document.getElementById('platform-logo-shell');
    const logoEl = document.getElementById('platform-logo');
    const fallbackEl = document.getElementById('platform-logo-fallback');

    // Inject either uploaded artwork or a responsive generated platform card.
    if (activeBanner.type === 'image') {
        generatedEl.style.display = 'none';
        imgEl.style.display = 'block';
        imgEl.src = activeBanner.url;
        imgEl.alt = activeBanner.label;
    } else {
        const platform = activeBanner.platform;
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');
        generatedEl.style.display = 'grid';
        wrapperEl.className = `theme-${WidgetState.bannerTheme}`;
        wrapperEl.style.setProperty('--platform-color', platform.color);
        wrapperEl.style.setProperty('--platform-color-rgb', platform.rgb);
        document.getElementById('platform-label').textContent = platform.label;
        const handleEl = document.getElementById('social-handle');
        handleEl.textContent = activeBanner.handle;
        // Length-aware ceiling keeps typical handles on one line and reserves wrapping
        // for genuinely long labels, without making short names look undersized.
        const handleLength = Array.from(activeBanner.handle).length;
        const fittedSize = handleLength > 36 ? 24 : handleLength > 28 ? 29 : handleLength > 20 ? 36 : 46;
        handleEl.style.fontSize = `clamp(22px, 5.2vw, ${fittedSize}px)`;
        logoShellEl.style.display = WidgetState.showPlatformLogos ? 'grid' : 'none';
        fallbackEl.textContent = platform.label.charAt(0);
        fallbackEl.style.display = 'none';
        logoEl.style.display = 'block';
        logoEl.src = `https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/${platform.icon}.svg`;
        logoEl.onerror = () => { logoEl.style.display = 'none'; fallbackEl.style.display = 'block'; };
    }

    // Show wrapper wrapper (using inline-block so it wraps visual dimensions tightly)
    wrapperEl.style.display = 'inline-block';

    // Clear animations & trigger repaint to force recalculation of keyframes
    wrapperEl.classList.remove('animated', WidgetState.animInClass, WidgetState.animOutClass);
    void wrapperEl.offsetWidth;

    // Inject unique Intro Speed directly into styling properties [1]
    wrapperEl.style.setProperty('--animation-duration', `${WidgetState.animInDurationMs / 1000}s`);

    // Apply the entry animation classes to wrapper so backing card animates along
    wrapperEl.classList.add('animated', WidgetState.animInClass);

    // Schedule exit transition: Intro Animation duration + user-defined display delay
    const totalDisplayDelayMs = WidgetState.animInDurationMs + WidgetState.displayDurationMs;

    WidgetState.currentTimeoutId = setTimeout(() => {
        hideBanner();
    }, totalDisplayDelayMs);
}

/**
 * Runs exit transformations and queues up either the next banner element
 * or initiates the cycle-wide cooldown pause.
 */
function hideBanner() {
    const wrapperEl = document.getElementById('banner-wrapper');

    // Reset standard and apply the defined exit class to wrapper
    wrapperEl.classList.remove('animated', WidgetState.animInClass, WidgetState.animOutClass);
    void wrapperEl.offsetWidth;

    // Inject unique Outro Speed directly into styling properties [1]
    wrapperEl.style.setProperty('--animation-duration', `${WidgetState.animOutDurationMs / 1000}s`);

    // Apply outro animation classes to the wrapper
    wrapperEl.classList.add('animated', WidgetState.animOutClass);

    // Wait for exit animation completion
    WidgetState.currentTimeoutId = setTimeout(() => {

        wrapperEl.style.display = 'none';
        if (WidgetState.previewMode) {
            WidgetState.currentTimeoutId = null;
            return;
        }
        WidgetState.currentIndex++;

        if (WidgetState.currentIndex < WidgetState.activeQueue.length) {
            // Queue next banner sequence using custom adjustable delay configuration
            WidgetState.currentTimeoutId = setTimeout(() => {
                showBanner();
            }, WidgetState.interBannerGapMs);
        } else {
            // Command-only mode displays one complete rotation and then stays hidden.
            if (WidgetState.activationMode === 'command') {
                WidgetState.currentTimeoutId = null;
                console.log('[Social Rotator] Command-triggered cycle complete. Waiting for the next command.');
                return;
            }

            // Completed rotation loop. Start cooldown duration before next full cycle.
            console.log(`[Social Rotator] Completed cycle. Resting for ${WidgetState.pauseDurationMs / 1000}s...`);
            WidgetState.currentTimeoutId = setTimeout(() => {
                startSequence();
            }, WidgetState.pauseDurationMs);
        }

    }, WidgetState.animOutDurationMs);
}
