const APP_ID = sessionStorage.getItem('appId');
const TOKEN_RAW = sessionStorage.getItem('token');
const CHANNEL = sessionStorage.getItem('room');
let UID = sessionStorage.getItem('UID');
const NAME = sessionStorage.getItem('name') || 'Guest';

const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' });
const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
const REACTION_PREFIX = '__REACT__:';
const LINK_PREFIX = '__LINK__:';
const ACTIVITY_PREFIX = '__ACT__:';
const CHAT_POLL_MS = 2000;
const MAX_PLAY_RETRIES = 8;

let localAudioTrack = null;
let localCameraTrack = null;
let localScreenTrack = null;
let isScreenSharing = false;
let remoteUsers = {};
let chatPoller = null;
let lastMessageId = 0;
let pendingAudioTracks = [];

const token = TOKEN_RAW && TOKEN_RAW !== 'null' && TOKEN_RAW !== 'undefined' ? TOKEN_RAW : null;

const videoStreams = document.getElementById('video-streams');
const roomName = document.getElementById('room-name');
const participantCount = document.getElementById('participant-count');
const roomError = document.getElementById('room-error');
const audioUnlockButton = document.getElementById('audio-unlock-btn');
const chatPanel = document.getElementById('chat-panel');
const chatToggleButton = document.getElementById('chat-toggle-btn');
const reactionLayer = document.getElementById('reaction-layer');

const micButton = document.getElementById('mic-btn');
const cameraButton = document.getElementById('camera-btn');
const screenButton = document.getElementById('screen-btn');
const leaveButton = document.getElementById('leave-btn');
const chatForm = document.getElementById('chat-form');
const reactionButtons = document.querySelectorAll('.reaction-btn');
const shareTitleInput = document.getElementById('share-title');
const shareUrlInput = document.getElementById('share-url');
const shareLinkButton = document.getElementById('share-link-btn');
const coinFlipButton = document.getElementById('coin-flip-btn');
const diceRollButton = document.getElementById('dice-roll-btn');
const signatureCanvas = document.getElementById('signature-pad');
const signatureClearButton = document.getElementById('sig-clear-btn');
const signatureSaveButton = document.getElementById('sig-save-btn');
const signatureSendButton = document.getElementById('sig-send-btn');

let signatureCtx = null;
let signatureDrawing = false;

const setRoomError = (message) => {
    if (!roomError) return;
    roomError.textContent = message || '';
    roomError.style.display = message ? 'block' : 'none';
};

const setControlState = (button, isActive) => {
    if (!button) return;
    button.classList.toggle('is-muted', isActive);
    button.setAttribute('aria-pressed', String(isActive));
};

const setControlEnabled = (button, enabled) => {
    if (!button) return;
    button.disabled = !enabled;
};

const showAudioUnlock = (show) => {
    if (!audioUnlockButton) return;
    audioUnlockButton.style.display = show ? 'inline-flex' : 'none';
};

const queueAudioUnlock = (audioTrack) => {
    if (!audioTrack) return;
    if (!pendingAudioTracks.includes(audioTrack)) pendingAudioTracks.push(audioTrack);
    showAudioUnlock(true);
};

const tryUnlockAudio = async () => {
    if (!pendingAudioTracks.length) {
        showAudioUnlock(false);
        return;
    }

    const retries = [];
    for (let i = 0; i < pendingAudioTracks.length; i++) {
        try {
            await Promise.resolve(pendingAudioTracks[i].play());
        } catch (error) {
            retries.push(pendingAudioTracks[i]);
        }
    }
    pendingAudioTracks = retries;
    if (!pendingAudioTracks.length) showAudioUnlock(false);
};

