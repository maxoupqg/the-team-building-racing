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

// Points awarded by finish position — triangular scale, last=0, gaps grow toward 1st
function pointsForPosition(pos, total) {
  const rankFromLast = total - pos;
  return rankFromLast * (rankFromLast + 1) / 2;
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
    this.powerUpsEnabled = false;

    // Team mode
    this.teamMode = false;
    this.teams    = [];   // [{ id, name, color, playerIds }]
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

    if (this.teamMode) this._rebuildTeams();
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

    if (this.teamMode) this._rebuildTeams();

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

  togglePowerUps() {
    this.powerUpsEnabled = !this.powerUpsEnabled;
    this._emitLobbyUpdate();
  }

  toggleTeamMode() {
    this.teamMode = !this.teamMode;
    if (this.teamMode) {
      this._rebuildTeams();
    } else {
      this.teams = [];
    }
    this._emitLobbyUpdate();
  }

  _rebuildTeams() {
    const players = [...this.players.values()];
    const n = players.length;
    const numTeams = n < 4 ? 0 : Math.min(4, Math.floor(n / 2));

    if (numTeams < 2) {
      this.teams = [];
      return;
    }

    const TEAM_COLORS = ['#e94560', '#4fc3f7', '#66bb6a', '#ffa726'];
    const teams = Array.from({ length: numTeams }, (_, i) => ({
      id:        i,
      color:     TEAM_COLORS[i],
      playerIds: [],
      members:   [],
    }));

    // Round-robin assignment by join order
    players.forEach((p, i) => {
      teams[i % numTeams].playerIds.push(p.id);
      teams[i % numTeams].members.push({ id: p.id, name: p.name, color: p.color });
    });

    // Generate portmanteau name from first two members
    teams.forEach(t => {
      t.name = this._generateTeamName(t.members);
    });

    this.teams = teams;
  }

  _generateTeamName(members) {
    if (members.length === 0) return 'Les ???';
    if (members.length === 1) return `Les ${members[0].name.slice(0, 14)}`;
    const n1 = members[0].name;
    const n2 = members[1].name;
    const portmanteau = n1.slice(0, Math.ceil(n1.length / 2)) + n2.slice(Math.floor(n2.length / 2));
    return `Les ${portmanteau.slice(0, 14)}`;
  }

  _emitLobbyUpdate() {
    this.io.to(this.code).emit('lobby_update', {
      players:         this._playerList(),
      hostId:          this.hostId,
      standings:       this._standingsList(),
      raceNumber:      this.raceNumber,
      powerUpsEnabled: this.powerUpsEnabled,
      teamMode:        this.teamMode,
      teams:           this.teams,
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
      { powerUpsEnabled: this.powerUpsEnabled },
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

      const pts        = pointsForPosition(position, finishOrder.length);
      const comboBonus = comboPointsBonus(pState.maxCombo || 0);

      // Streak bonus: +3 for each consecutive win after the first
      let streakBonus = 0;
      if (position === 1) {
        standing.streak = Math.min(standing.streak + 1, 3);
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
        name:          pState.name,
        color:         pState.color,
        position,
        finishTime:    pState.finishTime,
        maxCombo:      pState.maxCombo || 0,
        powerUpCounts: pState.powerUpCounts || { boost: 0, shield: 0, bomb: 0 },
        points:        pts,
        comboBonus,
        streakBonus,
        totalPoints: standing.totalPoints,
      });
    }

    this.lastResults = results;

    let teamResults = null;
    if (this.teams.length > 0) {
      teamResults = this.teams.map(team => ({
        id:      team.id,
        name:    team.name,
        color:   team.color,
        score:   results
          .filter(r => team.playerIds.includes(r.playerId))
          .reduce((s, r) => s + r.points + r.comboBonus + r.streakBonus, 0),
        members: results.filter(r => team.playerIds.includes(r.playerId)),
      })).sort((a, b) => b.score - a.score);
    }

    this.io.to(this.code).emit('race_results', {
      raceNumber: this.raceNumber,
      results,
      standings:  this._standingsList(),
      teamResults,
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
      code:            this.code,
      playerId:        socket.id,
      hostId:          this.hostId,
      players:         this._playerList(),
      standings:       this._standingsList(),
      raceNumber:      this.raceNumber,
      powerUpsEnabled: this.powerUpsEnabled,
      teamMode:        this.teamMode,
      teams:           this.teams,
    });
  }

  emitRoomJoined(socket) {
    socket.emit('room_joined', {
      code:            this.code,
      playerId:        socket.id,
      players:         this._playerList(),
      hostId:          this.hostId,
      standings:       this._standingsList(),
      raceNumber:      this.raceNumber,
      powerUpsEnabled: this.powerUpsEnabled,
      teamMode:        this.teamMode,
      teams:           this.teams,
    });
    // Notify everyone else
    this._emitLobbyUpdate();
  }
}

module.exports = { Room };