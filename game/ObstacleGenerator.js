'use strict';

const { createRNG } = require('./seededRandom');

const OBSTACLE_TYPES = ['log', 'barrier', 'wall_left', 'wall_right', 'crate'];

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
  const END_Y = trackLength - 700;

  let y = START_Y;

  while (y < END_Y) {
    const typeIndex = Math.floor(rng() * OBSTACLE_TYPES.length);
    const type = OBSTACLE_TYPES[typeIndex];

    let x = 0;
    let width;
    let cratePositions;

    // Spacing stays above window total (650) to prevent two obstacles in the same detection window
    const progress = Math.min(1, (y - START_Y) / (END_Y - START_Y));

    if (type === 'wall_left') {
      x = -70;
      width = Math.round(140 + progress * 80);
    } else if (type === 'wall_right') {
      x = 70;
      width = Math.round(140 + progress * 80);
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

  // Already sorted ascending by y (spawned in order)
  return obstacles;
}

module.exports = { generateObstacles };