const escapeHtml = (value) => {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const getVideoTrackLabel = (track) => {
    try {
        const mediaTrack = track.getMediaStreamTrack ? track.getMediaStreamTrack() : null;
        return (mediaTrack && mediaTrack.label ? mediaTrack.label : '').toLowerCase();
    } catch (error) {
        return '';
    }
};

const looksLikeScreenTrack = (track) => {
    const label = getVideoTrackLabel(track);
    return label.includes('screen') || label.includes('display') || label.includes('window');
};

const applyVideoHints = (playerId) => {
    const player = document.getElementById(playerId);
    if (!player) return;
    const video = player.querySelector('video');
    if (!video) return;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.autoplay = true;
    // Keep element muted for autoplay reliability; remote audio is handled by audioTrack.play().
    video.muted = true;
};

const getPlayerNode = (userUid) => document.getElementById(`user-${userUid}`);

const syncVideoLayout = () => {
    if (!videoStreams) return;
    const cards = videoStreams.querySelectorAll('.video-container');
    const count = cards.length;
    const hasScreen = !!videoStreams.querySelector('.video-container.is-screen');

    videoStreams.classList.remove('layout-1', 'layout-2', 'layout-couple', 'layout-many', 'layout-screen-share');
    if (hasScreen) {
        videoStreams.classList.add('layout-screen-share');
    } else if (count <= 1) {
        videoStreams.classList.add('layout-1');
    } else if (count === 2) {
        videoStreams.classList.add('layout-couple');
    } else if (count <= 4) {
        videoStreams.classList.add('layout-2');
    } else {
        videoStreams.classList.add('layout-many');
    }

    // Count local user + unique remote users for stable participant count.
    const remoteCount = Object.keys(remoteUsers).length;
    const localCount = UID ? 1 : 0;
    const computedCount = Math.max(count, remoteCount + localCount);
    if (participantCount) participantCount.textContent = `Participants: ${computedCount}`;
};

const ensureVideoContainer = (userUid, displayName, isLocal = false, isScreen = false) => {
    if (!videoStreams) return;
    const id = `user-container-${userUid}`;
    const existing = document.getElementById(id);
    if (existing) {
        existing.classList.toggle('local-user', isLocal);
        existing.classList.toggle('is-screen', isScreen);
        const nameNode = existing.querySelector('.username-wrapper');
        if (nameNode) {
            nameNode.textContent = `${displayName || 'Guest'}${isScreen ? ' · Screen' : ''}`;
        }
    } else {
        const html = `
            <article class="video-container ${isLocal ? 'local-user' : ''} ${isScreen ? 'is-screen' : ''}" id="${id}">
                <div class="video-player" id="user-${userUid}"></div>
                <div class="username-wrapper">${escapeHtml(displayName || 'Guest')}${isScreen ? ' · Screen' : ''}</div>
            </article>
        `;
        videoStreams.insertAdjacentHTML('beforeend', html);
    }
    syncVideoLayout();
};

const removeVideoContainer = (userUid) => {
    const card = document.getElementById(`user-container-${userUid}`);
    if (card) card.remove();
    syncVideoLayout();
};

const playVideoWithRetry = async (track, playerId, attempt = 0) => {
    if (!track) return;
    try {
        const playerNode = document.getElementById(playerId);
        if (!playerNode) throw new Error(`Missing player node ${playerId}`);
        await Promise.resolve(track.play(playerNode));
        await new Promise((resolve) => setTimeout(resolve, 120));
        applyVideoHints(playerId);
    } catch (error) {
        if (attempt >= MAX_PLAY_RETRIES) {
            console.error('Video play failed:', error);
            setRoomError('A participant video could not start. Trying again...');
            return;
        }
        setTimeout(() => {
            playVideoWithRetry(track, playerId, attempt + 1);
        }, 220 * (attempt + 1));
    }
};

const createMember = async () => {
    try {
        const response = await fetch('/create_member/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: NAME, room_name: CHANNEL, UID }),
        });
        if (!response.ok) return { name: NAME };
        return await response.json();
    } catch (error) {
        return { name: NAME };
    }
};

const getMember = async (user) => {
    try {
        const response = await fetch(`/get_member/?UID=${user.uid}&room_name=${CHANNEL}`);
        if (!response.ok) return { name: 'Guest' };
        return await response.json();
    } catch (error) {
        return { name: 'Guest' };
    }
};

const deleteMember = async () => {
    try {
        await fetch('/delete_member/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: NAME, room_name: CHANNEL, UID }),
        });
    } catch (error) {
        console.error('deleteMember failed:', error);
    }
};

const setupLocalTracks = async () => {
    const errors = [];
    try {
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: 'music_standard',
            AEC: true,
            AGC: true,
            ANS: true,
        });
    } catch (error) {
        errors.push('microphone');
    }

    try {
        localCameraTrack = await AgoraRTC.createCameraVideoTrack({
            encoderConfig: isMobile ? '360p_8' : '720p_1',
            optimizationMode: 'motion',
        });
    } catch (error) {
        errors.push('camera');
    }

    setControlEnabled(micButton, Boolean(localAudioTrack));
    setControlEnabled(cameraButton, Boolean(localCameraTrack));
    setControlEnabled(screenButton, Boolean(localCameraTrack));

    if (errors.length) setRoomError(`Missing ${errors.join(' and ')} permission.`);
};

const subscribeWithRetry = async (user, mediaType, attempt = 0) => {
    try {
        await client.subscribe(user, mediaType);
        return true;
    } catch (error) {
        if (attempt >= 3) return false;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        return subscribeWithRetry(user, mediaType, attempt + 1);
    }
};

