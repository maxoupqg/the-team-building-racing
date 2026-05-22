'use strict';

const { createRNG } = require('./seededRandom');

const OBSTACLE_TYPES = ['log', 'barrier', 'wall_left', 'wall_right', 'crate'];

// Weighted pick using one rng() call — weights must sum to 1
function weightedPick(rng, weights) {
  const r = rng();
  let cum = 0;
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i];
    if (r < cum) return i;
  }
  return weights.length - 1;
}

// Phase thresholds (fraction of usable track)
const PHASE1B = 0.15;  // intro ends, découverte commence
const PHASE2  = 0.30;  // warm-up ends
const PHASE3  = 0.72;  // sprint begins

// Type weights per phase: [log, barrier, wall_left, wall_right, crate]
const W1A = [0.50, 0.50, 0,    0,    0   ];  // phase 1a — intro : log/barrier uniquement
const W1B = [0.30, 0.30, 0.10, 0.10, 0.20];  // phase 1b — découverte : tous en facile
const W2  = [0.22, 0.22, 0.18, 0.18, 0.20];  // phase 2 — équilibré
const W3  = [0.12, 0.12, 0.25, 0.25, 0.26];  // phase 3 — murs/caisses dominant

/**
 * Generate obstacles for a race track using a seeded RNG.
 * @param {number} seed
 * @param {number} trackLength
 * @returns {Array<{id: number, type: string, y: number, x: number}>}
 */
function generateObstacles(seed, trackLength) {
  const rng = createRNG(seed);
  const obstacles = [];
  let id = 0;

  const START_Y = 900;
  const END_Y   = trackLength - 700;
  let y = START_Y;

  while (y < END_Y) {
    const progress = Math.min(1, (y - START_Y) / (END_Y - START_Y));

    // Phase-based type selection and spacing
    let weights, minSpacing, maxSpacing;
    if (progress < PHASE1B) {
      weights = W1A; minSpacing = 950; maxSpacing = 1300;
    } else if (progress < PHASE2) {
      weights = W1B; minSpacing = 850; maxSpacing = 1150;
    } else if (progress < PHASE3) {
      weights = W2;  minSpacing = 700; maxSpacing = 1000;
    } else {
      weights = W3;  minSpacing = 550; maxSpacing = 720;
    }

    const type = OBSTACLE_TYPES[weightedPick(rng, weights)];
    let x = 0, width, cratePositions;

    if (type === 'wall_left') {
      x = -70;
      // Phase 1b : largeur minimum pour un gap confortable
      width = progress < PHASE2 ? 140 : Math.round(140 + progress * 80);
    } else if (type === 'wall_right') {
      x = 70;
      width = progress < PHASE2 ? 140 : Math.round(140 + progress * 80);
    } else if (type === 'crate') {
      let crateCount;
      if      (progress < PHASE2)        crateCount = 1;  // phase 1b : toujours 1 caisse
      else if (progress < PHASE2 + 0.15) crateCount = 1;
      else if (progress < PHASE3)        crateCount = 2;
      else if (progress < 0.88)          crateCount = 3;
      else                               crateCount = 5;

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

module.exports = { generateObstacles };
