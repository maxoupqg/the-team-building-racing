'use strict';

// Each avatar has a fixed signature color used throughout the game
const AVATAR_DEFS = [
  { name: 'Alex',  color: '#e94560' },  // 0 — human, black hair,   red shirt
  { name: 'Sam',   color: '#FF8C00' },  // 1 — human, orange hair,  blue shirt
  { name: 'Bot',   color: '#4fc3f7' },  // 2 — robot,  cyan eyes
  { name: 'Mimi',  color: '#FF69B4' },  // 3 — cat,    pink
  { name: 'Zorg',  color: '#66bb6a' },  // 4 — alien,  green
  { name: 'Shin',  color: '#9C27B0' },  // 5 — ninja,  purple
  { name: 'Jack',  color: '#FF6F00' },  // 6 — pirate, amber
  { name: 'Rex',   color: '#FFD700' },  // 7 — king,   gold
];

const AVATAR_COUNT = AVATAR_DEFS.length;

function _r(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawAvatar(ctx, id, x, y, size) {
  const u = size / 16;
  ctx.save();
  ctx.translate(x, y);
  _drawFn[id % AVATAR_COUNT](ctx, u);
  ctx.restore();
}

const _cache = new Map();
function getAvatarCanvas(id, size) {
  const key = `${id}_${size}`;
  if (_cache.has(key)) return _cache.get(key);
  const oc = document.createElement('canvas');
  oc.width = oc.height = size;
  const octx = oc.getContext('2d');
  octx.imageSmoothingEnabled = false;
  drawAvatar(octx, id, 0, 0, size);
  _cache.set(key, oc);
  return oc;
}

const _drawFn = [

  // 0 — Alex : humain, cheveux noirs, t-shirt rouge
  function(ctx, u) {
    _r(ctx,  3*u, 0,    10*u,  4*u, '#1a1a1a');
    _r(ctx,  2*u, 2*u,   2*u,  5*u, '#1a1a1a');
    _r(ctx, 12*u, 2*u,   2*u,  5*u, '#1a1a1a');
    _r(ctx,  3*u, 3*u,  10*u,  7*u, '#F5C5A3');
    _r(ctx,  5*u, 5*u,   2*u,  2*u, '#2a1a0a');
    _r(ctx,  9*u, 5*u,   2*u,  2*u, '#2a1a0a');
    _r(ctx,  6*u, 8*u,   4*u,  1*u, '#C07850');
    _r(ctx,  6*u,10*u,   4*u,  2*u, '#F5C5A3');
    _r(ctx,  3*u,12*u,  10*u,  4*u, '#e94560');
    _r(ctx,  6*u,11*u,   4*u,  2*u, '#c73045');
  },

  // 1 — Sam : humain, cheveux roux, t-shirt bleu
  function(ctx, u) {
    _r(ctx,  2*u, 0,    12*u,  5*u, '#F57C00');
    _r(ctx,  1*u, 2*u,   2*u,  4*u, '#F57C00');
    _r(ctx, 13*u, 2*u,   2*u,  4*u, '#F57C00');
    _r(ctx,  3*u, 4*u,  10*u,  7*u, '#FDD5B1');
    _r(ctx,  5*u, 9*u,   1*u,  1*u, '#D4956A');
    _r(ctx,  7*u, 9*u,   1*u,  1*u, '#D4956A');
    _r(ctx,  9*u, 9*u,   1*u,  1*u, '#D4956A');
    _r(ctx, 11*u, 9*u,   1*u,  1*u, '#D4956A');
    _r(ctx,  5*u, 6*u,   2*u,  2*u, '#388E3C');
    _r(ctx,  9*u, 6*u,   2*u,  2*u, '#388E3C');
    _r(ctx,  6*u, 9*u,   4*u,  1*u, '#C07850');
    _r(ctx,  6*u,11*u,   4*u,  1*u, '#FDD5B1');
    _r(ctx,  3*u,12*u,  10*u,  4*u, '#1976D2');
    _r(ctx,  6*u,11*u,   4*u,  2*u, '#1565C0');
  },

  // 2 — Bot : robot, yeux cyan
  function(ctx, u) {
    _r(ctx,  7*u, 0,     2*u,  3*u, '#90A4AE');
    _r(ctx,  6*u, 2*u,   4*u,  2*u, '#90A4AE');
    _r(ctx,  7*u, 0,     2*u,  1*u, '#00E5FF');
    _r(ctx,  2*u, 3*u,  12*u,  9*u, '#546E7A');
    _r(ctx,  3*u, 4*u,  10*u,  7*u, '#78909C');
    _r(ctx,  4*u, 6*u,   3*u,  2*u, '#00E5FF');
    _r(ctx,  9*u, 6*u,   3*u,  2*u, '#00E5FF');
    _r(ctx,  5*u, 6*u,   1*u,  2*u, '#FFFFFF');
    _r(ctx, 10*u, 6*u,   1*u,  2*u, '#FFFFFF');
    _r(ctx,  5*u, 9*u,   2*u,  1*u, '#37474F');
    _r(ctx,  8*u, 9*u,   2*u,  1*u, '#37474F');
    _r(ctx,  7*u, 9*u,   1*u,  1*u, '#37474F');
    _r(ctx,  3*u,12*u,  10*u,  4*u, '#455A64');
    _r(ctx,  7*u,13*u,   2*u,  2*u, '#00E5FF');
  },

  // 3 — Mimi : chat orange, pupilles verticales
  function(ctx, u) {
    _r(ctx,  2*u, 0,     3*u,  3*u, '#FF8F00');
    _r(ctx, 11*u, 0,     3*u,  3*u, '#FF8F00');
    _r(ctx,  3*u, 1*u,   1*u,  2*u, '#FF6D00');
    _r(ctx, 12*u, 1*u,   1*u,  2*u, '#FF6D00');
    _r(ctx,  2*u, 2*u,  12*u, 10*u, '#FF8F00');
    _r(ctx,  4*u, 3*u,   8*u,  8*u, '#FFA726');
    _r(ctx,  5*u, 5*u,   2*u,  3*u, '#FFE082');
    _r(ctx,  9*u, 5*u,   2*u,  3*u, '#FFE082');
    _r(ctx,  6*u, 5*u,   1*u,  3*u, '#1a1a1a');
    _r(ctx, 10*u, 5*u,   1*u,  3*u, '#1a1a1a');
    _r(ctx,  7*u, 8*u,   2*u,  1*u, '#F06292');
    _r(ctx,  1*u, 8*u,   4*u,  1*u, '#5D4037');
    _r(ctx, 11*u, 8*u,   4*u,  1*u, '#5D4037');
    _r(ctx,  1*u, 9*u,   3*u,  1*u, '#5D4037');
    _r(ctx, 12*u, 9*u,   3*u,  1*u, '#5D4037');
    _r(ctx,  3*u,12*u,  10*u,  4*u, '#FF8F00');
    _r(ctx,  6*u,12*u,   4*u,  4*u, '#FFA726');
  },

  // 4 — Zorg : alien vert, grands yeux
  function(ctx, u) {
    _r(ctx,  8*u, 0,     1*u,  3*u, '#81C784');
    _r(ctx,  7*u, 2*u,   3*u,  1*u, '#A5D6A7');
    _r(ctx,  8*u, 0,     1*u,  1*u, '#CE93D8');
    _r(ctx,  2*u, 2*u,  12*u, 10*u, '#66BB6A');
    _r(ctx,  1*u, 4*u,  14*u,  7*u, '#66BB6A');
    _r(ctx,  3*u, 4*u,   4*u,  5*u, '#1a1a1a');
    _r(ctx,  9*u, 4*u,   4*u,  5*u, '#1a1a1a');
    _r(ctx,  4*u, 5*u,   2*u,  3*u, '#9C27B0');
    _r(ctx, 10*u, 5*u,   2*u,  3*u, '#9C27B0');
    _r(ctx,  4*u, 5*u,   1*u,  1*u, '#FFFFFF');
    _r(ctx, 10*u, 5*u,   1*u,  1*u, '#FFFFFF');
    _r(ctx,  6*u, 9*u,   4*u,  1*u, '#388E3C');
    _r(ctx,  6*u,11*u,   4*u,  2*u, '#66BB6A');
    _r(ctx,  3*u,12*u,  10*u,  4*u, '#7E57C2');
    _r(ctx,  7*u,13*u,   2*u,  2*u, '#CE93D8');
  },

  // 5 — Shin : ninja, bandeau rouge, yeux rouges
  function(ctx, u) {
    _r(ctx,  1*u, 0,    14*u, 12*u, '#1a1a1a');
    _r(ctx,  3*u, 5*u,  10*u,  4*u, '#2d2d2d');
    _r(ctx,  2*u, 4*u,  12*u,  2*u, '#C62828');
    _r(ctx,  5*u, 4*u,   6*u,  2*u, '#B0BEC5');
    _r(ctx,  7*u, 4*u,   2*u,  2*u, '#78909C');
    _r(ctx,  4*u, 6*u,   3*u,  2*u, '#F44336');
    _r(ctx,  9*u, 6*u,   3*u,  2*u, '#F44336');
    _r(ctx,  4*u, 6*u,   1*u,  1*u, '#FF8A80');
    _r(ctx,  9*u, 6*u,   1*u,  1*u, '#FF8A80');
    _r(ctx,  3*u,12*u,  10*u,  4*u, '#1a1a1a');
    _r(ctx,  7*u,12*u,   2*u,  4*u, '#C62828');
  },

  // 6 — Jack : pirate, bandana rouge, patch d'œil
  function(ctx, u) {
    _r(ctx,  2*u, 0,    12*u,  4*u, '#C62828');
    _r(ctx,  1*u, 2*u,  14*u,  3*u, '#C62828');
    _r(ctx, 12*u, 3*u,   2*u,  3*u, '#C62828');
    _r(ctx,  3*u, 3*u,  10*u,  7*u, '#D4956A');
    _r(ctx,  3*u, 5*u,   4*u,  3*u, '#1a1a1a');
    _r(ctx,  2*u, 5*u,   2*u,  1*u, '#1a1a1a');
    _r(ctx,  9*u, 6*u,   2*u,  2*u, '#2a1a0a');
    _r(ctx,  5*u, 5*u,   1*u,  4*u, '#C07850');
    _r(ctx,  4*u, 8*u,   8*u,  1*u, '#7D5A3C');
    _r(ctx,  5*u, 9*u,   6*u,  1*u, '#7D5A3C');
    _r(ctx,  6*u,10*u,   4*u,  2*u, '#D4956A');
    _r(ctx,  3*u,12*u,  10*u,  4*u, '#FFFFFF');
    _r(ctx,  3*u,12*u,  10*u,  1*u, '#C62828');
    _r(ctx,  3*u,14*u,  10*u,  1*u, '#C62828');
  },

  // 7 — Rex : roi, couronne dorée, robe violette
  function(ctx, u) {
    _r(ctx,  2*u, 2*u,  12*u,  4*u, '#FFD700');
    _r(ctx,  2*u, 0,     2*u,  3*u, '#FFD700');
    _r(ctx,  7*u, 0,     2*u,  4*u, '#FFD700');
    _r(ctx, 12*u, 0,     2*u,  3*u, '#FFD700');
    _r(ctx,  3*u, 2*u,   1*u,  2*u, '#E53935');
    _r(ctx,  7*u, 2*u,   2*u,  2*u, '#1E88E5');
    _r(ctx, 12*u, 2*u,   1*u,  2*u, '#43A047');
    _r(ctx,  3*u, 5*u,  10*u,  6*u, '#F5C5A3');
    _r(ctx,  4*u, 6*u,   3*u,  1*u, '#5D4037');
    _r(ctx,  9*u, 6*u,   3*u,  1*u, '#5D4037');
    _r(ctx,  5*u, 7*u,   2*u,  2*u, '#2a1a0a');
    _r(ctx,  9*u, 7*u,   2*u,  2*u, '#2a1a0a');
    _r(ctx,  5*u, 9*u,   6*u,  2*u, '#5D4037');
    _r(ctx,  4*u,10*u,   2*u,  1*u, '#5D4037');
    _r(ctx, 10*u,10*u,   2*u,  1*u, '#5D4037');
    _r(ctx,  6*u,11*u,   4*u,  1*u, '#F5C5A3');
    _r(ctx,  2*u,12*u,  12*u,  4*u, '#7B1FA2');
    _r(ctx,  2*u,12*u,  12*u,  1*u, '#FFD700');
    _r(ctx,  6*u,12*u,   4*u,  4*u, '#9C27B0');
    _r(ctx,  7*u,13*u,   2*u,  3*u, '#FFD700');
  },
];
