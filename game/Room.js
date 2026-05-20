'use strict';

const { Race } = require('./Race');

// Bonus points for max combo reached during a race
function comboPointsBonus(maxCombo) {
  if (maxCombo >= 30) return 6;
  if (maxCombo >= 20) return 4;
  if (maxCombo >= 10) return 2;
  if (maxCombo >= 5)  return 1;
  return 0;
}

// Points awarded by finish position (1-indexed)
function pointsForPosition(pos) {
  const table = [10, 8, 6, 5, 4, 3, 2, 1];
  if (pos <= 0) return 0;
  if (pos <= table.length) return table[pos - 1];
  return 1;
}

class Room {
  /**
   * @param {string} code      — 4-letter room code
   * @param {object} io        — Socket.io server instance
   */
  constructor(code, io) {
    this.code   = code;
    this.io     = io;
    this.state  = 'lobby';   // lobby | countdown | racing | results

    // Map of socketId -> { id, name, color, isHost }
    this.players = new Map();
    this.hostId  = null;

    // Standings: Map of playerId -> { name, color, totalPoints, streak, lastWin }
    this.standings = new Map();

    this.raceNumber = 0;
    this.currentRace = null;
    this.lastResults = null;
  }

  // ── Player management ──────────────────────────────────────────────────────

  addPlayer(socketId, name, color, isHost = false) {
    this.players.set(socketId, { id: socketId, name, color, isHost });
    if (isHost) this.hostId = socketId;

    if (!this.standings.has(socketId)) {
      this.standings.set(socketId, {
        id:          socketId,
        name,
        color,
        totalPoints: 0,
        streak:      0,   // consecutive wins
      });
    }
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.standings.delete(socketId);

    if (this.hostId === socketId) {
      // Promote the next player as host
      const next = this.players.values().next().value;
      if (next) {
        next.isHost  = true;
        this.hostId  = next.id;
      } else {
        this.hostId = null;
      }
    }

    const newHostId = this.hostId;
    this.io.to(this.code).emit('player_left', { playerId: socketId, newHostId });
    this._emitLobbyUpdate();
  }

  isEmpty() {
    return this.players.size === 0;
  }

  isHost(socketId) {
    return this.hostId === socketId;
  }

  hasPlayer(socketId) {
    return this.players.has(socketId);
  }

  // ── Lobby helpers ──────────────────────────────────────────────────────────

  _emitLobbyUpdate() {
    this.io.to(this.code).emit('lobby_update', {
      players:     this._playerList(),
      hostId:      this.hostId,
      standings:   this._standingsList(),
      raceNumber:  this.raceNumber,
    });
  }

  _playerList() {
    return [...this.players.values()].map(p => ({
      id:     p.id,
      name:   p.name,
      color:  p.color,
      isHost: p.isHost,
    }));
  }

  _standingsList() {
    return [...this.standings.values()]
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .map((s, i) => ({ ...s, position: i + 1 }));
  }

  // ── Race lifecycle ─────────────────────────────────────────────────────────

  startRace() {
    if (this.state !== 'lobby') return;
    this.state = 'countdown';
    this._runCountdown();
  }

  _runCountdown() {
    let count = 3;
    const tick = () => {
      if (count > 0) {
        this.io.to(this.code).emit('countdown', { count });
        count--;
        setTimeout(tick, 1000);
      } else {
        this._launchRace();
      }
    };
    tick();
  }

  _launchRace() {
    this.state = 'racing';
    this.raceNumber++;

    const seed = Math.floor(Math.random() * 0xFFFFFFFF);
    const playerList = [...this.players.values()].map(p => ({
      id:    p.id,
      name:  p.name,
      color: p.color,
    }));

    this.currentRace = new Race(
      seed,
      playerList,
      this.io,
      this.code,
      (finishOrder, playerStates) => this._onRaceFinished(finishOrder, playerStates),
    );

    this.currentRace.start();
  }

  _onRaceFinished(finishOrder, playerStates) {
    this.state = 'results';

    // Build results
    const results = [];
    const winnerStreak = this.standings.get(finishOrder[0]);

    for (let i = 0; i < finishOrder.length; i++) {
      const playerId = finishOrder[i];
      const position = i + 1;
      const pState   = playerStates.get(playerId);
      const standing = this.standings.get(playerId);
      if (!standing || !pState) continue;

      const pts        = pointsForPosition(position);
      const comboBonus = comboPointsBonus(pState.maxCombo || 0);

      // Streak bonus: +3 for each consecutive win after the first
      let streakBonus = 0;
      if (position === 1) {
        standing.streak++;
        if (standing.streak > 1) {
          streakBonus = (standing.streak - 1) * 3;
        }
      } else {
        standing.streak = 0;
      }

      standing.totalPoints += pts + streakBonus + comboBonus;
      standing.name  = pState.name;
      standing.color = pState.color;

      results.push({
        playerId,
        name:        pState.name,
        color:       pState.color,
        position,
        finishTime:  pState.finishTime,
        maxCombo:    pState.maxCombo || 0,
        points:      pts,
        comboBonus,
        streakBonus,
        totalPoints: standing.totalPoints,
      });
    }

    this.lastResults = results;

    this.io.to(this.code).emit('race_results', {
      raceNumber: this.raceNumber,
      results,
      standings:  this._standingsList(),
    });
  }

  prepareNextRace() {
    if (this.state !== 'results') return;
    this.currentRace = null;
    this.state = 'lobby';
    this._emitLobbyUpdate();
  }

  // ── Socket join helpers (called from server.js) ────────────────────────────

  emitRoomCreated(socket) {
    socket.emit('room_created', {
      code:      this.code,
      playerId:  socket.id,
      hostId:    this.hostId,
      players:   this._playerList(),
      standings: this._standingsList(),
      raceNumber: this.raceNumber,
    });
  }

  emitRoomJoined(socket) {
    socket.emit('room_joined', {
      code:        this.code,
      playerId:    socket.id,
      players:     this._playerList(),
      hostId:      this.hostId,
      standings:   this._standingsList(),
      raceNumber:  this.raceNumber,
    });
    // Notify everyone else
    this._emitLobbyUpdate();
  }
}

module.exports = { Room };