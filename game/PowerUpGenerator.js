'use strict';

const POWERUP_TYPES = ['boost', 'shield', 'bomb'];

/**
 * Generate random power-ups along the track (server-only, no seed needed).
 * @param {number} trackLength
 * @returns {Array<{id, type, y, x}>}
 */
function generatePowerUps(trackLength) {
  const powerUps = [];
  const START_Y = 2000;
  const END_Y   = trackLength - 2000;
  const MIN_GAP = 2000;
  const MAX_GAP = 3500;
  let id = 0;
  let y  = START_Y;

  while (y < END_Y) {
    const x = Math.round((Math.random() * 180) - 90);
    powerUps.push({ id: id++, y: Math.round(y), x });
    y += MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP);
  }

  return powerUps;
}

module.exports = { generatePowerUps };
