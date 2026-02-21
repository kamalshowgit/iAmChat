const APP_ID = sessionStorage.getItem('appId')
const TOKEN = sessionStorage.getItem('token')
const CHANNEL = sessionStorage.getItem('room')
let UID = sessionStorage.getItem('UID')
const NAME = sessionStorage.getItem('name') || 'Guest'

const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent)
const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' })

let localTracks = []
let localAudioTrack = null
let localVideoTrack = null
let remoteUsers = {}
let chatPoller = null
let lastMessageId = 0
let pendingAudioTracks = []
let focusTimerId = null
let focusTimerEnd = null

const CHAT_POLL_MS = 2000

const videoStreams = document.getElementById('video-streams')
const audioUnlockButton = document.getElementById('audio-unlock-btn')
const newActivityButton = document.getElementById('new-activity-btn')
const focusTimerButton = document.getElementById('focus-timer-btn')
const activityDescription = document.getElementById('activity-description')
const activityTitle = document.getElementById('activities-title')
const focusTimerDisplay = document.getElementById('focus-timer-display')
const micButton = document.getElementById('mic-btn')
const cameraButton = document.getElementById('camera-btn')
const leaveButton = document.getElementById('leave-btn')
const chatForm = document.getElementById('chat-form')

const ACTIVITIES = {
    valentine: [
        'Memory Spark: each person shares one favorite moment together.',
        'Two Truths, One Dream: share two true stories and one future plan.',
        'Compliment Relay: take turns giving sincere compliments for 2 minutes.',
        'Playlist Pick: each person adds one song and explains the choice.',
    ],
    study: [
        '15-minute Focus Sprint: cameras on, mics muted, then share progress.',
        'Teach Back: explain one concept in 60 seconds each.',
        'Flashcard Drill: ask each other 5 rapid questions.',
        'Goal Check-in: set one micro-goal and report result after 10 minutes.',
    ],
}

let setRoomError = (message) => {
    const errorNode = document.getElementById('room-error')
    if (!errorNode) return
    errorNode.textContent = message || ''
    errorNode.style.display = message ? 'block' : 'none'
}

let getActiveTheme = () => {
    const theme = document.documentElement.getAttribute('data-theme')
    return theme === 'study' ? 'study' : 'valentine'
}

let pickActivity = () => {
    if (!activityDescription || !activityTitle) return
    const theme = getActiveTheme()
    const options = ACTIVITIES[theme]
    const index = Math.floor(Math.random() * options.length)
    activityTitle.textContent = theme === 'study' ? 'Study Activity' : 'Valentine Activity'
    activityDescription.textContent = options[index]
}

let renderFocusTime = () => {
    if (!focusTimerDisplay || !focusTimerEnd) return
    const secondsLeft = Math.max(0, Math.floor((focusTimerEnd - Date.now()) / 1000))
    const minutes = Math.floor(secondsLeft / 60).toString().padStart(2, '0')
    const seconds = (secondsLeft % 60).toString().padStart(2, '0')
    focusTimerDisplay.textContent = `${minutes}:${seconds}`
    if (secondsLeft === 0) {
        clearInterval(focusTimerId)
        focusTimerId = null
        focusTimerEnd = null
        if (focusTimerButton) focusTimerButton.textContent = 'Start 15m Focus'
    }
}

let toggleFocusTimer = () => {
    if (!focusTimerDisplay || !focusTimerButton) return
    if (focusTimerId) {
        clearInterval(focusTimerId)
        focusTimerId = null
        focusTimerEnd = null
        focusTimerDisplay.textContent = ''
        focusTimerButton.textContent = 'Start 15m Focus'
        return
    }
    focusTimerEnd = Date.now() + (15 * 60 * 1000)
    focusTimerButton.textContent = 'Stop Focus'
    renderFocusTime()
    focusTimerId = setInterval(renderFocusTime, 1000)
}

let showAudioUnlock = (show) => {
    if (!audioUnlockButton) return
    audioUnlockButton.style.display = show ? 'inline-flex' : 'none'
}

let queueAudioUnlock = (audioTrack) => {
    if (!audioTrack) return
    if (!pendingAudioTracks.includes(audioTrack)) pendingAudioTracks.push(audioTrack)
    showAudioUnlock(true)
    setRoomError('Tap "Enable Audio" to allow speaker playback on this device.')
}

let tryUnlockAudio = async () => {
    if (!pendingAudioTracks.length) {
        showAudioUnlock(false)
        return
    }
    const retries = []
    for (let i = 0; i < pendingAudioTracks.length; i++) {
        try {
            await Promise.resolve(pendingAudioTracks[i].play())
        } catch (error) {
            retries.push(pendingAudioTracks[i])
        }
    }
    pendingAudioTracks = retries
    if (!pendingAudioTracks.length) {
        showAudioUnlock(false)
        setRoomError('')
    }
}

let syncVideoLayout = () => {
    if (!videoStreams) return
    const count = videoStreams.querySelectorAll('.video-container').length
    videoStreams.classList.remove('layout-1', 'layout-2', 'layout-3', 'layout-4', 'layout-many')
    if (count <= 1) videoStreams.classList.add('layout-1')
    else if (count === 2) videoStreams.classList.add('layout-2')
    else if (count <= 4) videoStreams.classList.add('layout-4')
    else videoStreams.classList.add('layout-many')
}

