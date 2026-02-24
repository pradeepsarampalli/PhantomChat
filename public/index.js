const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
})();

//state
const S = {
  username:      '',
  userId:        '',
  ws:            null,
  wsReady:       false,
  reconnectTimer:null,
  reconnectCount:0,
  rooms:         {},        
  roomMessages:  {},       
  roomMembers:   {},  
  currentRoomId: null,
  pendingRoomId: null,
  newRoomType:   'private',
  membersPanelOpen: false,
  countdownTimer: null,
};


//websocket
function wsConnect() {
  setConnStatus('connecting');
  const ws = new WebSocket(WS_URL);
  S.ws = ws;

  ws.onopen = () => {
    S.wsReady = true;
    S.reconnectCount = 0;
    setConnStatus('connected');
    wsSend({ type: 'auth', userId: S.userId, username: S.username });
    if (S.currentRoomId) wsSend({ type: 'join_room', roomId: S.currentRoomId });
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServer(msg);
  };

  ws.onclose = () => {
    S.wsReady = false;
    setConnStatus('disconnected');
    const delay = Math.min(1000 * 2 ** S.reconnectCount, 16000);
    S.reconnectCount++;
    S.reconnectTimer = setTimeout(wsConnect, delay);
  };

  ws.onerror = () => ws.close();
}

function wsSend(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(obj));
  }
}

// server message handler
function handleServer(msg) {
  switch (msg.type) {

    case 'auth_ok':
      S.userId   = msg.userId;
      break;

    case 'error':
      toast(msg.message, true);
      break;

    case 'room_created': {
      const r = msg.room;
      S.rooms[r.id]        = r;
      S.roomMessages[r.id] = [];
      S.roomMembers[r.id]  = r.members || {};
      S.pendingRoomId      = r.id;
      document.getElementById('createdRoomIdInput').value = r.id;
      openModal('modalCreated');
      updateLobbyUI();
      break;
    }

    case 'room_joined': {
      const r = msg.room;
      S.rooms[r.id]        = r;
      S.roomMessages[r.id] = msg.messages || [];
      S.roomMembers[r.id]  = r.members || {};
      renderChatScreen(r.id);
      break;
    }

    case 'new_message': {
      const m = msg.message;
      if (!S.roomMessages[msg.roomId]) S.roomMessages[msg.roomId] = [];
      S.roomMessages[msg.roomId].push(m);
      if (msg.roomId === S.currentRoomId) appendMessage(m);
      break;
    }

    case 'user_joined': {
      if (S.currentRoomId && S.rooms[S.currentRoomId]) {
        S.roomMembers[S.currentRoomId] = msg.members;
        S.rooms[S.currentRoomId].memberCount = Object.keys(msg.members).length;
        appendSystemMsg(`${esc(msg.username)} joined the room`);
        renderMembersList();
      }
      break;
    }

    case 'user_left': {
      if (S.currentRoomId && S.rooms[S.currentRoomId]) {
        S.roomMembers[S.currentRoomId] = msg.members || S.roomMembers[S.currentRoomId];
        if (S.roomMembers[S.currentRoomId]) delete S.roomMembers[S.currentRoomId][msg.userId];
        appendSystemMsg(`${esc(msg.username)} left the room`);
        renderMembersList();
      }
      break;
    }

    case 'left_room':
      S.currentRoomId = null;
      showScreen('lobby');
      updateLobbyUI();
      break;

    case 'room_deleted':
    case 'room_expired': {
      const rId = msg.roomId;
      const rName = msg.name || rId;
      if (S.currentRoomId === rId) {
        appendSystemMsg(`⏰ "${rName}" has been destroyed`);
        clearInterval(S.countdownTimer);
        setTimeout(() => {
          S.currentRoomId = null;
          showScreen('lobby');
          updateLobbyUI();
        }, 2500);
      }
      delete S.rooms[rId];
      delete S.roomMessages[rId];
      delete S.roomMembers[rId];
      updateLobbyUI();
      break;
    }
  }
}

//navigations
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function goToLobby() {
  const name = document.getElementById('usernameInput').value.trim();
  if (!name) { toast('Enter a display name first', true); return; }
  S.username = name;
  document.getElementById("lobbyUsername").value = name;
  S.userId   = 'u_' + Math.random().toString(36).substr(2, 9);
  showConnStatus();
  wsConnect();
  showScreen('lobby');
  updateLobbyUI();
}

function logout() {
  if (S.ws) S.ws.close();
  clearTimeout(S.reconnectTimer);
  S.ws = null; S.wsReady = false;
  S.rooms = {}; S.roomMessages = {}; S.roomMembers = {};
  S.currentRoomId = null;
  hideConnStatus();
  showScreen('landing');
}

