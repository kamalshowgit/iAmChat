
const APP_ID = sessionStorage.getItem('appId')
const TOKEN = sessionStorage.getItem('token')
const CHANNEL = sessionStorage.getItem('room')
let UID = sessionStorage.getItem('UID')

let NAME = sessionStorage.getItem('name') || 'Guest'
const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent)
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
const preferredCodec = (isMobile || isSafari) ? 'h264' : 'vp8'

const client = AgoraRTC.createClient({mode:'rtc', codec: preferredCodec})

let localTracks = []
let localAudioTrack = null
let localVideoTrack = null
let remoteUsers = {}
let chatPoller = null
let lastMessageId = 0
const CHAT_POLL_MS = 2000
const videoStreams = document.getElementById('video-streams')
const audioUnlockButton = document.getElementById('audio-unlock-btn')
let pendingAudioTracks = []

let setRoomError = (message) => {
    const errorNode = document.getElementById('room-error')
    if (!errorNode) return
    errorNode.textContent = message
    errorNode.style.display = message ? 'block' : 'none'
}

let showAudioUnlock = (shouldShow) => {
    if (!audioUnlockButton) return
    audioUnlockButton.style.display = shouldShow ? 'inline-flex' : 'none'
}

let queueAudioUnlock = (audioTrack) => {
    if (!audioTrack) return
    if (!pendingAudioTracks.includes(audioTrack)) {
        pendingAudioTracks.push(audioTrack)
    }
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
            pendingAudioTracks[i].play()
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
    else if (count === 3) videoStreams.classList.add('layout-3')
    else if (count === 4) videoStreams.classList.add('layout-4')
    else videoStreams.classList.add('layout-many')
}

let setControlEnabled = (id, enabled) => {
    const control = document.getElementById(id)
    if (!control) return
    control.style.opacity = enabled ? '1' : '0.45'
    control.style.pointerEvents = enabled ? 'auto' : 'none'
}

let applyVideoElementHints = (containerId, shouldMute = false) => {
    const videoElement = document.querySelector(`#${containerId} video`)
    if (!videoElement) return
    videoElement.setAttribute('playsinline', 'true')
    videoElement.setAttribute('webkit-playsinline', 'true')
    videoElement.autoplay = true
    videoElement.muted = shouldMute
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
        console.error('Microphone track failed', error)
        setupErrors.push('microphone')
    }

    try {
        localVideoTrack = await AgoraRTC.createCameraVideoTrack({
            encoderConfig: isMobile ? '360p_8' : '480p_2',
            optimizationMode: 'motion',
        })
    } catch (error) {
        console.error('Camera track failed', error)
        setupErrors.push('camera')
    }

    localTracks = [localAudioTrack, localVideoTrack].filter(Boolean)
    setControlEnabled('mic-btn', Boolean(localAudioTrack))
    setControlEnabled('camera-btn', Boolean(localVideoTrack))

    if (setupErrors.length) {
        setRoomError(`Unable to access ${setupErrors.join(' and ')}. You can still join with available devices.`)
    } else {
        setRoomError('')
    }

    return localTracks
}

let joinAndDisplayLocalStream = async () => {
    if (!APP_ID || !TOKEN || !CHANNEL || !UID) {
        setRoomError('Session expired. Please join the room again.')
        window.open('/', '_self')
        return
    }

    document.getElementById('room-name').innerText = CHANNEL

    client.on('user-published', handleUserJoined)
    client.on('user-left', handleUserLeft)
    client.on('connection-state-change', (currentState) => {
        if (currentState === 'DISCONNECTED') {
            setRoomError('Connection dropped. Reconnecting...')
        } else if (currentState === 'CONNECTED') {
            setRoomError('')
        }
    })

    try{
        UID = await client.join(APP_ID, CHANNEL, TOKEN, UID)
    }catch(error){
        console.error(error)
        setRoomError('Unable to connect to the call. Check your network and try again.')
        window.open('/', '_self')
        return
    }

    await setupLocalTracks()
    if (!localTracks.length) {
        setRoomError('Camera and microphone access failed. Allow permissions and retry.')
        await client.leave()
        return
    }

    let member = await createMember()

    let player = `<div  class="video-container" id="user-container-${UID}">
                     <div class="video-player" id="user-${UID}"></div>
                     <div class="username-wrapper"><span class="user-name">${escapeHtml(member.name || NAME)}</span></div>
                  </div>`
    
    videoStreams.insertAdjacentHTML('beforeend', player)
    syncVideoLayout()
    if (localVideoTrack) {
        localVideoTrack.play(`user-${UID}`)
        applyVideoElementHints(`user-${UID}`, true)
    }
    await client.publish(localTracks)
    await fetchMessages(true)
    startChatPolling()
}

