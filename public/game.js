/* ════════════════════════════════════════════════════════════════════════════
   Team Racing — Client
   Vanilla JS, no imports, no framework, no build step.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Socket ───────────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket'] });

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
const OBSTACLE_TYPES = ['log', 'barrier', 'wall_left', 'wall_right', 'crate'];
const OBS_PHASE1B = 0.15;
const OBS_PHASE2  = 0.30;
const OBS_PHASE3  = 0.72;
const OBS_W1A = [0.50, 0.50, 0,    0,    0   ];
const OBS_W1B = [0.30, 0.30, 0.10, 0.10, 0.20];
const OBS_W2  = [0.22, 0.22, 0.18, 0.18, 0.20];
const OBS_W3  = [0.12, 0.12, 0.25, 0.25, 0.26];

function weightedPick(rng, weights) {
  const r = rng();
  let cum = 0;
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i];
    if (r < cum) return i;
  }
  return weights.length - 1;
}

function generateObstacles(seed, trackLength) {
  const rng = createRNG(seed);
  const obstacles = [];
  let id = 0;
  const START_Y = 900;
  const END_Y   = trackLength - 700;
  let y = START_Y;
  while (y < END_Y) {
    const progress = Math.min(1, (y - START_Y) / (END_Y - START_Y));
    let weights, minSpacing, maxSpacing;
    if (progress < OBS_PHASE1B) {
      weights = OBS_W1A; minSpacing = 950; maxSpacing = 1300;
    } else if (progress < OBS_PHASE2) {
      weights = OBS_W1B; minSpacing = 850; maxSpacing = 1150;
    } else if (progress < OBS_PHASE3) {
      weights = OBS_W2;  minSpacing = 700; maxSpacing = 1000;
    } else {
      weights = OBS_W3;  minSpacing = 550; maxSpacing = 720;
    }
    const type = OBSTACLE_TYPES[weightedPick(rng, weights)];
    let x = 0, width, cratePositions;
    if (type === 'wall_left') {
      x = -70; width = progress < OBS_PHASE2 ? 140 : Math.round(140 + progress * 80);
    } else if (type === 'wall_right') {
      x = 70;  width = progress < OBS_PHASE2 ? 140 : Math.round(140 + progress * 80);
    } else if (type === 'crate') {
      let crateCount;
      if      (progress < OBS_PHASE2)        crateCount = 1;
      else if (progress < OBS_PHASE3)        crateCount = 2;
      else if (progress < 0.88)              crateCount = 3;
      else                                   crateCount = 5;
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
let obstacles        = [];
let playerStates     = new Map();   // id -> { x, y, state, combo, speed, finished, progress, name, color }
let playerIndexMap   = new Map();   // short index -> socket id
let rafId            = null;

// Render buffer — store last N server states with server timestamps
// Rendering happens RENDER_DELAY ms behind the server stream to absorb jitter
const RENDER_DELAY   = 65;   // ms behind server
const BUFFER_SIZE    = 45;   // ~1.5s at 30Hz
let stateBuffer      = [];   // [{ t: serverMs, states: Map<id,{x,y,...}> }]
let clockOffset      = 0;    // running estimate of (performance.now() - serverTime)
let clockSamples     = 0;

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

// Combo particles
let comboParticles        = [];  // { x, y, vx, vy, life, color, size }
let particlePrevCombo     = 0;

// Power-ups
let visiblePowerUps       = new Map(); // id -> pu, unlocked by server per-player
let powerUpsEnabled       = false;

// Teams
let teamMode              = false;
let currentTeams          = [];  // [{ id, name, color, playerIds, members }]

// ── Sound engine (Web Audio API — no files) ───────────────────────────────────
let _audioCtx = null;

function _audio() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function _tone(freq, type, duration, peak = 0.3, delay = 0) {
  try {
    const ctx = _audio();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(0, ctx.currentTime + delay);
    gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration + 0.05);
  } catch (_) {}
}

function _sweep(freqStart, freqEnd, type, duration, peak = 0.25) {
  try {
    const ctx = _audio();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, ctx.currentTime + duration);
    gain.gain.setValueAtTime(peak, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration + 0.05);
  } catch (_) {}
}

function _noise(duration, filterFreq = 800, peak = 0.2) {
  try {
    const ctx    = _audio();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data   = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src    = ctx.createBufferSource();
    src.buffer   = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type  = 'bandpass';
    filter.frequency.value = filterFreq;
    const gain   = ctx.createGain();
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(peak, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    src.start(); src.stop(ctx.currentTime + duration + 0.05);
  } catch (_) {}
}

function soundCountdown(n) {
  if (n > 0) {
    _tone(440 + (3 - n) * 110, 'sine', 0.12, 0.35);
  } else {
    // GO — accord do-mi-sol
    _tone(523, 'sine', 0.5, 0.3, 0);
    _tone(659, 'sine', 0.5, 0.2, 0.04);
    _tone(784, 'sine', 0.6, 0.25, 0.08);
  }
}

function soundJump()   { _sweep(220, 660, 'sine', 0.09, 0.2); }
function soundSlide()  { _sweep(500, 180, 'sine', 0.11, 0.18); }
function soundAttack() { _noise(0.06, 600, 0.3); _tone(120, 'square', 0.06, 0.15); }

function soundComboTick(combo) {
  const freq = Math.min(400 + combo * 35, 1200);
  _tone(freq, 'sine', 0.05, 0.18);
}

function soundComboMiss() {
  _tone(90, 'square', 0.18, 0.22);
  _sweep(200, 80, 'sawtooth', 0.15, 0.1);
}

function soundPowerUp() {
  // Arpège montant do-mi-sol
  _tone(523, 'sine', 0.08, 0.25, 0);
  _tone(659, 'sine', 0.08, 0.25, 0.07);
  _tone(784, 'sine', 0.18, 0.3,  0.14);
}

function soundFinishMe() {
  _tone(523, 'sine', 0.6, 0.3,  0);
  _tone(659, 'sine', 0.6, 0.25, 0.06);
  _tone(784, 'sine', 0.8, 0.3,  0.12);
  _tone(1046,'sine', 0.9, 0.2,  0.22);
}

function soundFinishOther() {
  _tone(880, 'sine', 0.25, 0.15);
}

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

document.getElementById('btn-toggle-powerups').addEventListener('click', () => {
  if (!isHost) return;
  socket.emit('toggle_powerups');
});

document.getElementById('btn-toggle-teams').addEventListener('click', () => {
  if (!isHost) return;
  socket.emit('toggle_teams');
});

function renderLobby(players, hostId, standings, raceNum, puEnabled, teams, tmMode) {
  isHost = hostId === myPlayerId;
  raceNumber = raceNum || 0;
  powerUpsEnabled = !!puEnabled;
  teamMode = !!tmMode;
  currentTeams = teams || [];

  const btnPU = document.getElementById('btn-toggle-powerups');
  btnPU.textContent  = powerUpsEnabled ? '⚡ Activés' : '⚡ Désactivés';
  btnPU.classList.toggle('active', powerUpsEnabled);
  btnPU.disabled = !isHost;

  const btnTM = document.getElementById('btn-toggle-teams');
  btnTM.textContent = teamMode ? '👥 Équipes on' : '👥 Équipes off';
  btnTM.classList.toggle('active', teamMode);
  btnTM.disabled = !isHost;

  document.getElementById('player-count').textContent = `(${players.length})`;

  const list = document.getElementById('player-list');
  list.innerHTML = '';

  if (teamMode && currentTeams.length >= 2) {
    // Group players by team
    currentTeams.forEach(team => {
      const teamPlayers = players.filter(p => team.playerIds.includes(p.id));
      teamPlayers.forEach(p => {
        const card = document.createElement('div');
        card.className = 'player-card';
        card.innerHTML = `
          <div class="player-dot" style="background:${p.color}"></div>
          <span>${escapeHtml(p.name)}</span>
          ${p.id === hostId ? '<span class="player-crown">👑</span>' : ''}
          <span class="team-label" style="background:${team.color}22;color:${team.color};border:1px solid ${team.color}55">${escapeHtml(team.name)}</span>
        `;
        list.appendChild(card);
      });
    });
    // Players not yet in any team (< 4 players or rounding)
    const assignedIds = new Set(currentTeams.flatMap(t => t.playerIds));
    players.filter(p => !assignedIds.has(p.id)).forEach(p => {
      const card = document.createElement('div');
      card.className = 'player-card';
      card.innerHTML = `
        <div class="player-dot" style="background:${p.color}"></div>
        <span>${escapeHtml(p.name)}</span>
        ${p.id === hostId ? '<span class="player-crown">👑</span>' : ''}
      `;
      list.appendChild(card);
    });
  } else {
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
  }

  if (teamMode && players.length < 4) {
    const note = document.createElement('div');
    note.style.cssText = 'text-align:center;color:#8892a4;font-size:.8rem;margin-top:.25rem';
    note.textContent = 'Il faut au moins 4 joueurs pour former des équipes.';
    list.appendChild(note);
  }

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
      <td>${formatPowerUpCounts(r.powerUpCounts)}</td>
      <td>+${r.points}${r.comboBonus > 0 ? ` <span style="color:#f90">+${r.comboBonus}⚡</span>` : ''}${r.streakBonus > 0 ? ` <span style="color:#f44">+${r.streakBonus}🔥</span>` : ''}</td>
      <td><strong>${r.totalPoints}</strong></td>
    `;
    rtbody.appendChild(tr);
  });

  // Team results
  const teamSection = document.getElementById('team-results-section');
  if (data.teamResults && data.teamResults.length > 0) {
    teamSection.classList.remove('hidden');
    const ttbody = document.querySelector('#team-results-table tbody');
    ttbody.innerHTML = '';
    data.teamResults.forEach((team, i) => {
      const memberNames = team.members.map(m => escapeHtml(m.name)).join(', ');
      const tr = document.createElement('tr');
      tr.className = `team-row-${team.id + 1}`;
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td><span class="team-badge" style="background:${team.color}"></span><strong style="color:${team.color}">${escapeHtml(team.name)}</strong></td>
        <td style="color:var(--text-dim);font-size:.82rem">${memberNames}</td>
        <td><strong>${team.score}</strong></td>
      `;
      ttbody.appendChild(tr);
    });
  } else {
    teamSection.classList.add('hidden');
  }

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
    if (action === 'jump')   soundJump();
    if (action === 'slide')  soundSlide();
    if (action === 'attack') soundAttack();
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
  renderLobby(data.players, data.hostId, data.standings, data.raceNumber, data.powerUpsEnabled, data.teams, data.teamMode);
  generateQRCode(data.code);
  showScreen('screen-lobby');
  gameState = 'lobby';
});

socket.on('room_joined', (data) => {
  myPlayerId = data.playerId;
  myRoomCode = data.code;
  document.getElementById('room-code-text').textContent = data.code;
  renderLobby(data.players, data.hostId, data.standings, data.raceNumber, data.powerUpsEnabled, data.teams, data.teamMode);
  generateQRCode(data.code);
  showScreen('screen-lobby');
  gameState = 'lobby';
});

socket.on('lobby_update', (data) => {
  isHost = data.hostId === myPlayerId;
  renderLobby(data.players, data.hostId, data.standings, data.raceNumber, data.powerUpsEnabled, data.teams, data.teamMode);
  if (gameState === 'results') {
    gameState = 'lobby';
    showScreen('screen-lobby');
  }
});

socket.on('countdown', (data) => {
  soundCountdown(data.count);
  showCountdown(data.count);
});

socket.on('race_start', (data) => {
  // Update constants from server
  if (data.constants) Object.assign(C, data.constants);

  // Regenerate obstacles client-side using same seed
  obstacles = generateObstacles(data.seed, data.trackLength || C.TRACK_LENGTH);

  // Initialize player states and index map from server data
  playerStates   = new Map();
  playerIndexMap = new Map();
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
    if (p.i !== undefined) playerIndexMap.set(p.i, p.id);
  }

  // Reset input
  input = { left: false, right: false, jump: false, slide: false, attack: false };
  prevInputJson = '';
  stateBuffer  = [];
  clockOffset  = 0;
  clockSamples = 0;
  finishNotifications  = [];
  commentatorMessages  = [];
  commentPrevLeaderId  = null;
  commentPrevComboMap  = new Map();
  floatingReactions    = [];
  shakeTimer           = 0;
  shakePrevCombo       = 0;
  comboParticles       = [];
  particlePrevCombo    = 0;
  visiblePowerUps      = new Map();

  // Show countdown GO then start rendering
  soundCountdown(0);
  showCountdown(0);
  showScreen('screen-race');
  gameState = 'racing';

  // Start render loop
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(renderFrame);
});

const STATE_NAMES = ['running', 'jumping', 'sliding', 'attacking'];

socket.on('game_state', (data) => {
  // Update server→client clock offset estimate (running average, stabilises after ~20 samples)
  clockSamples++;
  const sample = performance.now() - data.t;
  clockOffset += (sample - clockOffset) / Math.min(clockSamples, 20);

  // Parse compact rows and build a snapshot for this tick
  const myPrevCombo = playerStates.get(myPlayerId)?.combo ?? 0;
  const snap = new Map();

  for (const row of data.p) {
    const id = playerIndexMap.get(row[0]);
    if (!id) continue;
    const s = {
      x: row[1], y: row[2],
      state:      STATE_NAMES[row[3]] || 'running',
      combo:      row[4],
      maxCombo:   row[5],
      speed:      row[6],
      progress:   row[7] / 10000,
      boostTimer: row[8],
      shielded:   row[9] === 1,
      slowTimer:  row[10],
    };
    snap.set(id, s);
    // Keep playerStates up to date for sounds / events
    const p = playerStates.get(id);
    if (p) Object.assign(p, s);
  }

  // Push snapshot into render buffer
  stateBuffer.push({ t: data.t, states: snap });
  if (stateBuffer.length > BUFFER_SIZE) stateBuffer.shift();

  // Combo sounds
  const myNowCombo = playerStates.get(myPlayerId)?.combo ?? 0;
  if (myNowCombo > myPrevCombo)                  soundComboTick(myNowCombo);
  else if (myPrevCombo > 0 && myNowCombo === 0)  soundComboMiss();

  checkCommentatorEvents([...playerStates.values()]);
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
  if (p) { p.finished = true; p.progress = 1; }
  if (data.playerId === myPlayerId) soundFinishMe();
  else soundFinishOther();
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

socket.on('powerup_unlocked', (data) => {
  visiblePowerUps.set(data.pu.id, data.pu);
});

socket.on('powerup_locked', (data) => {
  visiblePowerUps.delete(data.puId);
});

socket.on('powerup_taken', (data) => {
  visiblePowerUps.delete(data.puId);
  if (data.playerId === myPlayerId) {
    soundPowerUp();
    const labels = { boost: '🚀 Boost !', shield: '🛡️ Bouclier !', bomb: '💣 Bombe lancée !' };
    finishNotifications.push({
      text:   labels[data.type] || '⭐ Power-up !',
      expiry: Date.now() + 2500,
    });
  }
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

  const interp = getBufferedStates();
  const myInterp = interp.get(myPlayerId) || myPlayer;

  // Detect miss (combo reset) → trigger screen shake
  const curCombo = myInterp.combo || 0;
  if (shakePrevCombo > 0 && curCombo === 0) shakeTimer = 350;
  shakePrevCombo = curCombo;

  // Detect combo increase → spawn particles
  if (curCombo > particlePrevCombo) {
    spawnComboParticles(TRACK_CENTER_X + (myInterp.x || 0), PLAYER_RENDER_Y, curCombo);
  }
  particlePrevCombo = curCombo;
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
  drawTrack(myInterp);
  drawLaneLines();
  drawObstacles(myInterp);
  drawPowerUps(myInterp);
  drawFinishLine(myInterp);
  // Rubber-band amount (mirrors server formula)
  const _leaderProg = Math.max(...[...interp.values()].map(p => p.progress || 0));
  const _rbGap      = Math.max(0, _leaderProg - (myInterp.progress || 0));
  const rb          = Math.min(_rbGap * 0.3, 0.3);  // 0 → 0.30

  drawGhostPlayers(interp, myInterp);
  drawMyPlayer(myInterp, rb);
  drawComboParticles();
  ctx.restore();

  // Red flash overlay (outside shake so it's stable)
  if (shakeTimer > 0) {
    ctx.save();
    ctx.globalAlpha = (shakeTimer / 350) * 0.28;
    ctx.fillStyle = '#ff1744';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();
  }

  drawHUD(myInterp, rb);
  drawCommentator();
  drawProgressBar(interp);
  drawFloatingReactions(interp, myInterp);
  drawFinishNotifications();
}

function getBufferedStates() {
  // Target: server time we want to render = serverNow - RENDER_DELAY
  const renderT = performance.now() - clockOffset - RENDER_DELAY;

  // Need at least 2 snapshots to interpolate
  if (stateBuffer.length < 2) {
    return new Map([...playerStates].map(([id, p]) => [id, { ...p }]));
  }

  // Find the two snapshots bracketing renderT
  let lo = 0;
  for (let i = 1; i < stateBuffer.length; i++) {
    if (stateBuffer[i].t <= renderT) lo = i;
    else break;
  }
  const hi = Math.min(lo + 1, stateBuffer.length - 1);
  const a  = stateBuffer[lo];
  const b  = stateBuffer[hi];

  const alpha = (a === b || b.t === a.t) ? 1
    : Math.max(0, Math.min(1, (renderT - a.t) / (b.t - a.t)));

  const result = new Map();
  for (const [id, cur] of playerStates) {
    const sa = a.states.get(id);
    const sb = b.states.get(id);
    if (!sa || !sb) {
      result.set(id, { ...cur, ...(sb || sa || {}) });
    } else {
      result.set(id, {
        ...cur, ...sb,
        x: lerp(sa.x, sb.x, alpha),
        y: lerp(sa.y, sb.y, alpha),
      });
    }
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

function drawTrack(myInterp) {
  // Base track
  ctx.fillStyle = '#333';
  ctx.fillRect(TRACK_LEFT, 0, TRACK_RENDER_W, CANVAS_H);

  // Phase color overlays — boundaries derived from same constants as obstacle generator
  const START_Y  = 900;
  const END_Y    = C.TRACK_LENGTH - 700;
  const PHASE1B_Y = OBS_PHASE1B * (END_Y - START_Y) + START_Y;
  const PHASE2_Y  = OBS_PHASE2  * (END_Y - START_Y) + START_Y;
  const PHASE3_Y  = OBS_PHASE3  * (END_Y - START_Y) + START_Y;
  const playerY   = myInterp ? myInterp.y : 0;

  // [from, to, color]  — track coords, ascending
  const PHASES = [
    [0,          PHASE1B_Y,         'rgba(76,175,80,0.18)' ],  // vert clair — intro
    [PHASE1B_Y,  PHASE2_Y,          'rgba(76,175,80,0.10)' ],  // vert foncé — découverte
    [PHASE2_Y,   PHASE3_Y,          'rgba(255,235,59,0.13)'],  // jaune
    [PHASE3_Y,   C.TRACK_LENGTH,    'rgba(255,152,0,0.16)' ],  // orange
  ];

  ctx.save();
  for (const [from, to, color] of PHASES) {
    // canvasY = PLAYER_RENDER_Y - (trackY - playerY)
    const topCanvas    = PLAYER_RENDER_Y - (to   - playerY);
    const bottomCanvas = PLAYER_RENDER_Y - (from - playerY);
    const drawTop    = Math.max(0, topCanvas);
    const drawBottom = Math.min(CANVAS_H, bottomCanvas);
    if (drawBottom <= drawTop) continue;
    ctx.fillStyle = color;
    ctx.fillRect(TRACK_LEFT, drawTop, TRACK_RENDER_W, drawBottom - drawTop);
  }
  ctx.restore();
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

function drawMyPlayer(p, rb = 0) {
  const cx = TRACK_CENTER_X + p.x;
  const cy = PLAYER_RENDER_Y;

  // Rubber-band flame trail (drawn before player so it appears behind)
  if (rb > 0.02) {
    const intensity = Math.min(1, rb / 0.20);   // 0→1 as rb goes 0→0.20
    const baseAlpha = 0.55 + 0.40 * intensity;  // always visible once active
    ctx.save();
    const flameH = 22 + 48 * intensity;
    const flameW = 9  + 10 * intensity;
    // Flame starts below the player shadow (cy+20) so it's not hidden behind the circle
    const fy = cy + 20;
    const grad = ctx.createLinearGradient(cx, fy, cx, fy + flameH);
    grad.addColorStop(0,   `rgba(255,230,60,${baseAlpha})`);
    grad.addColorStop(0.4, `rgba(255,110,0,${baseAlpha * 0.85})`);
    grad.addColorStop(1,   'rgba(255,30,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - flameW, fy);
    ctx.quadraticCurveTo(cx - flameW * 1.6, fy + flameH * 0.55, cx, fy + flameH);
    ctx.quadraticCurveTo(cx + flameW * 1.6, fy + flameH * 0.55, cx + flameW, fy);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

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

  // Active power-up badges (right of player)
  const badges = [];
  if (p.boostTimer > 0)  badges.push('🚀');
  if (p.shielded)        badges.push('🛡️');
  if (p.slowTimer  > 0)  badges.push('🐌');
  if (badges.length > 0) {
    ctx.font = '13px serif';
    ctx.textBaseline = 'middle';
    badges.forEach((b, i) => ctx.fillText(b, cx + 24 + i * 16, cy));
    ctx.textBaseline = 'alphabetic';
  }

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

function drawHUD(myInterp, rb = 0) {
  ctx.save();
  ctx.font = 'bold 14px Inter, system-ui, sans-serif';

  // Top-left: combo
  const combo = myInterp.combo || 0;
  ctx.fillStyle = combo > 0 ? '#ff9800' : '#666';
  ctx.textAlign = 'left';
  ctx.fillText(`COMBO x${combo}`, 8, 22);

  // Top-center: speed + rubber-band indicator
  const speed = myInterp.speed || C.BASE_SPEED;
  ctx.fillStyle = '#eaeaea';
  ctx.textAlign = 'center';
  ctx.fillText(`⚡ ${Math.round(speed)} u/s`, CANVAS_W / 2, 22);

  if (rb > 0.05) {
    const pct = Math.round(rb * 100);
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = `rgba(255,${Math.round(180 - rb * 400)},0,0.95)`;
    ctx.fillText(`🔥 RATTRAPAGE +${pct}%`, CANVAS_W / 2, 38);
  }

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

  // Phase color bands on the sidebar
  const sb_END_Y     = C.TRACK_LENGTH - 700;
  const sb_ph1b_p = (OBS_PHASE1B * (sb_END_Y - 900) + 900) / C.TRACK_LENGTH;
  const sb_PHASE2_p = (OBS_PHASE2  * (sb_END_Y - 900) + 900) / C.TRACK_LENGTH;
  const sb_PHASE3_p = (OBS_PHASE3  * (sb_END_Y - 900) + 900) / C.TRACK_LENGTH;
  const sb_ph1bY = SIDEBAR_Y_TOP + (1 - sb_ph1b_p) * SIDEBAR_H;
  const sb_ph2Y  = SIDEBAR_Y_TOP + (1 - sb_PHASE2_p) * SIDEBAR_H;
  const sb_ph3Y  = SIDEBAR_Y_TOP + (1 - sb_PHASE3_p) * SIDEBAR_H;
  ctx.fillStyle = 'rgba(76,175,80,0.35)';
  ctx.fillRect(bx, sb_ph1bY, bw, SIDEBAR_Y_BOT - sb_ph1bY);    // phase 1a (bottom)
  ctx.fillStyle = 'rgba(76,175,80,0.20)';
  ctx.fillRect(bx, sb_ph2Y,  bw, sb_ph1bY - sb_ph2Y);           // phase 1b
  ctx.fillStyle = 'rgba(255,235,59,0.30)';
  ctx.fillRect(bx, sb_ph3Y,  bw, sb_ph2Y - sb_ph3Y);            // phase 2 (middle)
  ctx.fillStyle = 'rgba(255,152,0,0.35)';
  ctx.fillRect(bx, SIDEBAR_Y_TOP, bw, sb_ph3Y - SIDEBAR_Y_TOP); // phase 3 (top)

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

function drawPowerUps(myInterp) {
  if (visiblePowerUps.size === 0) return;

  const now = Date.now();
  ctx.save();
  for (const pu of visiblePowerUps.values()) {

    const canvasY = PLAYER_RENDER_Y - (pu.y - myInterp.y);
    if (canvasY < -50 || canvasY > CANVAS_H + 50) continue;
    const canvasX = TRACK_CENTER_X + pu.x;
    const pulse   = 0.7 + 0.3 * Math.sin(now / 300);

    // Outer glow
    ctx.globalAlpha = 0.25 * pulse;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(canvasX, canvasY, 22 * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Inner circle (gold)
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(canvasX, canvasY, 14, 0, Math.PI * 2);
    ctx.fill();

    // Generic star icon — type revealed at pickup
    ctx.globalAlpha = 1;
    ctx.font = '13px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⭐', canvasX, canvasY);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

function spawnComboParticles(cx, cy, combo) {
  const count  = combo >= 20 ? 20 : combo >= 10 ? 14 : 8;
  const color  = combo >= 20 ? '#ffd700' : combo >= 10 ? '#ff9800' : '#4fc3f7';
  const speed  = combo >= 10 ? 4.5 : 3;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const spd   = speed * (0.6 + Math.random() * 0.8);
    comboParticles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,
      life: 1,
      color,
      size: 3 + Math.random() * 3,
    });
  }
}

function drawComboParticles() {
  comboParticles = comboParticles.filter(p => p.life > 0);
  ctx.save();
  for (const p of comboParticles) {
    p.x  += p.vx;
    p.y  += p.vy;
    p.vy += 0.12;
    p.vx *= 0.97;
    p.life -= 0.035;
    if (p.life <= 0) continue; // skip: radius would be negative → ctx.arc throws
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
  }
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

function formatPowerUpCounts(counts) {
  if (!counts) return '-';
  const parts = [];
  if (counts.boost  > 0) parts.push(`🚀×${counts.boost}`);
  if (counts.shield > 0) parts.push(`🛡️×${counts.shield}`);
  if (counts.bomb   > 0) parts.push(`💣×${counts.bomb}`);
  return parts.length > 0 ? parts.join(' ') : '-';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── QR Code ───────────────────────────────────────────────────────────────────

function generateQRCode(code) {
  const el = document.getElementById('qr-code');
  if (!el || typeof QRCode === 'undefined') return;
  el.innerHTML = '';
  const url = window.location.origin + '?join=' + code;
  new QRCode(el, { text: url, width: 120, height: 120, colorDark: '#000000', colorLight: '#ffffff' });
}

// Auto-fill code from URL when scanning QR code
(function () {
  const code = new URLSearchParams(window.location.search).get('join');
  if (code) {
    document.getElementById('input-code').value = code.toUpperCase().slice(0, 4);
  }
})();
