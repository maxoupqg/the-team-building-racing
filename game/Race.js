'use strict';

const { generateObstacles } = require('./ObstacleGenerator');
const { generatePowerUps }  = require('./PowerUpGenerator');

// ── Constants ────────────────────────────────────────────────────────────────
const TRACK_LENGTH          = 50000;
const TRACK_WIDTH           = 280;
const BASE_SPEED            = 220;   // units/second
const COMBO_SPEED_BONUS     = 0.07;  // 7% per combo step (max x1.84 at 12 combos)
const MAX_COMBO             = 12;
const TICK_RATE             = 30;    // Hz
const DT                    = 1 / TICK_RATE;
const MOVE_SPEED            = 380;   // horizontal units/second
const JUMP_DURATION         = 600;   // ms
const SLIDE_DURATION        = 500;   // ms
const ATTACK_DURATION       = 280;   // ms
const OBSTACLE_WINDOW_START = 500;   // must cover full canvas look-ahead (420px) so player can't react before window opens
const OBSTACLE_WINDOW_END   = 150;   // px of grace after obstacle center
const RACE_TIMEOUT_MS       = 5 * 60 * 1000; // 5 minutes

const POWERUP_RADIUS = 40;    // pickup collision half-height
const BOOST_MULT     = 1.6;   // +60% speed
const BOOST_DUR      = 6000;  // ms
const SLOW_MULT      = 0.65;  // -35% speed
const SLOW_DUR       = 4000;  // ms

