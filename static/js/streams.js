
const APP_ID = 'API_IDs'
const TOKEN = sessionStorage.getItem('token')
const CHANNEL = sessionStorage.getItem('room')
let UID = sessionStorage.getItem('UID')

let NAME = sessionStorage.getItem('name') || 'Guest'

const client = AgoraRTC.createClient({mode:'rtc', codec:'vp8'})

let localTracks = []
let remoteUsers = {}
let chatPoller = null
let lastMessageId = 0
const CHAT_POLL_MS = 2000

let joinAndDisplayLocalStream = async () => {
    document.getElementById('room-name').innerText = CHANNEL

    client.on('user-published', handleUserJoined)
    client.on('user-left', handleUserLeft)

    try{
        UID = await client.join(APP_ID, CHANNEL, TOKEN, UID)
    }catch(error){
        console.error(error)
        window.open('/', '_self')
    }
    
    localTracks = await AgoraRTC.createMicrophoneAndCameraTracks()

    let member = await createMember()

    let player = `<div  class="video-container" id="user-container-${UID}">
                     <div class="video-player" id="user-${UID}"></div>
                     <div class="username-wrapper"><span class="user-name">${escapeHtml(member.name || NAME)}</span></div>
                  </div>`
    
    document.getElementById('video-streams').insertAdjacentHTML('beforeend', player)
    localTracks[1].play(`user-${UID}`)
    await client.publish([localTracks[0], localTracks[1]])
    await fetchMessages(true)
    startChatPolling()
}

let handleUserJoined = async (user, mediaType) => {
    remoteUsers[user.uid] = user
    await client.subscribe(user, mediaType)

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

        document.getElementById('video-streams').insertAdjacentHTML('beforeend', player)
        user.videoTrack.play(`user-${user.uid}`)
    }

    if (mediaType === 'audio'){
        user.audioTrack.play()
    }
}

let handleUserLeft = async (user) => {
    delete remoteUsers[user.uid]
    let memberNode = document.getElementById(`user-container-${user.uid}`)
    if (memberNode) {
        memberNode.remove()
    }
}

let leaveAndRemoveLocalStream = async () => {
    if (chatPoller) {
        clearInterval(chatPoller)
        chatPoller = null
    }

    for (let i=0; localTracks.length > i; i++){
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
    const target = e.currentTarget
    if(localTracks[1].muted){
        await localTracks[1].setMuted(false)
        setMutedState(target, false)
    }else{
        await localTracks[1].setMuted(true)
        setMutedState(target, true)
    }
}

let toggleMic = async (e) => {
    const target = e.currentTarget
    if(localTracks[0].muted){
        await localTracks[0].setMuted(false)
        setMutedState(target, false)
    }else{
        await localTracks[0].setMuted(true)
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

document.getElementById('leave-btn').addEventListener('click', leaveAndRemoveLocalStream)
document.getElementById('camera-btn').addEventListener('click', toggleCamera)
document.getElementById('mic-btn').addEventListener('click', toggleMic)
document.getElementById('chat-form').addEventListener('submit', sendMessage)