const handleUserPublished = async (user, mediaType) => {
    remoteUsers[user.uid] = user;
    const subscribed = await subscribeWithRetry(user, mediaType);
    if (!subscribed) return;

    if (mediaType === 'video') {
        const isScreen = looksLikeScreenTrack(user.videoTrack);
        ensureVideoContainer(user.uid, `Participant ${user.uid}`, false, isScreen);
        await playVideoWithRetry(user.videoTrack, `user-${user.uid}`);
        const member = await getMember(user);
        ensureVideoContainer(user.uid, member.name, false, isScreen);
    }

    if (mediaType === 'audio') {
        try {
            await Promise.resolve(user.audioTrack.play());
        } catch (error) {
            queueAudioUnlock(user.audioTrack);
        }
    }
};

const handleUserUnpublished = (user, mediaType) => {
    if (mediaType === 'video') removeVideoContainer(user.uid);
};

const handleUserLeft = (user) => {
    delete remoteUsers[user.uid];
    removeVideoContainer(user.uid);
};

const publishCurrentTracks = async () => {
    const tracks = [localAudioTrack, isScreenSharing ? localScreenTrack : localCameraTrack].filter(Boolean);
    if (!tracks.length) return;
    await client.publish(tracks);
};

const joinAndDisplayLocalStream = async () => {
    if (!APP_ID || !CHANNEL || !UID) {
        setRoomError('Session expired. Join again.');
        window.open('/', '_self');
        return;
    }
    if (roomName) roomName.textContent = CHANNEL;

    client.on('user-published', handleUserPublished);
    client.on('user-unpublished', handleUserUnpublished);
    client.on('user-left', handleUserLeft);
    client.on('token-privilege-will-expire', () => setRoomError('Session expiring. Rejoin room soon.'));
    client.on('connection-state-change', (state) => {
        if (state === 'DISCONNECTED') setRoomError('Connection lost. Reconnecting...');
        if (state === 'CONNECTED') setRoomError('');
    });

    const normalizedUid = Number.isFinite(Number(UID)) ? Number(UID) : UID;
    try {
        UID = await client.join(APP_ID, CHANNEL, token, normalizedUid);
    } catch (error) {
        console.error('Join failed:', error);
        setRoomError('Unable to connect to room.');
        return;
    }

    await setupLocalTracks();
    if (!localAudioTrack && !localCameraTrack) {
        await client.leave();
        return;
    }

    const member = await createMember();
    ensureVideoContainer(UID, member.name || NAME, true, false);
    if (localCameraTrack) await playVideoWithRetry(localCameraTrack, `user-${UID}`);

    try {
        await publishCurrentTracks();
    } catch (error) {
        console.error('Publish failed:', error);
        setRoomError('Unable to publish stream.');
        return;
    }

    await fetchMessages(true);
    startChatPolling();
};

const toggleMic = async () => {
    if (!localAudioTrack) return;
    const muted = !localAudioTrack.muted;
    await localAudioTrack.setMuted(muted);
    setControlState(micButton, muted);
};

const toggleCamera = async () => {
    if (!localCameraTrack || isScreenSharing) return;
    const muted = !localCameraTrack.muted;
    await localCameraTrack.setMuted(muted);
    setControlState(cameraButton, muted);
};

const stopScreenShare = async (fromEndedEvent = false) => {
    if (!isScreenSharing || !localScreenTrack) return;
    try {
        await client.unpublish(localScreenTrack);
    } catch (error) {}
    localScreenTrack.stop();
    localScreenTrack.close();
    localScreenTrack = null;
    isScreenSharing = false;
    setControlState(screenButton, false);
    setControlEnabled(cameraButton, Boolean(localCameraTrack));

    ensureVideoContainer(UID, NAME, true, false);
    if (localCameraTrack) {
        await playVideoWithRetry(localCameraTrack, `user-${UID}`, true);
        await client.publish(localCameraTrack);
    }
    if (!fromEndedEvent) setRoomError('');
};

const startScreenShare = async () => {
    if (isScreenSharing || !localCameraTrack) return;
    try {
        localScreenTrack = await AgoraRTC.createScreenVideoTrack(
            { encoderConfig: '1080p_1', optimizationMode: 'detail' },
            'disable'
        );
    } catch (error) {
        setRoomError('Screen share blocked. Allow browser permission and retry.');
        return;
    }

    try {
        await client.unpublish(localCameraTrack);
        await client.publish(localScreenTrack);
    } catch (error) {
        setRoomError('Unable to start screen share.');
        localScreenTrack.close();
        localScreenTrack = null;
        return;
    }

    isScreenSharing = true;
    setControlState(screenButton, true);
    setControlEnabled(cameraButton, false);
    ensureVideoContainer(UID, NAME, true, true);
    await playVideoWithRetry(localScreenTrack, `user-${UID}`);

    localScreenTrack.on('track-ended', async () => {
        await stopScreenShare(true);
    });
};

