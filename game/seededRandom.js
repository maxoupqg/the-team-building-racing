(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    const e = factory();
    root.createRNG = e.createRNG;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Mulberry32 PRNG — returns a function producing floats in [0, 1)
  function createRNG(seed) {
    let s = seed >>> 0;
    return function () {
      s += 0x6d2b79f5;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  return { createRNG };
}));