let handleUserJoined = async (user, mediaType) => {
    remoteUsers[user.uid] = user
    try {
        await client.subscribe(user, mediaType)
    } catch (error) {
        console.error('Subscribe failed', error)
        return
    }

    if (mediaType === 'video'){
        let player = document.getElementById(`user-container-${user.uid}`)
        if (player != null){
            player.remove()
        }

        let member = await getMember(user)

        player = `<div  class="video-container" id="user-container-${user.uid}">
            <div class="video-player" id="user-${user.uid}"></div>
            <div class="username-wrapper"><span class="user-name">${escapeHtml(member.name || 'Guest')}</span></div>
        </div>`

        videoStreams.insertAdjacentHTML('beforeend', player)
        syncVideoLayout()
        try {
            user.videoTrack.play(`user-${user.uid}`)
            applyVideoElementHints(`user-${user.uid}`)
        } catch (error) {
            console.error('Remote video play failed', error)
        }
    }

    if (mediaType === 'audio'){
        try {
            user.audioTrack.play()
        } catch (error) {
            console.error('Remote audio play failed', error)
            queueAudioUnlock(user.audioTrack)
        }
    }
}

let handleUserLeft = async (user) => {
    delete remoteUsers[user.uid]
    let memberNode = document.getElementById(`user-container-${user.uid}`)
    if (memberNode) {
        memberNode.remove()
        syncVideoLayout()
    }
}

let leaveAndRemoveLocalStream = async () => {
    if (chatPoller) {
        clearInterval(chatPoller)
        chatPoller = null
    }

    for (let i = 0; i < localTracks.length; i++){
        localTracks[i].stop()
        localTracks[i].close()
    }

    await client.leave()
    //This is somewhat of an issue because if user leaves without actaull pressing leave button, it will not trigger
    deleteMember()
    window.open('/', '_self')
}

let setMutedState = (element, isMuted) => {
    if (!element) return
    element.classList.toggle('is-muted', isMuted)
}

let toggleCamera = async (e) => {
    if (!localVideoTrack) return
    const target = e.currentTarget
    if(localVideoTrack.muted){
        await localVideoTrack.setMuted(false)
        setMutedState(target, false)
    }else{
        await localVideoTrack.setMuted(true)
        setMutedState(target, true)
    }
}

let toggleMic = async (e) => {
    if (!localAudioTrack) return
    const target = e.currentTarget
    if(localAudioTrack.muted){
        await localAudioTrack.setMuted(false)
        setMutedState(target, false)
    }else{
        await localAudioTrack.setMuted(true)
        setMutedState(target, true)
    }
}

let createMember = async () => {
    try {
        let response = await fetch('/create_member/', {
            method:'POST',
            headers: {
                'Content-Type':'application/json'
            },
            body:JSON.stringify({'name':NAME, 'room_name':CHANNEL, 'UID':UID})
        })
        if (!response.ok) {
            return { name: NAME }
        }
        let member = await response.json()
        return member
    } catch (error) {
        return { name: NAME }
    }
}


let getMember = async (user) => {
    try {
        let response = await fetch(`/get_member/?UID=${user.uid}&room_name=${CHANNEL}`)
        if (!response.ok) {
            return { name: 'Guest' }
        }
        let member = await response.json()
        return member
    } catch (error) {
        return { name: 'Guest' }
    }
}

let deleteMember = async () => {
    try {
        await fetch('/delete_member/', {
            method:'POST',
            headers: {
                'Content-Type':'application/json'
            },
            body:JSON.stringify({'name':NAME, 'room_name':CHANNEL, 'UID':UID})
        })
    } catch (error) {
        console.error('Failed to delete member', error)
    }
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
    let date = new Date(unixTime * 1000)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

let renderMessage = (message) => {
    let container = document.getElementById('chat-messages')
    if (!container) return
    if (document.getElementById(`chat-msg-${message.id}`)) return

    let isMine = String(message.uid) === String(UID)
    let messageNode = document.createElement('article')
    messageNode.className = `chat-message ${isMine ? 'is-mine' : ''}`.trim()
    messageNode.id = `chat-msg-${message.id}`
    messageNode.innerHTML = `
        <div class="chat-meta">
            <span class="chat-name">${escapeHtml(message.name)}</span>
            <span class="chat-time">${formatChatTime(message.created_at)}</span>
        </div>
        <p class="chat-text">${escapeHtml(message.message)}</p>
    `
    container.appendChild(messageNode)
    container.scrollTop = container.scrollHeight
}

let fetchMessages = async (isInitial = false) => {
    try {
        const limit = isInitial ? 100 : 50
        let response = await fetch(`/get_messages/?room_name=${CHANNEL}&after_id=${lastMessageId}&limit=${limit}`)
        if (!response.ok) return

        let data = await response.json()
        let messages = data.messages || []

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
    let input = document.getElementById('chat-input')
    if (!input) return
    let message = input.value.trim()
    if (!message) return

    input.value = ''
    try {
        let response = await fetch('/create_message/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: NAME,
                UID,
                room_name: CHANNEL,
                message
            })
        })
        if (!response.ok) {
            return
        }

        let savedMessage = await response.json()
        renderMessage(savedMessage)
        lastMessageId = Math.max(lastMessageId, savedMessage.id || 0)
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

window.addEventListener("beforeunload",deleteMember);

joinAndDisplayLocalStream()
syncVideoLayout()
window.addEventListener('resize', syncVideoLayout)
showAudioUnlock(false)

document.getElementById('leave-btn').addEventListener('click', leaveAndRemoveLocalStream)
document.getElementById('camera-btn').addEventListener('click', toggleCamera)
document.getElementById('mic-btn').addEventListener('click', toggleMic)
document.getElementById('chat-form').addEventListener('submit', sendMessage)
if (audioUnlockButton) {
    audioUnlockButton.addEventListener('click', tryUnlockAudio)
}