const toggleScreenShare = async () => {
    if (isScreenSharing) {
        await stopScreenShare();
    } else {
        await startScreenShare();
    }
};

const showReactionBurst = (emoji) => {
    if (!reactionLayer) return;
    const node = document.createElement('span');
    node.className = 'reaction-burst';
    node.textContent = emoji;
    node.style.left = `${10 + Math.random() * 80}%`;
    node.style.animationDuration = `${2 + Math.random() * 1.6}s`;
    reactionLayer.appendChild(node);
    setTimeout(() => node.remove(), 3800);
};

const sendReaction = async (emoji) => {
    showReactionBurst(emoji);
    try {
        await fetch('/create_message/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: NAME,
                UID,
                room_name: CHANNEL,
                message: `${REACTION_PREFIX}${emoji}`,
            }),
        });
    } catch (error) {}
};

const sendActivityMessage = async (message) => {
    try {
        await fetch('/create_message/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: NAME, UID, room_name: CHANNEL, message }),
        });
    } catch (error) {}
};

const normalizeUrl = (value) => {
    const trimmed = (value || '').trim();
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const shareLink = async () => {
    const url = normalizeUrl(shareUrlInput ? shareUrlInput.value : '');
    if (!url) return;
    const title = (shareTitleInput && shareTitleInput.value.trim()) || 'Shared Link';
    await sendActivityMessage(`${LINK_PREFIX}${title}|${url}`);
    if (shareTitleInput) shareTitleInput.value = '';
    if (shareUrlInput) shareUrlInput.value = '';
};

const flipCoin = async () => {
    const result = Math.random() > 0.5 ? 'Heads' : 'Tails';
    await sendActivityMessage(`${ACTIVITY_PREFIX}Coin Flip: ${result}`);
};

const rollDice = async () => {
    const result = 1 + Math.floor(Math.random() * 6);
    await sendActivityMessage(`${ACTIVITY_PREFIX}Dice Roll: ${result}`);
};

const setupSignaturePad = () => {
    if (!signatureCanvas) return;
    signatureCtx = signatureCanvas.getContext('2d');
    if (!signatureCtx) return;
    signatureCtx.lineWidth = 2;
    signatureCtx.lineCap = 'round';
    signatureCtx.strokeStyle = '#e5e7eb';

    const getPos = (event) => {
        const rect = signatureCanvas.getBoundingClientRect();
        const source = event.touches ? event.touches[0] : event;
        return { x: source.clientX - rect.left, y: source.clientY - rect.top };
    };

    const start = (event) => {
        signatureDrawing = true;
        const p = getPos(event);
        signatureCtx.beginPath();
        signatureCtx.moveTo(p.x, p.y);
    };

    const move = (event) => {
        if (!signatureDrawing) return;
        event.preventDefault();
        const p = getPos(event);
        signatureCtx.lineTo(p.x, p.y);
        signatureCtx.stroke();
    };

    const stop = () => {
        signatureDrawing = false;
    };

    signatureCanvas.addEventListener('mousedown', start);
    signatureCanvas.addEventListener('mousemove', move);
    signatureCanvas.addEventListener('mouseup', stop);
    signatureCanvas.addEventListener('mouseleave', stop);
    signatureCanvas.addEventListener('touchstart', start, { passive: false });
    signatureCanvas.addEventListener('touchmove', move, { passive: false });
    signatureCanvas.addEventListener('touchend', stop);
};

const clearSignature = () => {
    if (!signatureCanvas || !signatureCtx) return;
    signatureCtx.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
};

const saveSignature = () => {
    if (!signatureCanvas) return;
    const link = document.createElement('a');
    link.href = signatureCanvas.toDataURL('image/png');
    link.download = `signature-${Date.now()}.png`;
    link.click();
};

const sendSignatureNote = async () => {
    await sendActivityMessage(`${ACTIVITY_PREFIX}Shared a signature ✍️`);
};

const toggleChatPanel = () => {
    if (!chatPanel) return;
    chatPanel.classList.toggle('is-open');
};

const formatChatTime = (unixTime) => {
    const date = new Date(unixTime * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const renderMessage = (message, isInitialFetch = false) => {
    const text = String(message.message || '');
    if (text.startsWith(REACTION_PREFIX)) {
        if (!isInitialFetch) showReactionBurst(text.replace(REACTION_PREFIX, '').trim() || '❤️');
        return;
    }

    const container = document.getElementById('chat-messages');
    if (!container) return;
    if (document.getElementById(`chat-msg-${message.id}`)) return;

    const isMine = String(message.uid) === String(UID);
    const node = document.createElement('article');
    node.className = `chat-message ${isMine ? 'is-mine' : ''}`.trim();
    node.id = `chat-msg-${message.id}`;
    let bodyHtml = `<p class="chat-text">${escapeHtml(text)}</p>`;
    if (text.startsWith(LINK_PREFIX)) {
        const payload = text.replace(LINK_PREFIX, '');
        const splitIndex = payload.indexOf('|');
        const title = splitIndex > -1 ? payload.slice(0, splitIndex) : 'Shared Link';
        const url = splitIndex > -1 ? payload.slice(splitIndex + 1) : payload;
        bodyHtml = `<p class="chat-text"><a class="shared-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></p>`;
    } else if (text.startsWith(ACTIVITY_PREFIX)) {
        const details = text.replace(ACTIVITY_PREFIX, '').trim();
        bodyHtml = `<p class="chat-text activity-note">${escapeHtml(details)}</p>`;
    }

    node.innerHTML = `
        <div class="chat-meta">
            <span class="chat-name">${escapeHtml(message.name)}</span>
            <span class="chat-time">${formatChatTime(message.created_at)}</span>
        </div>
        ${bodyHtml}
    `;
    container.appendChild(node);
    container.scrollTop = container.scrollHeight;
};

const fetchMessages = async (isInitial = false) => {
    try {
        const response = await fetch(`/get_messages/?room_name=${CHANNEL}&after_id=${lastMessageId}&limit=${isInitial ? 100 : 50}`);
        if (!response.ok) return;
        const payload = await response.json();
        const messages = payload.messages || [];
        for (let i = 0; i < messages.length; i++) {
            renderMessage(messages[i], isInitial);
            lastMessageId = Math.max(lastMessageId, messages[i].id || 0);
        }
    } catch (error) {}
};

const sendMessage = async (event) => {
    event.preventDefault();
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    try {
        const response = await fetch('/create_message/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: NAME, UID, room_name: CHANNEL, message: text }),
        });
        if (!response.ok) return;
        const saved = await response.json();
        renderMessage(saved, false);
        lastMessageId = Math.max(lastMessageId, saved.id || 0);
    } catch (error) {}
};

const startChatPolling = () => {
    if (chatPoller) return;
    chatPoller = setInterval(() => fetchMessages(false), CHAT_POLL_MS);
};

const leaveAndRemoveLocalStream = async () => {
    if (chatPoller) clearInterval(chatPoller);
    chatPoller = null;

    if (isScreenSharing) await stopScreenShare();

    const localTracks = [localAudioTrack, localCameraTrack].filter(Boolean);
    for (let i = 0; i < localTracks.length; i++) {
        localTracks[i].stop();
        localTracks[i].close();
    }

    try {
        await client.leave();
    } catch (error) {}

    await deleteMember();
    window.open('/', '_self');
};

window.addEventListener('beforeunload', deleteMember);
window.addEventListener('resize', syncVideoLayout);

if (audioUnlockButton) audioUnlockButton.addEventListener('click', tryUnlockAudio);
if (micButton) micButton.addEventListener('click', toggleMic);
if (cameraButton) cameraButton.addEventListener('click', toggleCamera);
if (screenButton) screenButton.addEventListener('click', toggleScreenShare);
if (leaveButton) leaveButton.addEventListener('click', leaveAndRemoveLocalStream);
if (chatForm) chatForm.addEventListener('submit', sendMessage);
if (chatToggleButton) chatToggleButton.addEventListener('click', toggleChatPanel);
reactionButtons.forEach((btn) => btn.addEventListener('click', () => sendReaction(btn.dataset.emoji || '❤️')));
if (shareLinkButton) shareLinkButton.addEventListener('click', shareLink);
if (coinFlipButton) coinFlipButton.addEventListener('click', flipCoin);
if (diceRollButton) diceRollButton.addEventListener('click', rollDice);
if (signatureClearButton) signatureClearButton.addEventListener('click', clearSignature);
if (signatureSaveButton) signatureSaveButton.addEventListener('click', saveSignature);
if (signatureSendButton) signatureSendButton.addEventListener('click', sendSignatureNote);

showAudioUnlock(false);
setupSignaturePad();
joinAndDisplayLocalStream();
