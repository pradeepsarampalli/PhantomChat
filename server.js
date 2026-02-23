const express    = require('express');
const http       = require('http');
const path       = require('path');
const { WebSocketServer, WebSocket } = require('ws');


const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

//CORS / JSON 
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());

//Static frontend 
app.use(express.static(path.join(__dirname, 'public')));

//Health check 
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size, clients: clients.size }));


app.get('/api/rooms', (_, res) => {
  const list = [...rooms.values()].map(r => r.summary());
  res.json(list);
});

//  IN-MEMORY  storing
const ROOM_TTL = 24 *60*60*1000; // 24 hours

const rooms   = new Map(); // roomId  → Room
const clients = new Map(); // w → Clientmeta

class Room {
  constructor(id, name, type, creatorId) {
    this.id        = id;
    this.name      = (name || 'Chat Room').slice(0, 50);
    this.type      = type === 'group' ? 'group' : 'private';
    this.createdAt = Date.now();
    this.expiresAt = Date.now() + ROOM_TTL;
    this.creator   = creatorId;
    this.members   = new Map(); 
    this.messages  = []; 
    this._timer    = setTimeout(() => this._expire(), ROOM_TTL);
  }

  _expire() {
    console.log(`[EXPIRE] ${this.id} — "${this.name}"`);
    broadcastRoom(this.id, { type: 'room_expired', roomId: this.id, name: this.name });
    // detach all clients from this room
    clients.forEach(m => { if (m.roomId === this.id) m.roomId = null; });
    rooms.delete(this.id);
  }

  destroy() {
    clearTimeout(this._timer);
    rooms.delete(this.id);
  }

  summary() {
    return {
      id:this.id,
      name:this.name,
      type: this.type,
      createdAt:this.createdAt,
      expiresAt:this.expiresAt,
      creator:this.creator,
      memberCount:this.members.size,
      members:Object.fromEntries(this.members),
    };
  }
}

//  HELPERS
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(roomId, obj, excludeWs = null) {
  clients.forEach((meta, ws) => {
    if (meta.roomId === roomId && ws !== excludeWs) send(ws, obj);
  });
}

function broadcastRoomAll(roomId, obj) {
  clients.forEach((meta, ws) => {
    if (meta.roomId === roomId) send(ws, obj);
  });
}

function genId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 10; i++) {
    if (i === 5) id += '-';
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function memberSnapshot(room) {
  return Object.fromEntries(room.members);
}

//  WEBSOCKET SERVER
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  clients.set(ws, { userId: null, username: null, roomId: null });
  // console.log(`[CONNECT] ${ip}  total=${clients.size}`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = clients.get(ws);
    if (!meta) return;
    handle(ws, meta, msg);
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (meta?.roomId) {
      const room = rooms.get(meta.roomId);
      if (room) {
        room.members.delete(meta.userId);
        broadcastRoom(meta.roomId, {
          type:     'user_left',
          userId:   meta.userId,
          username: meta.username,
          members:  memberSnapshot(room),
        });
      }
    }
    clients.delete(ws);
    // console.log(`[DISCONNECT] total=${clients.size}`);
  });

  ws.on('error', err => console.error('[WS ERROR]', err.message));
});

