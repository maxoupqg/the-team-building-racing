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

  const OBSTACLE_TYPES = ['log', 'barrier', 'wall_left', 'wall_right', 'crate'];

  const OBS_PHASE1B = 0.15;
  const OBS_PHASE2  = 0.30;
  const OBS_PHASE3  = 0.72;
  const OBS_W1A = [0.50, 0.50, 0,    0,    0   ];  // intro : log/barrier uniquement
  const OBS_W1B = [0.30, 0.30, 0.10, 0.10, 0.20];  // découverte : tous en facile
  const OBS_W2  = [0.22, 0.22, 0.18, 0.18, 0.20];  // équilibré
  const OBS_W3  = [0.12, 0.12, 0.25, 0.25, 0.26];  // murs/caisses dominant

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
      y += minSpacing + rng() * (maxSpacing - minSpacing);
    }

    return obstacles;
  }

  return { generateObstacles, OBS_PHASE1B, OBS_PHASE2, OBS_PHASE3 };
}));
