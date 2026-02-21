const APP_ID = sessionStorage.getItem('appId');
const TOKEN = sessionStorage.getItem('token');
const CHANNEL = sessionStorage.getItem('room');
let UID = sessionStorage.getItem('UID');
const NAME = sessionStorage.getItem('name') || 'Guest';

const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' });

let localTracks = [];
let localAudioTrack = null;
let localVideoTrack = null;
let remoteUsers = {};
let chatPoller = null;
let lastMessageId = 0;
let pendingAudioTracks = [];

const CHAT_POLL_MS = 2000;
const MAX_PLAY_RETRIES = 8;

const videoStreams = document.getElementById('video-streams');
const roomName = document.getElementById('room-name');
const participantCount = document.getElementById('participant-count');
const roomError = document.getElementById('room-error');
const audioUnlockButton = document.getElementById('audio-unlock-btn');
const chatPanel = document.getElementById('chat-panel');
const chatToggleButton = document.getElementById('chat-toggle-btn');

const micButton = document.getElementById('mic-btn');
const cameraButton = document.getElementById('camera-btn');
const leaveButton = document.getElementById('leave-btn');
const chatForm = document.getElementById('chat-form');

const setRoomError = (message) => {
    if (!roomError) return;
    roomError.textContent = message || '';
    roomError.style.display = message ? 'block' : 'none';
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
    if (!pendingAudioTracks.length) {
        showAudioUnlock(false);
    }
};

const syncVideoLayout = () => {
    if (!videoStreams) return;
    const count = videoStreams.querySelectorAll('.video-container').length;
    videoStreams.classList.remove('layout-1', 'layout-2', 'layout-4', 'layout-many');

    if (count <= 1) videoStreams.classList.add('layout-1');
    else if (count === 2) videoStreams.classList.add('layout-2');
    else if (count <= 4) videoStreams.classList.add('layout-4');
    else videoStreams.classList.add('layout-many');
};

const updateParticipantCount = () => {
    if (!participantCount) return;
    const count = videoStreams ? videoStreams.querySelectorAll('.video-container').length : 0;
    participantCount.textContent = `Participants: ${count}`;
};

const setControlEnabled = (button, enabled) => {
    if (!button) return;
    button.disabled = !enabled;
};

const setControlState = (button, isMuted) => {
    if (!button) return;
    button.classList.toggle('is-muted', isMuted);
    button.setAttribute('aria-pressed', String(isMuted));
};

const applyVideoElementHints = (playerId, muted = false) => {
    const player = document.getElementById(playerId);
    if (!player) return;
    const video = player.querySelector('video');
    if (!video) return;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.autoplay = true;
    video.muted = muted;
};

const escapeHtml = (value) => {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const ensureVideoContainer = (userUid, displayName) => {
    if (!videoStreams) return;
    const existing = document.getElementById(`user-container-${userUid}`);
    if (existing) existing.remove();

    const card = `
        <article class="video-container" id="user-container-${userUid}">
            <div class="video-player" id="user-${userUid}"></div>
            <div class="username-wrapper">${escapeHtml(displayName || 'Guest')}</div>
        </article>
    `;
    videoStreams.insertAdjacentHTML('beforeend', card);
    syncVideoLayout();
    updateParticipantCount();
};

const removeVideoContainer = (userUid) => {
    const node = document.getElementById(`user-container-${userUid}`);
    if (node) node.remove();
    syncVideoLayout();
    updateParticipantCount();
};

const playRemoteVideoWithRetry = async (user, playerId, attempt = 0) => {
    if (!user || !user.videoTrack) return;
    try {
        await Promise.resolve(user.videoTrack.play(playerId));
        await new Promise((resolve) => setTimeout(resolve, 120));
        applyVideoElementHints(playerId, false);
    } catch (error) {
        if (attempt >= MAX_PLAY_RETRIES) {
            console.error('Remote video play failed:', error);
            return;
        }
        setTimeout(() => {
            playRemoteVideoWithRetry(user, playerId, attempt + 1);
        }, 200 * (attempt + 1));
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
    const setupErrors = [];

    try {
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: 'music_standard',
            AEC: true,
            AGC: true,
            ANS: true,
        });
    } catch (error) {
        setupErrors.push('microphone');
        console.error('Microphone unavailable:', error);
    }

    try {
        localVideoTrack = await AgoraRTC.createCameraVideoTrack({
            encoderConfig: isMobile ? '360p_8' : '480p_2',
            optimizationMode: 'motion',
        });
    } catch (error) {
        setupErrors.push('camera');
        console.error('Camera unavailable:', error);
    }

    localTracks = [localAudioTrack, localVideoTrack].filter(Boolean);
    setControlEnabled(micButton, Boolean(localAudioTrack));
    setControlEnabled(cameraButton, Boolean(localVideoTrack));
    setControlState(micButton, false);
    setControlState(cameraButton, false);

    if (setupErrors.length) {
        setRoomError(`Missing ${setupErrors.join(' and ')} permission. Join again after allowing access.`);
    }
};