//  MESSAGE HANDLER
function handle(ws, meta, msg) {
  switch (msg.type) {

    // auth
    case 'auth': {
      meta.userId   = (msg.userId   || ('u_' + Math.random().toString(36).substr(2, 8)));
      meta.username = (msg.username || 'anon').replace(/</g,'').replace(/>/g,'').slice(0, 30);
      send(ws, { type: 'auth_ok', userId: meta.userId, username: meta.username });
      break;
    }

    // CREATE ROOM 
    case 'create_room': {
      if (!meta.userId) return send(ws, err('Not authenticated'));
      const roomId = genId();
      const room   = new Room(roomId, msg.name, msg.roomType, meta.userId);
      room.members.set(meta.userId, meta.username);
      rooms.set(roomId, room);
      meta.roomId = roomId;
      //console.log(`[CREATE] ${roomId} "${room.name}" (${room.type}) by ${meta.username}`);
      send(ws, { type: 'room_created', room: room.summary(), messages: [] });
      break;
    }

    // ── JOIN ROOM
    case 'join_room': {
      if (!meta.userId) return send(ws, err('Not authenticated'));
      const roomId = (msg.roomId || '').toUpperCase().trim();
      const room   = rooms.get(roomId);

      if (!room)                   return send(ws, err('Room not found or expired'));
      if (Date.now() > room.expiresAt) { room.destroy(); return send(ws, err('Room has expired')); }
      if (room.type === 'private' && room.members.size >= 2 && !room.members.has(meta.userId))
      return send(ws, err('Private room is full (max 2 people)'));

      // Leave previous room cleanly
      if (meta.roomId && meta.roomId !== roomId) {
        const prev = rooms.get(meta.roomId);
        if (prev) {
          prev.members.delete(meta.userId);
          broadcastRoom(meta.roomId, { type: 'user_left', userId: meta.userId, username: meta.username, members: memberSnapshot(prev) }, ws);
        }
      }

      room.members.set(meta.userId, meta.username);
      meta.roomId = roomId;
      //console.log(`[JOIN] ${meta.username} → ${roomId}`);

      send(ws, {
        type:     'room_joined',
        room:     room.summary(),
        messages: room.messages.slice(-100),
      });

      broadcastRoom(roomId, {
        type:     'user_joined',
        userId:   meta.userId,
        username: meta.username,
        members:  memberSnapshot(room),
      }, ws);
      break;
    }

    // ─ SEND MESSAGE 
    case 'send_message': {
      if (!meta.userId || !meta.roomId) return send(ws, err('Not in a room'));
      const room = rooms.get(meta.roomId);
      if (!room) return send(ws, err('Room not found'));

      const text = (msg.text || '').trim().slice(0, 2000);
      if (!text) return;

      const message = {
        id:       Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        userId:   meta.userId,
        username: meta.username,
        text,
        time:     Date.now(),
      };
      room.messages.push(message);
      if (room.messages.length > 500) room.messages.shift();

      broadcastRoomAll(room.id, { type: 'new_message', roomId: room.id, message });
      break;
    }

    // ── LEAVE ROOM 
    case 'leave_room': {
      if (!meta.roomId) return;
      const room = rooms.get(meta.roomId);
      if (room) {
        room.members.delete(meta.userId);
        broadcastRoom(meta.roomId, { type: 'user_left', userId: meta.userId, username: meta.username, members: memberSnapshot(room) }, ws);
      }
      meta.roomId = null;
      send(ws, { type: 'left_room' });
      break;
    }

    // ── DELETE ROOM 
    case 'delete_room': {
      if (!meta.roomId) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;
      if (room.creator !== meta.userId) return send(ws, err('Only the creator can delete this room'));

      broadcastRoom(meta.roomId, { type: 'room_deleted', roomId: meta.roomId, name: room.name });
      room.destroy();
      meta.roomId = null;
      send(ws, { type: 'room_deleted', roomId: msg.roomId });
      //console.log(`[DELETE] ${msg.roomId} by ${meta.username}`);
      break;
    }

    // PING 
    case 'ping': {
      send(ws, { type: 'pong', time: Date.now() });
      break;
    }
  }
}

function err(message) { 
  return { type: 'error', message }; 
}
//  PERIODIC CLEANUP 
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room) => { if (now > room.expiresAt) room._expire(); });
}, 10 * 60 * 1000);

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

//  START
server.listen(PORT, () => {
  console.log(`PhantomChat running → http://localhost:${PORT}`);
  // console.log(`   WebSocket path : ws://localhost:${PORT}/ws`);
  // console.log(`   Health check: http://localhost:${PORT}/health\n`);
});