class Race {
  /**
   * @param {number}   seed
   * @param {Array}    playerList  — array of { id, name, color }
   * @param {object}   io          — Socket.io server instance
   * @param {string}   roomCode
   * @param {Function} onFinished  — called when race ends, with finishOrder array
   * @param {object}   options     — { powerUpsEnabled }
   */
  constructor(seed, playerList, io, roomCode, onFinished, options = {}) {
    this.seed      = seed;
    this.io        = io;
    this.roomCode  = roomCode;
    this.onFinished = onFinished;
    this.startTime = Date.now();

    this.obstacles = generateObstacles(seed, TRACK_LENGTH);
    this.powerUps  = options.powerUpsEnabled ? generatePowerUps(TRACK_LENGTH) : [];

    // Build players map
    this.players = new Map();
    for (const p of playerList) {
      this.players.set(p.id, {
        id:    p.id,
        name:  p.name,
        color: p.color,
        x:     0,
        y:     0,
        state: 'running',
        stateTimer: 0,
        input: { left: false, right: false, jump: false, slide: false, attack: false },
        combo:    0,
        maxCombo: 0,
        speed: BASE_SPEED,
        pendingObstacles:   new Map(),  // id -> { actionDone, correctAction }
        processedObstacles: new Set(),
        finished:   false,
        finishTime: null,
        progress:   0,
        // power-up state
        boostTimer:        0,
        shielded:          false,
        slowTimer:         0,
        processedPowerUps: new Set(),
        visiblePowerUpIds: new Set(),
        powerUpCounts:     { boost: 0, shield: 0, bomb: 0 },
      });
    }

    // Short integer index per player (used in compact game_state broadcast)
    this.playerIndex = new Map();
    let idx = 0;
    for (const id of this.players.keys()) this.playerIndex.set(id, idx++);

    this.finishOrder   = [];
    this.running       = false;
    this.intervalId    = null;
    this.timeoutId     = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start() {
    this.running   = true;
    this.startTime = Date.now();

    // Emit race_start with all info clients need
    this.io.to(this.roomCode).emit('race_start', {
      seed:        this.seed,
      obstacles:   this.obstacles,
      powerUps:    [],
      trackLength: TRACK_LENGTH,
      players:     [...this.players.values()].map(p => ({
        i:     this.playerIndex.get(p.id),
        id:    p.id,
        name:  p.name,
        color: p.color,
      })),
      constants: {
        TRACK_LENGTH,
        TRACK_WIDTH,
        BASE_SPEED,
        COMBO_SPEED_BONUS,
        MAX_COMBO,
        TICK_RATE,
        DT,
        MOVE_SPEED,
        JUMP_DURATION,
        SLIDE_DURATION,
        ATTACK_DURATION,
        OBSTACLE_WINDOW_START,
        OBSTACLE_WINDOW_END,
      },
    });

    this.intervalId = setInterval(() => this._tick(), 1000 / TICK_RATE);

    this.timeoutId = setTimeout(() => {
      if (this.running) {
        this._forceEnd();
      }
    }, RACE_TIMEOUT_MS);
  }

  handleInput(playerId, input) {
    const player = this.players.get(playerId);
    if (!player || player.finished) return;
    player.input = { ...input };
  }

  stop() {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  // ── Internal tick ──────────────────────────────────────────────────────────

  _tick() {
    if (!this.running) return;

    // Compute rank info once per tick — sorted active players + relPos map
    const active = [...this.players.values()].filter(p => !p.finished);
    active.sort((a, b) => b.progress - a.progress);
    const total = active.length;
    const relPosMap = new Map();
    for (let i = 0; i < total; i++) {
      relPosMap.set(active[i].id, total <= 1 ? 0 : i / (total - 1));
    }
    const leaderProgress = total > 0 ? active[0].progress : 0;

    for (const player of this.players.values()) {
      if (player.finished) continue;
      this._updatePlayer(player, leaderProgress, relPosMap);
    }

    // Sync per-player visible power-ups using pre-computed relPos
    for (const player of this.players.values()) {
      if (player.finished) continue;
      const threshold = Math.round((0.3 + (relPosMap.get(player.id) ?? 0) * 0.7) * 10);
      for (const pu of this.powerUps) {
        if (player.processedPowerUps.has(pu.id)) continue;
        const isVisible  = (pu.id % 10) < threshold;
        const wasVisible = player.visiblePowerUpIds.has(pu.id);
        if (isVisible && !wasVisible) {
          player.visiblePowerUpIds.add(pu.id);
          this.io.to(player.id).emit('powerup_unlocked', { pu });
        } else if (!isVisible && wasVisible) {
          player.visiblePowerUpIds.delete(pu.id);
          this.io.to(player.id).emit('powerup_locked', { puId: pu.id });
        }
      }
    }

    // Broadcast compact game state
    // Format per player: [idx, x, y, stateCode, combo, maxCombo, speed, progress×10000, boostTimer, shielded, slowTimer]
    // stateCode: 0=running 1=jumping 2=sliding 3=attacking
    // Finished players are skipped (client marks them done via player_finished event)
    const STATE_CODES = { running: 0, jumping: 1, sliding: 2, attacking: 3 };
    const rows = [];
    for (const p of this.players.values()) {
      if (p.finished) continue;
      rows.push([
        this.playerIndex.get(p.id),
        Math.round(p.x),
        Math.round(p.y),
        STATE_CODES[p.state] ?? 0,
        p.combo,
        p.maxCombo,
        Math.round(p.speed),
        Math.round(p.progress * 10000),
        Math.round(p.boostTimer),
        p.shielded ? 1 : 0,
        Math.round(p.slowTimer),
      ]);
    }
    this.io.to(this.roomCode).emit('game_state', { p: rows, t: Date.now() });

    // Check if all players have finished
    const allFinished = [...this.players.values()].every(p => p.finished);
    if (allFinished) {
      this._endRace();
    }
  }

  _updatePlayer(player, leaderProgress, relPosMap) {
    // 1. Update stateTimer, revert to 'running' when expired
    if (player.state !== 'running') {
      player.stateTimer -= DT * 1000; // convert DT (seconds) to ms
      if (player.stateTimer <= 0) {
        player.state = 'running';
        player.stateTimer = 0;
      }
    }

    // 2. If running, check for new action inputs
    if (player.state === 'running') {
      if (player.input.jump) {
        player.state = 'jumping';
        player.stateTimer = JUMP_DURATION;
      } else if (player.input.slide) {
        player.state = 'sliding';
        player.stateTimer = SLIDE_DURATION;
      } else if (player.input.attack) {
        player.state = 'attacking';
        player.stateTimer = ATTACK_DURATION;
      }
    }

    // 3. Move X
    let dx = 0;
    if (player.input.left)  dx -= MOVE_SPEED;
    if (player.input.right) dx += MOVE_SPEED;
    const maxX = TRACK_WIDTH / 2 - 20;
    player.x = Math.max(-maxX, Math.min(maxX, player.x + dx * DT));

    // 4. Move Y — rubber-band + combo bonus + power-up modifiers
    const gap = Math.max(0, leaderProgress - player.progress);
    const rubberBand = 1 + Math.min(gap * 0.3, 0.3);

    let powerMult = 1;
    if (player.boostTimer > 0) {
      powerMult *= BOOST_MULT;
      player.boostTimer = Math.max(0, player.boostTimer - DT * 1000);
    }
    if (player.slowTimer > 0) {
      powerMult *= SLOW_MULT;
      player.slowTimer = Math.max(0, player.slowTimer - DT * 1000);
    }

    player.speed = BASE_SPEED * (1 + player.combo * COMBO_SPEED_BONUS) * rubberBand * powerMult;
    player.y += player.speed * DT;

    // 5. Power-up pickup (each player independent, only if visible for this player)
    const relPos      = relPosMap.get(player.id) ?? 0;
    const puThreshold = Math.round((0.3 + relPos * 0.7) * 10);
    for (const pu of this.powerUps) {
      if (player.processedPowerUps.has(pu.id)) continue;
      if ((pu.id % 10) >= puThreshold) continue;
      if (Math.abs(player.y - pu.y) < POWERUP_RADIUS) {
        player.processedPowerUps.add(pu.id);
        const type = this._powerUpTypeForPlayer(relPos);
        this._applyPowerUp(player, type);
        player.powerUpCounts[type] = (player.powerUpCounts[type] || 0) + 1;
        this.io.to(this.roomCode).emit('powerup_taken', { puId: pu.id, playerId: player.id, type });
      }
    }

    // 6. Obstacle window logic (obstacles are sorted ascending by y)
    for (const obs of this.obstacles) {
      if (player.processedObstacles.has(obs.id)) continue;

      // Obstacles are sorted: once we hit one that's too far ahead, stop
      if (player.y < obs.y - OBSTACLE_WINDOW_START) break;

      // Add to pending when player enters the approach window
      if (!player.pendingObstacles.has(obs.id)) {
        player.pendingObstacles.set(obs.id, {
          actionDone:    false,
          correctAction: this._correctActionFor(obs.type),
        });
      }

      const pObs = player.pendingObstacles.get(obs.id);

      // Latch on first success — hitbox aligné sur le bord visuel + rayon joueur (w-132)
      if (!pObs.actionDone) {
        pObs.actionDone = this._checkAction(player, obs);
      }

      // Evaluate when player has cleared the window end
      if (player.y > obs.y + OBSTACLE_WINDOW_END) {
        const result = pObs.actionDone ? 'SUCCESS' : 'MISS';
        if (pObs.actionDone) {
          player.combo = Math.min(player.combo + 1, 99);
          if (player.combo > player.maxCombo) player.maxCombo = player.combo;
        } else {
          // Shield absorbs the miss
          if (player.shielded) {
            player.shielded = false;
          } else {
            player.combo = 0;
          }
        }
        player.pendingObstacles.delete(obs.id);
        player.processedObstacles.add(obs.id);
      }
    }

    // 7. Check finish line
    if (player.y >= TRACK_LENGTH) {
      player.y = TRACK_LENGTH;
      player.finished = true;
      player.finishTime = Date.now() - this.startTime;
      this.finishOrder.push(player.id);

      const position = this.finishOrder.length;
      this.io.to(this.roomCode).emit('player_finished', {
        playerId:   player.id,
        position,
        finishTime: player.finishTime,
      });
    }

    // 8. Progress
    player.progress = player.y / TRACK_LENGTH;
  }

  _applyPowerUp(player, type) {
    switch (type) {
      case 'boost':
        player.boostTimer = BOOST_DUR;
        break;
      case 'shield':
        player.shielded = true;
        break;
      case 'bomb': {
        // Ralentit les 5 joueurs les plus proches devant le lanceur
        const targets = [...this.players.values()]
          .filter(p => p.id !== player.id && !p.finished && p.progress > player.progress)
          .sort((a, b) => a.progress - b.progress)
          .slice(0, 5);
        for (const t of targets) {
          t.slowTimer = Math.max(t.slowTimer, SLOW_DUR);
        }
        break;
      }
    }
  }

  _powerUpTypeForPlayer(relPos) {
    const r = Math.random();
    if (relPos < 0.20) {
      // Top 20% : boost ou bouclier uniquement, jamais de bombe
      return r < 0.50 ? 'boost' : 'shield';
    } else if (relPos < 0.60) {
      // Milieu : mixte
      if (r < 0.50) return 'boost';
      if (r < 0.80) return 'shield';
      return 'bomb';
    } else {
      // Fond 40% : surtout des bombes
      if (r < 0.60) return 'bomb';
      if (r < 0.90) return 'boost';
      return 'shield';
    }
  }

  _correctActionFor(type) {
    switch (type) {
      case 'log':        return 'jump';
      case 'barrier':    return 'slide';
      case 'wall_left':  return 'dodge_right';
      case 'wall_right': return 'dodge_left';
      case 'crate':      return 'attack';
      default:           return 'none';
    }
  }

  _checkAction(player, obs) {
    switch (obs.type) {
      case 'log':        return player.state === 'jumping';
      case 'barrier':    return player.state === 'sliding';
      case 'wall_left':  return player.x > (obs.width || 140) - 132;
      case 'wall_right': return player.x < 132 - (obs.width || 140);
      case 'crate': {
        const CRATE_HIT_R = 43; // crate half-width (25) + player radius (18)
        const positions = obs.cratePositions || [{ x: obs.x }];
        const inCollision = positions.some(cp => Math.abs(player.x - cp.x) < CRATE_HIT_R);
        // Attack while in collision can be triggered anywhere in the approach window
        if (inCollision && player.state === 'attacking') return true;
        // Dodge only counts once the player is actually at the obstacle (not from 500px away)
        if (!inCollision && player.y >= obs.y - 80) return true;
        return false;
      }
      default:           return false;
    }
  }

  _forceEnd() {
    // Mark all unfinished players as done (no finish time)
    for (const player of this.players.values()) {
      if (!player.finished) {
        player.finished = true;
        this.finishOrder.push(player.id);
      }
    }
    this._endRace();
  }

  _endRace() {
    this.stop();
    this.onFinished(this.finishOrder, this.players);
  }
}

module.exports = { Race, TRACK_LENGTH, TRACK_WIDTH, BASE_SPEED };