function quickJoin() {
  const name = document.getElementById('usernameInput').value.trim();
  if (!name) { toast('Enter a display name first', true); return; }
  const roomId = document.getElementById('quickJoinInput').value.trim().toUpperCase();
  if (!roomId) { toast('Enter a room ID', true); return; }
  S.username = name;
  S.userId   = 'u_' + Math.random().toString(36).substr(2, 9);
  showConnStatus();
  wsConnect();
  const orig = handleServer;
  function waitAuth(msg) {
    if (msg.type === 'auth_ok') {
      wsSend({ type: 'join_room', roomId });
    }
    orig(msg);
  }
  S._quickJoinRoom = roomId;
  showScreen('lobby');
  updateLobbyUI();
  const t = setInterval(() => {
    if (S.wsReady) {
      clearInterval(t);
      wsSend({ type: 'join_room', roomId });
    }
  }, 200);
}

//room crud
function setRoomType(type) {
  S.newRoomType = type;
  document.getElementById('tabPrivate').classList.toggle('active', type === 'private');
  document.getElementById('tabGroup').classList.toggle('active', type === 'group');
}

function createRoom() {
  if (!S.wsReady) { toast('Connecting to server...', true); return; }
  const name = document.getElementById('newRoomName').value.trim();
  wsSend({ type: 'create_room', name: name || (S.newRoomType === 'private' ? 'Private Chat' : 'Group Room'), roomType: S.newRoomType });
  document.getElementById('newRoomName').value = '';
}

function enterPendingRoom() {
  closeModal('modalCreated');
  if (S.pendingRoomId) wsSend({ type: 'join_room', roomId: S.pendingRoomId });
}

function joinById() {
  const id = document.getElementById('joinRoomInput').value.trim().toUpperCase();
  if (!id) { toast('Enter a room ID', true); return; }
  if (!S.wsReady) { toast('Still connecting...', true); return; }
  wsSend({ type: 'join_room', roomId: id });
  document.getElementById('joinRoomInput').value = '';
}

function leaveRoom(forced) {
  if (S.countdownTimer) { clearInterval(S.countdownTimer); S.countdownTimer = null; }
  S.membersPanelOpen = false;
  document.getElementById('membersPanel').classList.remove('open');
  if (!forced) {
    wsSend({ type: 'leave_room' });
  } else {
    S.currentRoomId = null;
    showScreen('lobby');
    updateLobbyUI();
  }
}

function deleteRoom() {
  wsSend({ type: 'delete_room' });
  closeModal('modalInfo');
}

//chat rendering
function renderChatScreen(roomId) {
  S.currentRoomId = roomId;
  const room = S.rooms[roomId];
  if (!room) return;

  document.getElementById('chatRoomName').textContent = room.name;
  const badge = document.getElementById('chatRoomBadge');
  badge.textContent = room.type === 'private' ? 'Private' : 'Group';
  badge.className = 'badge ' + (room.type === 'private' ? 'badge-private' : 'badge-group');

  // Show/hide delete button
  document.getElementById('deleteRoomBtn').style.display = room.creator === S.userId ? '' : 'none';

  const area = document.getElementById('messagesArea');
  area.innerHTML = '';
  appendSystemMsg('Welcome to ' + esc(room.name));
  (S.roomMessages[roomId] || []).forEach(m => appendMessage(m));

  S.roomMembers[roomId] = room.members || {};
  renderMembersList();
  showScreen('chat');

  // Countdown
  if (S.countdownTimer) clearInterval(S.countdownTimer);
  S.countdownTimer = setInterval(() => { tickCountdown(room); }, 1000);
  tickCountdown(room);
}

