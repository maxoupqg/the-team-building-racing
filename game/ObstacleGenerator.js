
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./seededRandom'));
  } else {
    const e = factory({ createRNG: root.createRNG });
    root.generateObstacles = e.generateObstacles;
    root.OBS_PHASE1B       = e.OBS_PHASE1B;
    root.OBS_PHASE2        = e.OBS_PHASE2;
    root.OBS_PHASE3        = e.OBS_PHASE3;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (seededRandom) {
  'use strict';
  const createRNG = seededRandom.createRNG;

  const OBSTACLE_TYPES = ['log', 'barrier', 'wall_left', 'wall_right', 'crate', 'split'];

  const OBS_PHASE1B = 0.15;
  const OBS_PHASE2  = 0.30;
  const OBS_PHASE3  = 0.72;
  // Weights indexed [level1, level2, level3] — 6 values: log, barrier, wall_l, wall_r, crate, split
  const OBS_W1A = [[0.40, 0.40, 0,    0,    0.20, 0   ], [0.35, 0.35, 0,    0,    0.30, 0   ], [0.30, 0.30, 0,    0,    0.20, 0.20]];
  const OBS_W1B = [[0.30, 0.30, 0.10, 0.10, 0.20, 0   ], [0.25, 0.25, 0.15, 0.15, 0.20, 0   ], [0.20, 0.20, 0.10, 0.10, 0.20, 0.20]];
  const OBS_W2  = [[0.25, 0.25, 0.15, 0.15, 0.20, 0   ], [0.20, 0.20, 0.20, 0.20, 0.20, 0   ], [0.15, 0.15, 0.15, 0.15, 0.20, 0.20]];
  const OBS_W3  = [[0.20, 0.20, 0.20, 0.20, 0.20, 0   ], [0.15, 0.15, 0.25, 0.25, 0.20, 0   ], [0.10, 0.10, 0.20, 0.20, 0.20, 0.20]];
  // Combo probabilities per phase [phase1a, phase1b, phase2, phase3]
  const COMBO_PROB_L2            = [0, 0.20, 0.35, 0.50];
  const COMBO_PROB_L3_LOG_WALL   = [0, 0.30, 0.50, 0.65];
  const COMBO_PROB_L3_WALL_CRATE = [0, 0.25, 0.45, 0.60];

  function weightedPick(rng, weights) {
    const r = rng();
    let cum = 0;
    for (let i = 0; i < weights.length; i++) {
      cum += weights[i];
      if (r < cum) return i;
    }
    return weights.length - 1;
  }

  function generateObstacles(seed, trackLength, level) {
    level = level >= 3 ? 3 : level >= 2 ? 2 : 1;
    const lvIdx       = level - 1;
    const spacingMult = level >= 3 ? 0.65 : level >= 2 ? 0.78 : 1.0;
    const rng = createRNG(seed);
    const obstacles = [];
    let id = 0;

    const START_Y = 900;
    const END_Y   = trackLength - 700;
    let y = START_Y;

    while (y < END_Y) {
      const progress = Math.min(1, (y - START_Y) / (END_Y - START_Y));

      let weights, minSpacing, maxSpacing, phaseIdx;
      if (progress < OBS_PHASE1B) {
        weights = OBS_W1A[lvIdx]; minSpacing = 950; maxSpacing = 1300; phaseIdx = 0;
      } else if (progress < OBS_PHASE2) {
        weights = OBS_W1B[lvIdx]; minSpacing = 850; maxSpacing = 1150; phaseIdx = 1;
      } else if (progress < OBS_PHASE3) {
        weights = OBS_W2[lvIdx];  minSpacing = 700; maxSpacing = 1000; phaseIdx = 2;
      } else {
        weights = OBS_W3[lvIdx];  minSpacing = 550; maxSpacing = 720;  phaseIdx = 3;
      }
      minSpacing = Math.round(minSpacing * spacingMult);
      maxSpacing = Math.round(maxSpacing * spacingMult);

      const type = OBSTACLE_TYPES[weightedPick(rng, weights)];
      let x = 0, width, cratePositions;

      if (type === 'wall_left') {
        x = -70;
        width = progress < OBS_PHASE2 ? 140 : Math.round(140 + progress * 80);
      } else if (type === 'wall_right') {
        x = 70;
        width = progress < OBS_PHASE2 ? 140 : Math.round(140 + progress * 80);
      } else if (type === 'crate') {
        let crateCount;
        if      (progress < OBS_PHASE2)        crateCount = 1;
        else if (progress < OBS_PHASE2 + 0.15) crateCount = 1;
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

      obstacles.push({ id: id++, type, y: Math.round(y), x, width, cratePositions });

      // Level 2+: add a wall combo partner after log/barrier
      if (level >= 2 && (type === 'log' || type === 'barrier')) {
        const prob = level >= 3 ? COMBO_PROB_L3_LOG_WALL[phaseIdx] : COMBO_PROB_L2[phaseIdx];
        if (rng() < prob) {
          const wallType = rng() < 0.5 ? 'wall_left' : 'wall_right';
          const wallX    = wallType === 'wall_left' ? -70 : 70;
          const wallW    = progress < OBS_PHASE2 ? 140 : Math.round(140 + progress * 80);
          const comboY   = Math.round(y + 80 + rng() * 40);
          obstacles.push({ id: id++, type: wallType, y: comboY, x: wallX, width: wallW });
        }
      }

      // Level 3: add a crate on the free side after a wall
      if (level >= 3 && (type === 'wall_left' || type === 'wall_right')) {
        if (rng() < COMBO_PROB_L3_WALL_CRATE[phaseIdx]) {
          const crateX = type === 'wall_left' ? 65 : -65;
          obstacles.push({ id: id++, type: 'crate', y: Math.round(y), x: 0, cratePositions: [{ x: crateX }] });
        }
      }

      y += minSpacing + rng() * (maxSpacing - minSpacing);
    }

    // Ensure sorted by y (combo partners inserted mid-array are already in order
    // because comboY < y + minSpacing, but sort for safety)
    obstacles.sort((a, b) => a.y - b.y);
    // Re-assign sequential ids after sort
    obstacles.forEach((o, i) => { o.id = i; });

    return obstacles;
  }

  return { generateObstacles, OBS_PHASE1B, OBS_PHASE2, OBS_PHASE3 };
}));