let setControlEnabled = (button, enabled) => {
    if (!button) return
    button.disabled = !enabled
}

let setControlState = (button, isMuted) => {
    if (!button) return
    button.classList.toggle('is-muted', isMuted)
    button.setAttribute('aria-pressed', String(isMuted))
}

let applyVideoElementHints = (playerId, muted = false) => {
    const player = document.getElementById(playerId)
    if (!player) return
    const video = player.querySelector('video')
    if (!video) return
    video.setAttribute('playsinline', 'true')
    video.setAttribute('webkit-playsinline', 'true')
    video.autoplay = true
    video.muted = muted
}

let ensureVideoContainer = async (userUid, displayName) => {
    let container = document.getElementById(`user-container-${userUid}`)
    if (container) container.remove()

    const player = `
        <article class="video-container" id="user-container-${userUid}">
            <div class="video-player" id="user-${userUid}"></div>
            <div class="username-wrapper"><span class="user-name">${escapeHtml(displayName || 'Guest')}</span></div>
        </article>
    `
    videoStreams.insertAdjacentHTML('beforeend', player)
    syncVideoLayout()
}

let playRemoteVideoWithRetry = async (user, playerId, attempt = 0) => {
    if (!user || !user.videoTrack) return
    try {
        await Promise.resolve(user.videoTrack.play(playerId))
        await new Promise((resolve) => setTimeout(resolve, 120))
        applyVideoElementHints(playerId, false)
    } catch (error) {
        if (attempt >= 6) {
            console.error('Remote video play failed', error)
            return
        }
        setTimeout(() => {
            playRemoteVideoWithRetry(user, playerId, attempt + 1)
        }, 220 * (attempt + 1))
    }
}

let setupLocalTracks = async () => {
    const setupErrors = []

    try {
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: 'music_standard',
            AEC: true,
            AGC: true,
            ANS: true,
        })
    } catch (error) {
        setupErrors.push('microphone')
        console.error('Microphone track failed', error)
    }

    try {
        localVideoTrack = await AgoraRTC.createCameraVideoTrack({
            encoderConfig: isMobile ? '360p_8' : '480p_2',
            optimizationMode: 'motion',
        })
    } catch (error) {
        setupErrors.push('camera')
        console.error('Camera track failed', error)
    }

    localTracks = [localAudioTrack, localVideoTrack].filter(Boolean)
    setControlEnabled(micButton, Boolean(localAudioTrack))
    setControlEnabled(cameraButton, Boolean(localVideoTrack))
    setControlState(micButton, false)
    setControlState(cameraButton, false)

    if (setupErrors.length) {
        setRoomError(`Unable to access ${setupErrors.join(' and ')}. You can still join with available devices.`)
    }
}

let createMember = async () => {
    try {
        const response = await fetch('/create_member/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: NAME, room_name: CHANNEL, UID }),
        })
        if (!response.ok) return { name: NAME }
        return await response.json()
    } catch (error) {
        return { name: NAME }
    }
}

let getMember = async (user) => {
    try {
        const response = await fetch(`/get_member/?UID=${user.uid}&room_name=${CHANNEL}`)
        if (!response.ok) return { name: 'Guest' }
        return await response.json()
    } catch (error) {
        return { name: 'Guest' }
    }
}

let deleteMember = async () => {
    try {
        await fetch('/delete_member/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: NAME, room_name: CHANNEL, UID }),
        })
    } catch (error) {
        console.error('Failed to delete member', error)
    }
}

let handleUserPublished = async (user, mediaType) => {
    remoteUsers[user.uid] = user
    try {
        await client.subscribe(user, mediaType)
    } catch (error) {
        console.error('Subscribe failed', error)
        return
    }

    if (mediaType === 'video') {
        const member = await getMember(user)
        await ensureVideoContainer(user.uid, member.name)
        await playRemoteVideoWithRetry(user, `user-${user.uid}`)
    }

    if (mediaType === 'audio') {
        try {
            await Promise.resolve(user.audioTrack.play())
        } catch (error) {
            queueAudioUnlock(user.audioTrack)
        }
    }
}

let removeUserContainer = (uid) => {
    const node = document.getElementById(`user-container-${uid}`)
    if (node) node.remove()
    syncVideoLayout()
}

let handleUserUnpublished = (user, mediaType) => {
    if (mediaType === 'video') {
        removeUserContainer(user.uid)
    }
}

let handleUserLeft = (user) => {
    delete remoteUsers[user.uid]
    removeUserContainer(user.uid)
}