function tickCountdown(room) {
  const rem = Math.max(0, room.expiresAt - Date.now());
  if (rem === 0) return;
  const h = Math.floor(rem / 3600000);
  const m = Math.floor((rem % 3600000) / 60000);
  const s = Math.floor((rem % 60000) / 1000);
  document.getElementById('chatCountdown').textContent =
    `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const pct = (rem / (24 * 3600 * 1000)) * 100;
  document.getElementById('expiryFill').style.width = pct + '%';
}

function appendMessage(msg) {
  const area = document.getElementById('messagesArea');
  const isOwn = msg.userId === S.userId;
  const [bg] = colorFor(msg.username);
  const el = document.createElement('div');
  el.className = 'msg' + (isOwn ? ' own' : '');
  const t = new Date(msg.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  el.innerHTML = `
    ${!isOwn ? `<div class="avatar" style="background:${bg}20;color:${bg};border:1px solid ${bg}40">${esc(msg.username[0].toUpperCase())}</div>` : ''}
    <div class="msg-wrap">
      ${!isOwn ? `<div class="msg-sender" style="color:${bg}">${esc(msg.username)}</div>` : ''}
      <div class="msg-bubble">${esc(msg.text)}</div>
      <div class="msg-time">${t}</div>
    </div>
    ${isOwn ? `<div class="avatar" style="background:${bg}20;color:${bg};border:1px solid ${bg}40">${esc(msg.username[0].toUpperCase())}</div>` : ''}
  `;
  area.appendChild(el);
  area.scrollTop = area.scrollHeight;
}

function appendSystemMsg(text) {
  const area = document.getElementById('messagesArea');
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  area.appendChild(el);
  area.scrollTop = area.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !S.currentRoomId) return;
  wsSend({ type: 'send_message', text });
  input.value = '';
  input.style.height = 'auto';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { 
    e.preventDefault(); sendMessage(); 
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

//members of room
function toggleMembers() {
  S.membersPanelOpen = !S.membersPanelOpen;
  document.getElementById('membersPanel').classList.toggle('open', S.membersPanelOpen);
}

function renderMembersList() {
  const members = S.roomMembers[S.currentRoomId] || {};
  const list = document.getElementById('membersList');
  list.innerHTML = '';
  Object.entries(members).forEach(([uid, uname]) => {
    const [bg] = colorFor(uname);
    const item = document.createElement('div');
    item.className = 'member-item';
    item.innerHTML = `
      <div class="avatar" style="background:${bg}20;color:${bg};border:1px solid ${bg}40;width:22px;height:22px;font-size:0.6rem">${esc(uname[0].toUpperCase())}</div>
      <div class="online-dot"></div>
      <span>${esc(uname)}${uid === S.userId ? ' <span style="color:var(--muted)">(you)</span>' : ''}</span>
    `;
    list.appendChild(item);
  });
}

// lobby ui
function updateLobbyUI() {
  const [bg] = colorFor(S.username);
  const av = document.getElementById('lobbyAvatar');
  if (av) { av.textContent = (S.username[0] || '?').toUpperCase(); av.style.background = bg + '20'; av.style.color = bg; }
  document.getElementById('lobbyUsername').textContent = S.username;

  const grid = document.getElementById('myRoomsGrid');
  const myRooms = Object.values(S.rooms);
  if (!myRooms.length) {
    grid.innerHTML = `<div class="empty-state"><p>No rooms yet.<br>Create one above.</p></div>`;
    return;
  }
  grid.innerHTML = '';

  //rooms that user has been created . ui to display all cards
  myRooms.forEach(room => {
    const rem = Math.max(0, room.expiresAt - Date.now());
    const h = Math.floor(rem/3600000), m = Math.floor((rem %3600000)/60000);
    const mc = room.memberCount || Object.keys(S.roomMembers[room.id] || {}).length || 1;
    const card = document.createElement('div');
    card.className = 'room-card';
    card.onclick = () => wsSend({ type: 'join_room', roomId: room.id });
    card.innerHTML = `
      <div class="rc-header">
        <div class="rc-name">${esc(room.name)}</div>
        <span class="badge ${room.type === 'private' ? 'badge-private' : 'badge-group'}">${room.type}</span>
      </div>
      <div class="rc-id">${room.id}</div>
      <div class="rc-meta">
        <span>${mc} ${mc === 1 ? 'member' : 'members'}</span>
        <div class="countdown"><div class="dot-live"></div>${h}h ${m}m left</div>
      </div>
    `;
    grid.appendChild(card);
  });
}

//  room info modal
function showRoomInfo() {
  const room = S.rooms[S.currentRoomId];
  if (!room) return;
  document.getElementById('infoName').textContent = room.name;
  document.getElementById('infoIdInput').value = room.id;
  document.getElementById('infoType').textContent = room.type;
  document.getElementById('infoMembers').textContent = Object.keys(S.roomMembers[room.id] || {}).length;
  document.getElementById('infoExpiry').textContent = new Date(room.expiresAt).toLocaleString();
  document.getElementById('deleteRoomBtn').style.display = room.creator === S.userId ? '' : 'none';
  openModal('modalInfo');
}

//  modal - control(open-close)
function openModal(id) { 
  document.getElementById(id).classList.add('open'); 
}
function closeModal(id) { 
  document.getElementById(id).classList.remove('open'); 
}

//modal display (used EventDeligation)
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
});

//copying button for id
function copyId(inputId) {
  const v = document.getElementById(inputId).value;
  navigator.clipboard.writeText(v).then(() => toast('Copied!')).catch(() => toast('Copy failed', true));
}

//toast for activities
let _toastTimer;
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' error' : '');
  clearTimeout(_toastTimer);
  requestAnimationFrame(() => {
    el.classList.add('show');
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  });
}

//  CONNECTION STATUS INDICATOR
function setConnStatus(s) {
  const el = document.getElementById('connStatus');
  const label = document.getElementById('connLabel');
  el.className = s;
  label.textContent = s === 'connected' ? 'live' : s;
  if (s === 'connected') setTimeout(() => el.classList.add('hidden'), 3000);
  else el.classList.remove('hidden');
}
function showConnStatus() { 
  document.getElementById('connStatus').classList.remove('hidden'); 
}
function hideConnStatus() { 
  document.getElementById('connStatus').classList.add('hidden'); 
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
const COLORS = [
  '#7c3aed','#0891b2','#059669','#d97706',
  '#dc2626','#db2777','#4f46e5','#0d9488',
];
function colorFor(name) {
  let h = 0;
  for (const c of (name || '?')) h = (h * 31 + c.charCodeAt(0)) % COLORS.length;
  return [COLORS[h]];
}
document.getElementById('usernameInput').addEventListener('keydown', e => { if (e.key === 'Enter') goToLobby(); });
document.getElementById('quickJoinInput').addEventListener('keydown', e => { if (e.key === 'Enter') quickJoin(); });
document.getElementById('joinRoomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinById(); });