const handleUserPublished = async (user, mediaType) => {
    remoteUsers[user.uid] = user;
    try {
        await client.subscribe(user, mediaType);
    } catch (error) {
        console.error('Subscribe failed:', error);
        return;
    }

    if (mediaType === 'video') {
        const member = await getMember(user);
        ensureVideoContainer(user.uid, member.name);
        await playRemoteVideoWithRetry(user, `user-${user.uid}`);
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

const joinAndDisplayLocalStream = async () => {
    if (!APP_ID || !TOKEN || !CHANNEL || !UID) {
        setRoomError('Session expired. Join again.');
        window.open('/', '_self');
        return;
    }

    if (roomName) roomName.textContent = CHANNEL;

    client.on('user-published', handleUserPublished);
    client.on('user-unpublished', handleUserUnpublished);
    client.on('user-left', handleUserLeft);
    client.on('connection-state-change', (state) => {
        if (state === 'DISCONNECTED') setRoomError('Connection lost. Reconnecting...');
        if (state === 'CONNECTED') setRoomError('');
    });

    try {
        UID = await client.join(APP_ID, CHANNEL, TOKEN, UID);
    } catch (error) {
        console.error('Join failed:', error);
        setRoomError('Unable to connect to call.');
        return;
    }

    await setupLocalTracks();
    if (!localTracks.length) {
        await client.leave();
        return;
    }

    const member = await createMember();
    ensureVideoContainer(UID, member.name || NAME);

    if (localVideoTrack) {
        await Promise.resolve(localVideoTrack.play(`user-${UID}`));
        applyVideoElementHints(`user-${UID}`, true);
    }

    try {
        await client.publish(localTracks);
    } catch (error) {
        console.error('Publish failed:', error);
        setRoomError('Unable to publish stream.');
        return;
    }

    await fetchMessages(true);
    startChatPolling();
};

const leaveAndRemoveLocalStream = async () => {
    if (chatPoller) {
        clearInterval(chatPoller);
        chatPoller = null;
    }

    for (let i = 0; i < localTracks.length; i++) {
        localTracks[i].stop();
        localTracks[i].close();
    }

    try {
        await client.leave();
    } catch (error) {
        console.error('Leave failed:', error);
    }

    await deleteMember();
    window.open('/', '_self');
};

const toggleMic = async () => {
    if (!localAudioTrack || !micButton) return;
    const nextMuted = !localAudioTrack.muted;
    await localAudioTrack.setMuted(nextMuted);
    setControlState(micButton, nextMuted);
};

const toggleCamera = async () => {
    if (!localVideoTrack || !cameraButton) return;
    const nextMuted = !localVideoTrack.muted;
    await localVideoTrack.setMuted(nextMuted);
    setControlState(cameraButton, nextMuted);
};

const toggleChatPanel = () => {
    if (!chatPanel) return;
    chatPanel.classList.toggle('is-open');
};

const formatChatTime = (unixTime) => {
    const date = new Date(unixTime * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const renderMessage = (message) => {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    if (document.getElementById(`chat-msg-${message.id}`)) return;

    const isMine = String(message.uid) === String(UID);
    const node = document.createElement('article');
    node.className = `chat-message ${isMine ? 'is-mine' : ''}`.trim();
    node.id = `chat-msg-${message.id}`;
    node.innerHTML = `
        <div class="chat-meta">
            <span class="chat-name">${escapeHtml(message.name)}</span>
            <span class="chat-time">${formatChatTime(message.created_at)}</span>
        </div>
        <p class="chat-text">${escapeHtml(message.message)}</p>
    `;
    container.appendChild(node);
    container.scrollTop = container.scrollHeight;
};

const fetchMessages = async (isInitial = false) => {
    try {
        const limit = isInitial ? 100 : 50;
        const response = await fetch(`/get_messages/?room_name=${CHANNEL}&after_id=${lastMessageId}&limit=${limit}`);
        if (!response.ok) return;

        const data = await response.json();
        const messages = data.messages || [];
        for (let i = 0; i < messages.length; i++) {
            renderMessage(messages[i]);
            lastMessageId = Math.max(lastMessageId, messages[i].id);
        }
    } catch (error) {
        console.error('fetchMessages failed:', error);
    }
};

const sendMessage = async (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;
    input.value = '';

    try {
        const response = await fetch('/create_message/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: NAME, UID, room_name: CHANNEL, message }),
        });
        if (!response.ok) return;

        const saved = await response.json();
        renderMessage(saved);
        lastMessageId = Math.max(lastMessageId, saved.id || 0);
    } catch (error) {
        console.error('sendMessage failed:', error);
    }
};

const startChatPolling = () => {
    if (chatPoller) return;
    chatPoller = setInterval(() => {
        fetchMessages(false);
    }, CHAT_POLL_MS);
};

window.addEventListener('beforeunload', deleteMember);
window.addEventListener('resize', syncVideoLayout);

if (audioUnlockButton) audioUnlockButton.addEventListener('click', tryUnlockAudio);
if (micButton) micButton.addEventListener('click', toggleMic);
if (cameraButton) cameraButton.addEventListener('click', toggleCamera);
if (leaveButton) leaveButton.addEventListener('click', leaveAndRemoveLocalStream);
if (chatForm) chatForm.addEventListener('submit', sendMessage);
if (chatToggleButton) chatToggleButton.addEventListener('click', toggleChatPanel);

showAudioUnlock(false);
joinAndDisplayLocalStream();