let joinAndDisplayLocalStream = async () => {
    if (!APP_ID || !TOKEN || !CHANNEL || !UID) {
        setRoomError('Session expired. Please join the room again.')
        window.open('/', '_self')
        return
    }

    const roomName = document.getElementById('room-name')
    if (roomName) roomName.textContent = CHANNEL

    client.on('user-published', handleUserPublished)
    client.on('user-unpublished', handleUserUnpublished)
    client.on('user-left', handleUserLeft)
    client.on('connection-state-change', (state) => {
        if (state === 'DISCONNECTED') setRoomError('Connection dropped. Reconnecting...')
        if (state === 'CONNECTED') setRoomError('')
    })

    try {
        UID = await client.join(APP_ID, CHANNEL, TOKEN, UID)
    } catch (error) {
        console.error(error)
        setRoomError('Unable to connect to room. Check token and network.')
        return
    }

    await setupLocalTracks()
    if (!localTracks.length) {
        await client.leave()
        setRoomError('Camera and microphone access failed. Allow permissions and retry.')
        return
    }

    const member = await createMember()
    await ensureVideoContainer(UID, member.name || NAME)

    if (localVideoTrack) {
        await Promise.resolve(localVideoTrack.play(`user-${UID}`))
        applyVideoElementHints(`user-${UID}`, true)
    }

    try {
        await client.publish(localTracks)
    } catch (error) {
        console.error('Publish failed', error)
        setRoomError('Could not publish your stream. Refresh and allow camera/mic permissions.')
        return
    }

    await fetchMessages(true)
    startChatPolling()
}

let leaveAndRemoveLocalStream = async () => {
    if (chatPoller) {
        clearInterval(chatPoller)
        chatPoller = null
    }

    for (let i = 0; i < localTracks.length; i++) {
        localTracks[i].stop()
        localTracks[i].close()
    }

    try {
        await client.leave()
    } catch (error) {
        console.error('Leave failed', error)
    }

    await deleteMember()
    window.open('/', '_self')
}

let toggleCamera = async () => {
    if (!localVideoTrack || !cameraButton) return
    const nextMuted = !localVideoTrack.muted
    await localVideoTrack.setMuted(nextMuted)
    setControlState(cameraButton, nextMuted)
}

let toggleMic = async () => {
    if (!localAudioTrack || !micButton) return
    const nextMuted = !localAudioTrack.muted
    await localAudioTrack.setMuted(nextMuted)
    setControlState(micButton, nextMuted)
}

let escapeHtml = (value) => {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

let formatChatTime = (unixTime) => {
    const date = new Date(unixTime * 1000)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

let renderMessage = (message) => {
    const container = document.getElementById('chat-messages')
    if (!container) return
    if (document.getElementById(`chat-msg-${message.id}`)) return

    const isMine = String(message.uid) === String(UID)
    const node = document.createElement('article')
    node.className = `chat-message ${isMine ? 'is-mine' : ''}`.trim()
    node.id = `chat-msg-${message.id}`
    node.innerHTML = `
        <div class="chat-meta">
            <span class="chat-name">${escapeHtml(message.name)}</span>
            <span class="chat-time">${formatChatTime(message.created_at)}</span>
        </div>
        <p class="chat-text">${escapeHtml(message.message)}</p>
    `
    container.appendChild(node)
    container.scrollTop = container.scrollHeight
}

let fetchMessages = async (isInitial = false) => {
    try {
        const limit = isInitial ? 100 : 50
        const response = await fetch(`/get_messages/?room_name=${CHANNEL}&after_id=${lastMessageId}&limit=${limit}`)
        if (!response.ok) return

        const data = await response.json()
        const messages = data.messages || []
        for (let i = 0; i < messages.length; i++) {
            renderMessage(messages[i])
            lastMessageId = Math.max(lastMessageId, messages[i].id)
        }
    } catch (error) {
        console.error('Failed to fetch messages', error)
    }
}

let sendMessage = async (e) => {
    e.preventDefault()
    const input = document.getElementById('chat-input')
    if (!input) return
    const message = input.value.trim()
    if (!message) return
    input.value = ''

    try {
        const response = await fetch('/create_message/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: NAME, UID, room_name: CHANNEL, message }),
        })
        if (!response.ok) return
        const saved = await response.json()
        renderMessage(saved)
        lastMessageId = Math.max(lastMessageId, saved.id || 0)
    } catch (error) {
        console.error('Failed to send message', error)
    }
}

let startChatPolling = () => {
    if (chatPoller) return
    chatPoller = setInterval(() => {
        fetchMessages(false)
    }, CHAT_POLL_MS)
}

window.addEventListener('beforeunload', deleteMember)

joinAndDisplayLocalStream()
syncVideoLayout()
showAudioUnlock(false)
pickActivity()
window.addEventListener('resize', syncVideoLayout)

if (leaveButton) leaveButton.addEventListener('click', leaveAndRemoveLocalStream)
if (cameraButton) cameraButton.addEventListener('click', toggleCamera)
if (micButton) micButton.addEventListener('click', toggleMic)
if (chatForm) chatForm.addEventListener('submit', sendMessage)
if (audioUnlockButton) audioUnlockButton.addEventListener('click', tryUnlockAudio)
if (newActivityButton) newActivityButton.addEventListener('click', pickActivity)
if (focusTimerButton) focusTimerButton.addEventListener('click', toggleFocusTimer)

const themeObserver = new MutationObserver(() => {
    pickActivity()
})
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
