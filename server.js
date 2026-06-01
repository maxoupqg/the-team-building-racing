'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { Room } = require('./game/Room');

const UNIQUE_SESSION   = true;
const UNIQUE_ROOM_CODE = 'MAIN';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports:    ['websocket'],
  pingInterval:  25000,
  pingTimeout:   20000,
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({ uniqueSession: UNIQUE_SESSION });
});

app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.GAME_CONFIG = ${JSON.stringify({ uniqueSession: UNIQUE_SESSION })};`);
});
// Expose shared game logic (seededRandom, ObstacleGenerator) to the browser
app.use('/shared', express.static(path.join(__dirname, 'game')));

// ── Room registry ────────────────────────────────────────────────────────────

/** @type {Map<string, Room>} */
const rooms = new Map();

if (UNIQUE_SESSION) {
  rooms.set(UNIQUE_ROOM_CODE, new Room(UNIQUE_ROOM_CODE, io));
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // omit I and O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function findRoomByPlayerId(socketId) {
  for (const room of rooms.values()) {
    if (room.hasPlayer(socketId)) return room;
  }
  return null;
}

// ── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.emit('server_config', { uniqueSession: UNIQUE_SESSION });

  // Create a new room
  socket.on('create_room', ({ playerName, playerColor }) => {
    if (UNIQUE_SESSION) {
      // In unique session mode, redirect to join MAIN
      const name  = String(playerName  || 'Player').slice(0, 16);
      const color = String(playerColor || '#ff0000');
      const room  = rooms.get(UNIQUE_ROOM_CODE);
      room.addPlayer(socket.id, name, color, room.players.size === 0);
      socket.join(UNIQUE_ROOM_CODE);
      room.emitRoomJoined(socket);
      return;
    }
    const name  = String(playerName  || 'Player').slice(0, 16);
    const color = String(playerColor || '#ff0000');
    const code  = generateCode();
    const room  = new Room(code, io);

    room.addPlayer(socket.id, name, color, true /* isHost */);
    rooms.set(code, room);

    socket.join(code);
    room.emitRoomCreated(socket);
    console.log(`[Room] Created ${code} by ${name}`);
  });

  // Join an existing room
  socket.on('join_room', ({ roomCode, playerName, playerColor }) => {
    const code  = UNIQUE_SESSION ? UNIQUE_ROOM_CODE : String(roomCode || '').toUpperCase().trim();
    const name  = String(playerName  || 'Player').slice(0, 16);
    const color = String(playerColor || '#0000ff');

    const room = rooms.get(code);
    if (!room) {
      socket.emit('error', { message: `Salle "${code}" introuvable.` });
      return;
    }
    if (!UNIQUE_SESSION && room.state !== 'lobby') {
      socket.emit('error', { message: 'La partie est déjà en cours.' });
      return;
    }

    const becomeHost = UNIQUE_SESSION && room.players.size === 0;
    room.addPlayer(socket.id, name, color, becomeHost);
    socket.join(code);
    room.emitRoomJoined(socket);
    console.log(`[Room] ${name} joined ${code}`);
  });

  // Player input
  socket.on('input', (input) => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.currentRace) return;
    room.currentRace.handleInput(socket.id, input);
  });

  // Host starts the race
  socket.on('start_race', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;
    if (!room.isHost(socket.id)) {
      socket.emit('error', { message: 'Seul le chef de partie peut lancer la course.' });
      return;
    }
    if (room.players.size < 1) {
      socket.emit('error', { message: 'Il faut au moins 1 joueur.' });
      return;
    }
    room.startRace();
  });

  // Host goes to next race
  socket.on('next_race', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.isHost(socket.id)) return;
    room.prepareNextRace();
  });

  // Host ends the session
  socket.on('end_session', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.isHost(socket.id)) return;
    const code = room.code;
    io.to(code).emit('session_end', { standings: room._standingsList(), uniqueSession: UNIQUE_SESSION });
    if (room.currentRace) room.currentRace.stop();
    if (!UNIQUE_SESSION) {
      rooms.delete(code);
    }
    console.log(`[Room] Session ended: ${code}`);
  });

  // Host resets the session (unique session mode only)
  socket.on('reset_session', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.isHost(socket.id)) return;
    room.reset();
    console.log(`[Room] Session reset: ${room.code}`);
  });

  // Ready toggle
  socket.on('toggle_ready', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;
    room.toggleReady(socket.id);
  });

  // Claim host when nobody is host
  socket.on('claim_host', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || room.hostId) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.isHost = true;
    room.hostId   = socket.id;
    room._emitLobbyUpdate();
    console.log(`[Room] ${player.name} claimed host in ${room.code}`);
  });

  // Host toggles power-ups (lobby only)
  socket.on('toggle_powerups', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.isHost(socket.id) || room.state !== 'lobby') return;
    room.togglePowerUps();
  });

  // Host toggles team mode (lobby only)
  socket.on('toggle_teams', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.isHost(socket.id) || room.state !== 'lobby') return;
    room.toggleTeamMode();
  });

  // Emoji reaction during race
  socket.on('reaction', ({ emoji }) => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || room.state !== 'racing') return;
    const ALLOWED = ['😱', '💀', '🔥'];
    if (!ALLOWED.includes(emoji)) return;
    io.to(room.code).emit('reaction', { playerId: socket.id, emoji });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;

    room.removePlayer(socket.id);
    if (room.isEmpty()) {
      if (UNIQUE_SESSION && room.code === UNIQUE_ROOM_CODE) {
        room.reset();
        console.log(`[Room] Auto-reset (empty): ${room.code}`);
      } else {
        if (room.currentRace) room.currentRace.stop();
        rooms.delete(room.code);
        console.log(`[Room] Destroyed (empty): ${room.code}`);
      }
    }
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Team Racing server running at http://localhost:${PORT}`);
});
