/* ════════════════════════════════════════════════════════════════════════════
   Team Racing — Client
   Vanilla JS, no imports, no framework, no build step.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

// ── Game constants (mirrored from server, overwritten by race_start) ─────────
let C = {
  TRACK_LENGTH:          10000,
  TRACK_WIDTH:           280,
  BASE_SPEED:            220,
  COMBO_SPEED_BONUS:     0.12,
  MAX_COMBO:             12,
  TICK_RATE:             20,
  MOVE_SPEED:            380,
  JUMP_DURATION:         600,
  SLIDE_DURATION:        500,
  ATTACK_DURATION:       280,
  OBSTACLE_WINDOW_START: 140,
  OBSTACLE_WINDOW_END:   60,
};

// ── Seeded RNG (Mulberry32 — must match server) ───────────────────────────────
function createRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Obstacle generator (must match server) ────────────────────────────────────
function generateObstacles(seed, trackLength) {
  const rng = createRNG(seed);
  const OBSTACLE_TYPES = ['log', 'barrier', 'wall_left', 'wall_right', 'crate'];
  const obstacles = [];
  let id = 0;
  const START_Y = 900;
  const END_Y   = trackLength - 700;
  let y = START_Y;
  while (y < END_Y) {
    const typeIndex = Math.floor(rng() * OBSTACLE_TYPES.length);
    const type = OBSTACLE_TYPES[typeIndex];
    let x = 0, width, cratePositions;
    // Spacing stays above window total (650) to prevent two obstacles in the same detection window
    const progress = Math.min(1, (y - START_Y) / (END_Y - START_Y));
    if (type === 'wall_left') {
      x = -70; width = Math.round(140 + progress * 80);
    } else if (type === 'wall_right') {
      x = 70;  width = Math.round(140 + progress * 80);
    } else if (type === 'crate') {
      let crateCount;
      if      (progress < 0.35) crateCount = 1;
      else if (progress < 0.65) crateCount = 2;
      else if (progress < 0.85) crateCount = 3;
      else                      crateCount = 5;
      if (crateCount === 1) {
        cratePositions = [{ x: (rng() * 120) - 60 }];
      } else if (crateCount === 2) {
        cratePositions = [{ x: -70 }, { x: 70 }];
      } else if (crateCount === 3) {
        cratePositions = [{ x: -100 }, { x: 0 }, { x: 100 }];
      } else {
        cratePositions = [{ x: -100 }, { x: -50 }, { x: 0 }, { x: 50 }, { x: 100 }];
      }
      x = 0;
    }
    obstacles.push({ id: id++, type, y, x, width, cratePositions });
    const minSpacing = 700;
    const maxSpacing = 1000 - progress * 200;
    y += minSpacing + rng() * (maxSpacing - minSpacing);
  }
  return obstacles;
}

// ── Canvas setup ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

const CANVAS_W        = 480;
const CANVAS_H        = 640;
const TRACK_LEFT      = 90;
const TRACK_RIGHT     = 390;
const TRACK_RENDER_W  = 300;  // TRACK_RIGHT - TRACK_LEFT
const TRACK_CENTER_X  = 240;
const PLAYER_RENDER_Y = 420;
const SIDEBAR_X_START = 440;
const SIDEBAR_X_END   = 465;
const SIDEBAR_Y_TOP   = 40;
const SIDEBAR_Y_BOT   = 590;
const SIDEBAR_H       = SIDEBAR_Y_BOT - SIDEBAR_Y_TOP;

// ── State ─────────────────────────────────────────────────────────────────────
let gameState = 'welcome';  // welcome | lobby | countdown | racing | results

let myPlayerId   = null;
let myRoomCode   = null;
let myColor      = '#e94560';
let myName       = '';
let isHost       = false;
let raceNumber   = 0;

// Racing state
let obstacles      = [];
let playerStates   = new Map();  // id -> { x, y, state, combo, speed, finished, progress, name, color }
let lastServerState = null;      // most recent game_state payload
let prevServerState = null;      // previous game_state payload
let lastServerTime  = 0;
let prevServerTime  = 0;
let rafId          = null;

// Input state
let input = { left: false, right: false, jump: false, slide: false, attack: false };
let prevInputJson = '';

// Finish notifications
let finishNotifications = [];  // { text, expiry }

// Screen shake
let shakeTimer    = 0;
let shakePrevCombo = 0;

// Floating emoji reactions
let floatingReactions = [];  // { emoji, name, color, playerId, spawnTime, duration }

// Auto-commentator
let commentatorMessages  = [];  // { text, color, expiry }
let commentPrevLeaderId  = null;
let commentPrevComboMap  = new Map();

// ── DOM helpers ───────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── Color picker ─────────────────────────────────────────────────────────────
const COLORS = [
  '#e94560', '#4c9be8', '#4caf50', '#ffd700', '#9c27b0',
  '#ff9800', '#f06292', '#00bcd4', '#eceff1', '#8bc34a',
];

(function initColorPicker() {
  const picker = document.getElementById('color-picker');
  COLORS.forEach(color => {
    const circle = document.createElement('div');
    circle.className = 'color-circle';
    circle.style.background = color;
    if (color === myColor) circle.classList.add('active');
    circle.addEventListener('click', () => {
      document.querySelectorAll('.color-circle').forEach(c => c.classList.remove('active'));
      circle.classList.add('active');
      myColor = color;
    });
    picker.appendChild(circle);
  });
  // Select first by default
  picker.querySelector('.color-circle').classList.add('active');
  myColor = COLORS[0];
})();

// ── Welcome screen ─────────────────────────────────────────────────────────────
document.getElementById('input-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

document.getElementById('btn-create').addEventListener('click', () => {
  myName = document.getElementById('input-name').value.trim();
  if (!myName) { showError('welcome-error', 'Entrez un pseudo.'); return; }
  socket.emit('create_room', { playerName: myName, playerColor: myColor });
});

document.getElementById('btn-join').addEventListener('click', () => {
  myName = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!myName) { showError('welcome-error', 'Entrez un pseudo.'); return; }
  if (code.length !== 4) { showError('welcome-error', 'Code de salle invalide (4 lettres).'); return; }
  socket.emit('join_room', { roomCode: code, playerName: myName, playerColor: myColor });
});

document.getElementById('input-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-create').click();
});

document.getElementById('input-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

// ── Lobby screen ───────────────────────────────────────────────────────────────
document.getElementById('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(myRoomCode).catch(() => {});
  document.getElementById('btn-copy-code').textContent = '✅';
  setTimeout(() => { document.getElementById('btn-copy-code').textContent = '📋'; }, 1500);
});

document.getElementById('btn-start-race').addEventListener('click', () => {
  socket.emit('start_race');
});

function renderLobby(players, hostId, standings, raceNum) {
  isHost = hostId === myPlayerId;
  raceNumber = raceNum || 0;

  document.getElementById('player-count').textContent = `(${players.length})`;

  const list = document.getElementById('player-list');
  list.innerHTML = '';
  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <div class="player-dot" style="background:${p.color}"></div>
      <span>${escapeHtml(p.name)}</span>
      ${p.id === hostId ? '<span class="player-crown">👑</span>' : ''}
    `;
    list.appendChild(card);
  });

  if (raceNumber > 0 && standings && standings.length > 0) {
    document.getElementById('standings-section').classList.remove('hidden');
    renderStandingsTable('standings-table', standings);
  } else {
    document.getElementById('standings-section').classList.add('hidden');
  }

  if (isHost) {
    document.getElementById('lobby-host-controls').classList.remove('hidden');
    document.getElementById('lobby-waiting-msg').classList.add('hidden');
  } else {
    document.getElementById('lobby-host-controls').classList.add('hidden');
    document.getElementById('lobby-waiting-msg').classList.remove('hidden');
  }
}

function renderStandingsTable(tableId, standings) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  standings.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.position}</td>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.color};margin-right:6px;vertical-align:middle"></span>${escapeHtml(s.name)}</td>
      <td><strong>${s.totalPoints}</strong></td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Results screen ─────────────────────────────────────────────────────────────
document.getElementById('btn-next-race').addEventListener('click', () => {
  socket.emit('next_race');
});
document.getElementById('btn-end-session').addEventListener('click', () => {
  socket.emit('end_session');
});
document.getElementById('btn-restart').addEventListener('click', () => {
  location.reload();
});

function renderResults(data) {
  document.getElementById('results-race-number').textContent = `Course #${data.raceNumber}`;

  // Podium
  const podiumEl = document.getElementById('podium');
  podiumEl.innerHTML = '';
  const trophies = ['🥇', '🥈', '🥉'];
  const podiumOrder = [2, 1, 3]; // display order: 2nd, 1st, 3rd
  podiumOrder.forEach(pos => {
    const r = data.results.find(x => x.position === pos);
    if (!r) return;
    const slot = document.createElement('div');
    slot.className = `podium-slot pos-${pos}`;
    slot.innerHTML = `
      <div class="podium-trophy">${trophies[pos - 1] || ''}</div>
      <div class="podium-name" style="color:${r.color}">${escapeHtml(r.name)}</div>
      <div class="podium-time">${formatTime(r.finishTime)}</div>
    `;
    podiumEl.appendChild(slot);
  });

  // Results table
  const rtbody = document.querySelector('#results-table tbody');
  rtbody.innerHTML = '';
  data.results.forEach(r => {
    const tr = document.createElement('tr');
    if (r.position <= 3) tr.classList.add(`pos-${r.position}`);
    tr.innerHTML = `
      <td>${r.position}</td>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${r.color};margin-right:6px;vertical-align:middle"></span>${escapeHtml(r.name)}</td>
      <td>${formatTime(r.finishTime)}</td>
      <td>${r.maxCombo > 0 ? `x${r.maxCombo}` : '-'}</td>
      <td>+${r.points}${r.comboBonus > 0 ? ` <span style="color:#f90">+${r.comboBonus}⚡</span>` : ''}${r.streakBonus > 0 ? ` <span style="color:#f44">+${r.streakBonus}🔥</span>` : ''}</td>
      <td><strong>${r.totalPoints}</strong></td>
    `;
    rtbody.appendChild(tr);
  });

  // Standings
  renderStandingsTable('results-standings-table', data.standings);

  if (isHost) {
    document.getElementById('results-host-controls').classList.remove('hidden');
    document.getElementById('results-waiting-msg').classList.add('hidden');
  } else {
    document.getElementById('results-host-controls').classList.add('hidden');
    document.getElementById('results-waiting-msg').classList.remove('hidden');
  }

  showScreen('screen-results');
}

// ── Countdown overlay ──────────────────────────────────────────────────────────
function showCountdown(count) {
  const overlay = document.getElementById('countdown-overlay');
  const text    = document.getElementById('countdown-text');
  overlay.classList.remove('hidden');
  text.textContent = count > 0 ? String(count) : 'GO!';
  // Restart animation
  text.style.animation = 'none';
  requestAnimationFrame(() => {
    text.style.animation = '';
    text.style.animation = 'countPop .5s ease-out';
  });
  if (count === 0) {
    setTimeout(() => overlay.classList.add('hidden'), 700);
  }
}

// ── Input handling ─────────────────────────────────────────────────────────────
const KEY_MAP = {
  ArrowLeft:  'left',
  ArrowRight: 'right',
  Space:      'jump',
  ArrowDown:  'slide',
  KeyZ:       'attack',
};

const REACTION_EMOJIS = { Digit1: '😱', Digit2: '💀', Digit3: '🔥' };

document.addEventListener('keydown', e => {
  if (gameState !== 'racing') return;

  // Reaction keys
  const emoji = REACTION_EMOJIS[e.code];
  if (emoji) { socket.emit('reaction', { emoji }); return; }

  const action = KEY_MAP[e.code];
  if (!action) return;
  if (['Space', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!input[action]) {
    input[action] = true;
    emitInput();
  }
});

document.addEventListener('keyup', e => {
  if (gameState !== 'racing') return;
  const action = KEY_MAP[e.code];
  if (!action) return;
  if (input[action]) {
    input[action] = false;
    emitInput();
  }
});

function emitInput() {
  const json = JSON.stringify(input);
  if (json !== prevInputJson) {
    socket.emit('input', { ...input });
    prevInputJson = json;
  }
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('room_created', (data) => {
  myPlayerId  = data.playerId;
  myRoomCode  = data.code;
  isHost      = true;
  document.getElementById('room-code-text').textContent = data.code;
  renderLobby(data.players, data.hostId, data.standings, data.raceNumber);
  showScreen('screen-lobby');
  gameState = 'lobby';
});

socket.on('room_joined', (data) => {
  myPlayerId = data.playerId;
  myRoomCode = data.code;
  document.getElementById('room-code-text').textContent = data.code;
  renderLobby(data.players, data.hostId, data.standings, data.raceNumber);
  showScreen('screen-lobby');
  gameState = 'lobby';
});

socket.on('lobby_update', (data) => {
  isHost = data.hostId === myPlayerId;
  renderLobby(data.players, data.hostId, data.standings, data.raceNumber);
  if (gameState === 'results') {
    gameState = 'lobby';
    showScreen('screen-lobby');
  }
});

socket.on('countdown', (data) => {
  showCountdown(data.count);
});

socket.on('race_start', (data) => {
  // Update constants from server
  if (data.constants) Object.assign(C, data.constants);

  // Regenerate obstacles client-side using same seed
  obstacles = generateObstacles(data.seed, data.trackLength || C.TRACK_LENGTH);

  // Initialize player states from server data
  playerStates = new Map();
  for (const p of data.players) {
    playerStates.set(p.id, {
      id:       p.id,
      name:     p.name,
      color:    p.color,
      x:        0,
      y:        0,
      state:    'running',
      combo:    0,
      speed:    C.BASE_SPEED,
      finished: false,
      progress: 0,
    });
  }

  // Reset input
  input = { left: false, right: false, jump: false, slide: false, attack: false };
  prevInputJson = '';
  lastServerState = null;
  prevServerState = null;
  finishNotifications  = [];
  commentatorMessages  = [];
  commentPrevLeaderId  = null;
  commentPrevComboMap  = new Map();
  floatingReactions    = [];
  shakeTimer           = 0;
  shakePrevCombo       = 0;

  // Show countdown GO then start rendering
  showCountdown(0);
  showScreen('screen-race');
  gameState = 'racing';

  // Start render loop
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(renderFrame);
});

socket.on('game_state', (data) => {
  prevServerState = lastServerState;
  prevServerTime  = lastServerTime;
  lastServerState = data;
  lastServerTime  = performance.now();

  // Update our player states map from server data
  for (const ps of data.players) {
    const existing = playerStates.get(ps.id);
    if (existing) {
      Object.assign(existing, ps);
    }
  }

  checkCommentatorEvents(data.players);
});

function checkCommentatorEvents(players) {
  if (!players || players.length < 1) return;

  const active = players.filter(p => !p.finished);
  if (active.length === 0) return;

  // Leader change
  const leader = active.reduce((a, b) => (a.progress > b.progress ? a : b));
  if (commentPrevLeaderId && leader.id !== commentPrevLeaderId) {
    addCommentary(`🏃 ${leader.name} prend la tête !`, leader.color);
  }
  commentPrevLeaderId = leader.id;

  // Combo milestones
  for (const p of players) {
    const prev = commentPrevComboMap.get(p.id) || 0;
    for (const m of [5, 10, 20, 30]) {
      if (p.combo >= m && prev < m) {
        addCommentary(`⚡ Combo ×${m} pour ${p.name} !`, p.color);
      }
    }
    commentPrevComboMap.set(p.id, p.combo);
  }
}

function addCommentary(text, color) {
  commentatorMessages.push({ text, color: color || '#fff', expiry: Date.now() + 4000 });
  if (commentatorMessages.length > 3) commentatorMessages.shift();
}

socket.on('player_finished', (data) => {
  const p = playerStates.get(data.playerId);
  const name = p ? p.name : data.playerId;
  const emoji = data.position === 1 ? '🥇' : data.position === 2 ? '🥈' : data.position === 3 ? '🥉' : `#${data.position}`;
  finishNotifications.push({
    text:   `${emoji} ${name} a terminé !`,
    expiry: Date.now() + 3000,
  });
});

socket.on('race_results', (data) => {
  gameState = 'results';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  raceNumber = data.raceNumber;
  renderResults(data);
});

socket.on('reaction', (data) => {
  const p = playerStates.get(data.playerId);
  if (!p) return;
  floatingReactions.push({
    emoji:     data.emoji,
    name:      p.name,
    color:     p.color,
    playerId:  data.playerId,
    spawnTime: Date.now(),
    duration:  2500,
  });
  if (floatingReactions.length > 20) floatingReactions.shift();
});

socket.on('player_left', (data) => {
  if (gameState === 'lobby') {
    // lobby_update will follow
  }
  if (data.newHostId === myPlayerId) {
    isHost = true;
  }
});

socket.on('session_end', (data) => {
  gameState = 'welcome';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  const tbody = document.querySelector('#session-end-table tbody');
  tbody.innerHTML = '';
  (data.standings || []).forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.position}</td>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.color};margin-right:6px;vertical-align:middle"></span>${escapeHtml(s.name)}</td>
      <td><strong>${s.totalPoints}</strong></td>
    `;
    tbody.appendChild(tr);
  });
  showScreen('screen-session-end');
});

socket.on('error', (data) => {
  const errId = gameState === 'lobby' ? 'lobby-error' : 'welcome-error';
  showError(errId, data.message);
});

socket.on('disconnect', () => {
  showError('welcome-error', 'Connexion perdue. Rechargez la page.');
  showScreen('screen-welcome');
  gameState = 'welcome';
});

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderFrame() {
  if (gameState !== 'racing') return;
  rafId = requestAnimationFrame(renderFrame);

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  const myPlayer = playerStates.get(myPlayerId);
  if (!myPlayer) return;

  // Interpolation factor
  let alpha = 0;
  if (prevServerState && lastServerState) {
    const elapsed = performance.now() - lastServerTime;
    const interval = lastServerTime - prevServerTime;
    alpha = interval > 0 ? Math.min(elapsed / interval, 1.5) : 1;
  }

  // Get interpolated states
  const interp = getInterpolatedStates(alpha);
  const myInterp = interp.get(myPlayerId) || myPlayer;

  // Detect miss (combo reset) → trigger screen shake
  const curCombo = myInterp.combo || 0;
  if (shakePrevCombo > 0 && curCombo === 0) shakeTimer = 350;
  shakePrevCombo = curCombo;
  shakeTimer = Math.max(0, shakeTimer - 16);

  // Draw world with shake translate
  ctx.save();
  if (shakeTimer > 0) {
    const decay = shakeTimer / 350;
    ctx.translate(
      (Math.random() - 0.5) * 10 * decay,
      (Math.random() - 0.5) * 10 * decay,
    );
  }
  drawBackground();
  drawTrack();
  drawLaneLines();
  drawObstacles(myInterp);
  drawFinishLine(myInterp);
  drawGhostPlayers(interp, myInterp);
  drawMyPlayer(myInterp);
  ctx.restore();

  // Red flash overlay (outside shake so it's stable)
  if (shakeTimer > 0) {
    ctx.save();
    ctx.globalAlpha = (shakeTimer / 350) * 0.28;
    ctx.fillStyle = '#ff1744';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();
  }

  drawHUD(myInterp);
  drawCommentator();
  drawProgressBar(interp);
  drawFloatingReactions(interp, myInterp);
  drawFinishNotifications();
}

function getInterpolatedStates(alpha) {
  const result = new Map();
  for (const [id, cur] of playerStates) {
    if (!prevServerState) {
      result.set(id, { ...cur });
      continue;
    }
    const prev = prevServerState.players.find(p => p.id === id);
    if (!prev) {
      result.set(id, { ...cur });
      continue;
    }
    result.set(id, {
      ...cur,
      x: lerp(prev.x, cur.x, alpha),
      y: lerp(prev.y, cur.y, alpha),
    });
  }
  return result;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function drawBackground() {
  // Dark green outside track
  ctx.fillStyle = '#2d5a1b';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

function drawTrack() {
  ctx.fillStyle = '#333';
  ctx.fillRect(TRACK_LEFT, 0, TRACK_RENDER_W, CANVAS_H);
}

function drawLaneLines() {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([20, 18]);
  // Left lane divider at track x=165 (canvas)
  ctx.beginPath();
  ctx.moveTo(165, 0); ctx.lineTo(165, CANVAS_H);
  ctx.stroke();
  // Right lane divider at track x=315 (canvas)
  ctx.beginPath();
  ctx.moveTo(315, 0); ctx.lineTo(315, CANVAS_H);
  ctx.stroke();
  ctx.restore();
}

function drawFinishLine(myInterp) {
  const trackLength = C.TRACK_LENGTH;
  const canvasY = PLAYER_RENDER_Y - (trackLength - myInterp.y);
  if (canvasY < -20 || canvasY > CANVAS_H + 20) return;

  // Checkered banner (8 squares wide, 2 rows)
  const squareW = TRACK_RENDER_W / 8;
  const squareH = 18;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 8; col++) {
      const dark = (row + col) % 2 === 0;
      ctx.fillStyle = dark ? '#111' : '#fff';
      ctx.fillRect(TRACK_LEFT + col * squareW, canvasY - squareH + row * squareH, squareW, squareH);
    }
  }

  // Bright horizontal line below the banner
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(TRACK_LEFT, canvasY + squareH);
  ctx.lineTo(TRACK_RIGHT, canvasY + squareH);
  ctx.stroke();

  // "ARRIVÉE" label above
  ctx.save();
  ctx.font = 'bold 16px monospace';
  ctx.fillStyle = '#FFD700';
  ctx.textAlign = 'center';
  ctx.fillText('ARRIVÉE', TRACK_CENTER_X, canvasY - squareH - 6);
  ctx.restore();
}

function drawObstacles(myInterp) {
  for (const obs of obstacles) {
    const canvasY = PLAYER_RENDER_Y - (obs.y - myInterp.y);
    if (canvasY < -100 || canvasY > 700) continue;
    const canvasX = TRACK_CENTER_X + obs.x;
    drawObstacle(obs, canvasX, canvasY);
    drawObstacleHint(obs, canvasY);
  }
}

function drawObstacle(obs, cx, cy) {
  ctx.save();
  switch (obs.type) {
    case 'log': {
      // Full track width brown rectangle, height 25px
      ctx.fillStyle = '#8B4513';
      ctx.fillRect(TRACK_LEFT, cy - 12, TRACK_RENDER_W, 25);
      // Wood grain lines
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1.5;
      for (let lx = TRACK_LEFT + 20; lx < TRACK_RIGHT; lx += 35) {
        ctx.beginPath();
        ctx.moveTo(lx, cy - 11);
        ctx.lineTo(lx, cy + 13);
        ctx.stroke();
      }
      break;
    }
    case 'barrier': {
      // Gray rectangle with red stripes, low (player slides under)
      const bh = 18;
      ctx.fillStyle = '#888';
      ctx.fillRect(TRACK_LEFT, cy - bh / 2, TRACK_RENDER_W, bh);
      // Red diagonal stripes
      ctx.strokeStyle = '#e53935';
      ctx.lineWidth = 3;
      for (let sx = TRACK_LEFT - 10; sx < TRACK_RIGHT + 10; sx += 22) {
        ctx.beginPath();
        ctx.moveTo(sx, cy - bh / 2);
        ctx.lineTo(sx + bh, cy + bh / 2);
        ctx.stroke();
      }
      break;
    }
    case 'wall_left': {
      const w = obs.width || 140;
      ctx.fillStyle = '#8B0000';
      ctx.fillRect(TRACK_LEFT, cy - 40, w, 80);
      ctx.strokeStyle = '#ff1744';
      ctx.lineWidth = 2;
      ctx.strokeRect(TRACK_LEFT, cy - 40, w, 80);
      break;
    }
    case 'wall_right': {
      const w = obs.width || 140;
      ctx.fillStyle = '#8B0000';
      ctx.fillRect(TRACK_RIGHT - w, cy - 40, w, 80);
      ctx.strokeStyle = '#ff1744';
      ctx.lineWidth = 2;
      ctx.strokeRect(TRACK_RIGHT - w, cy - 40, w, 80);
      break;
    }
    case 'crate': {
      const positions = obs.cratePositions || [{ x: obs.x }];
      positions.forEach(cp => {
        const ccx = TRACK_CENTER_X + cp.x;
        ctx.fillStyle = '#A0522D';
        ctx.fillRect(ccx - 25, cy - 25, 50, 50);
        ctx.strokeStyle = '#5D2E0C';
        ctx.lineWidth = 2;
        ctx.strokeRect(ccx - 25, cy - 25, 50, 50);
        ctx.beginPath();
        ctx.moveTo(ccx - 20, cy - 20); ctx.lineTo(ccx + 20, cy + 20);
        ctx.moveTo(ccx + 20, cy - 20); ctx.lineTo(ccx - 20, cy + 20);
        ctx.stroke();
      });
      break;
    }
  }
  ctx.restore();
}

function drawGhostPlayers(interp, myInterp) {
  for (const [id, p] of interp) {
    if (id === myPlayerId) continue;
    const canvasY = PLAYER_RENDER_Y - (p.y - myInterp.y);
    if (canvasY < -40 || canvasY > 680) continue;
    const canvasX = TRACK_CENTER_X + p.x;

    ctx.save();
    ctx.globalAlpha = 0.55;
    // Shadow
    ctx.beginPath();
    ctx.ellipse(canvasX, canvasY + 16, 13, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();
    // Body
    ctx.beginPath();
    ctx.arc(canvasX, canvasY, 16, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    // Name
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillStyle = p.color;
    ctx.textAlign = 'center';
    ctx.fillText(p.name, canvasX, canvasY - 22);
    // State icon
    const stateIcon = stateToIcon(p.state);
    if (stateIcon) {
      ctx.font = '13px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(stateIcon, canvasX, canvasY + 5);
    }
    ctx.restore();
  }
}

function drawMyPlayer(p) {
  const cx = TRACK_CENTER_X + p.x;
  const cy = PLAYER_RENDER_Y;

  ctx.save();
  // Shadow
  ctx.beginPath();
  ctx.ellipse(cx, cy + 18, 15, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();

  // Body
  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, Math.PI * 2);
  ctx.fillStyle = p.color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // State icon inside
  const icon = stateToIcon(p.state);
  if (icon) {
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(icon, cx, cy);
  }
  ctx.textBaseline = 'alphabetic';

  // Name above
  ctx.font = 'bold 13px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, cx, cy - 26);

  ctx.restore();
}

function stateToIcon(state) {
  if (state === 'jumping')   return '↑';
  if (state === 'sliding')   return '↓';
  if (state === 'attacking') return '✕';
  return null;
}

function drawHUD(myInterp) {
  ctx.save();
  ctx.font = 'bold 14px Inter, system-ui, sans-serif';

  // Top-left: combo
  const combo = myInterp.combo || 0;
  ctx.fillStyle = combo > 0 ? '#ff9800' : '#666';
  ctx.textAlign = 'left';
  ctx.fillText(`COMBO x${combo}`, 8, 22);

  // Top-center: speed
  const speed = myInterp.speed || C.BASE_SPEED;
  ctx.fillStyle = '#eaeaea';
  ctx.textAlign = 'center';
  ctx.fillText(`⚡ ${Math.round(speed)} u/s`, CANVAS_W / 2, 22);

  // Top-right: progress
  const progress = myInterp.progress || 0;
  ctx.fillStyle = '#4caf50';
  ctx.textAlign = 'right';
  ctx.fillText(`🏁 ${(progress * 100).toFixed(1)}%`, CANVAS_W - SIDEBAR_X_END - 10, 22);

  // Bottom-left: key hints
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  ctx.fillText('[←→] Esquiver', 8, CANVAS_H - 59);
  ctx.fillText('[Espace] Sauter', 8, CANVAS_H - 44);
  ctx.fillText('[↓] Glisser   [Z] Détruire', 8, CANVAS_H - 29);
  ctx.fillText('[1] 😱  [2] 💀  [3] 🔥', 8, CANVAS_H - 14);

  ctx.restore();
}

function drawProgressBar(interp) {
  const bx = SIDEBAR_X_START;
  const bw = SIDEBAR_X_END - SIDEBAR_X_START;

  ctx.save();

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(bx - 2, SIDEBAR_Y_TOP - 5, bw + 4, SIDEBAR_H + 10);
  ctx.fillStyle = '#444';
  ctx.fillRect(bx, SIDEBAR_Y_TOP, bw, SIDEBAR_H);

  // Finish line at top
  ctx.fillStyle = '#4caf50';
  ctx.fillRect(bx - 4, SIDEBAR_Y_TOP, bw + 8, 4);

  // Sort players by progress for label overlap avoidance
  const sorted = [...interp.values()].sort((a, b) => (b.progress || 0) - (a.progress || 0));

  sorted.forEach((p, idx) => {
    const prog  = Math.min(p.progress || 0, 1);
    const dotY  = SIDEBAR_Y_TOP + (1 - prog) * SIDEBAR_H;
    const isMine = p.id === myPlayerId;
    const r = isMine ? 9 : 7;

    // Dot
    ctx.beginPath();
    ctx.arc(bx + bw / 2, dotY, r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    if (isMine) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Label (show top 5 or own)
    if (idx < 5 || isMine) {
      ctx.font = '9px Inter, system-ui, sans-serif';
      ctx.fillStyle = p.color;
      ctx.textAlign = 'right';
      ctx.fillText(p.name.slice(0, 8), bx - 4, dotY + 3);
    }
  });

  ctx.restore();
}

const OBSTACLE_HINTS = {
  log:        { label: '↑ SAUTER',   color: '#4fc3f7' },
  barrier:    { label: '↓ GLISSER',  color: '#81c784' },
  wall_left:  { label: '→ DROITE',   color: '#ff8a65' },
  wall_right: { label: '← GAUCHE',   color: '#ff8a65' },
  crate:      { label: 'Z DÉTRUIRE', color: '#ffd54f' },
};

function drawObstacleHint(obs, cy) {
  const hint = OBSTACLE_HINTS[obs.type];
  if (!hint) return;

  const distToPlayer = PLAYER_RENDER_Y - cy;
  if (distToPlayer < -30 || distToPlayer > 420) return;

  // Fade in between 420 and 280px away, fully visible below 280
  const alpha = distToPlayer > 280 ? 1 - (distToPlayer - 280) / 140 : 1;
  if (alpha <= 0) return;

  // For crates show hint centered; for walls show on track center
  const hintX = TRACK_CENTER_X;
  const hintY = cy - 52;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = 'bold 12px monospace';
  const tw = ctx.measureText(hint.label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(hintX - tw / 2 - 6, hintY - 13, tw + 12, 18);
  ctx.fillStyle = hint.color;
  ctx.textAlign = 'center';
  ctx.fillText(hint.label, hintX, hintY);
  ctx.restore();
}

function drawCommentator() {
  const now = Date.now();
  commentatorMessages = commentatorMessages.filter(m => m.expiry > now);
  if (commentatorMessages.length === 0) return;

  ctx.save();
  ctx.font = 'bold 13px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';

  commentatorMessages.forEach((m, i) => {
    const remaining = (m.expiry - now) / 4000;
    const alpha = remaining < 0.2 ? remaining / 0.2 : 1;
    const y = 50 + i * 26;
    const tw = ctx.measureText(m.text).width;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(TRACK_CENTER_X - tw / 2 - 8, y - 14, tw + 16, 20);
    ctx.fillStyle = m.color;
    ctx.fillText(m.text, TRACK_CENTER_X, y);
  });
  ctx.restore();
}

function drawFloatingReactions(interp, myInterp) {
  const now = Date.now();
  floatingReactions = floatingReactions.filter(r => (now - r.spawnTime) < r.duration);

  ctx.save();
  for (const r of floatingReactions) {
    const age   = (now - r.spawnTime) / r.duration; // 0→1
    const alpha = age < 0.7 ? 1 : 1 - (age - 0.7) / 0.3;

    const p = r.playerId === myPlayerId ? myInterp : interp.get(r.playerId);
    if (!p) continue;

    const canvasX = TRACK_CENTER_X + (p.x || 0);
    const baseY   = r.playerId === myPlayerId
      ? PLAYER_RENDER_Y
      : PLAYER_RENDER_Y - ((p.y || 0) - (myInterp.y || 0));
    const floatY  = baseY - 40 - age * 90;

    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = '28px serif';
    ctx.textAlign = 'center';
    ctx.fillText(r.emoji, canvasX, floatY);

    ctx.font = 'bold 10px Inter, system-ui, sans-serif';
    ctx.fillStyle = r.color;
    ctx.fillText(r.name.slice(0, 8), canvasX, floatY + 16);
  }
  ctx.restore();
}

function drawFinishNotifications() {
  const now = Date.now();
  // Purge expired
  finishNotifications = finishNotifications.filter(n => n.expiry > now);

  ctx.save();
  ctx.font = 'bold 14px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  finishNotifications.forEach((n, i) => {
    const age    = (n.expiry - now) / 3000;
    const alpha  = Math.min(age * 3, 1);
    const y      = CANVAS_H - 90 - i * 28;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(TRACK_CENTER_X - 120, y - 16, 240, 22);
    ctx.fillStyle = '#fff';
    ctx.fillText(n.text, TRACK_CENTER_X, y);
  });
  ctx.restore();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatTime(ms) {
  if (ms == null) return 'DNF';
  const s  = Math.floor(ms / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const m  = Math.floor(s / 60);
  const ss = s % 60;
  if (m > 0) return `${m}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  return `${ss}.${String(cs).padStart(2, '0')}s`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
