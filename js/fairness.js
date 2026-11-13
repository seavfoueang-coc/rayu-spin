/*
 * RAYU CODE · Spin & Win — fairness and wheel geometry.
 *
 * This file holds every decision that affects WHICH prize a visitor gets.
 * It has no DOM or animation code, so it can be audited on its own and run
 * under Node.js for the statistical test in tests/simulate.js.
 *
 * Wheel geometry convention (used by both this file and app.js):
 *   - Angles are in degrees, measured CLOCKWISE from 12 o'clock.
 *   - Segment i covers wheel-local angles [i * 90, (i + 1) * 90).
 *   - The wheel is rotated with CSS `rotate(Rdeg)`; positive R is clockwise.
 *   - The pointer is fixed at the top (screen angle 0).
 *   - A wheel-local angle θ appears on screen at θ + R, so the local angle
 *     under the pointer is  (POINTER_ANGLE − R) mod 360.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RayuFairness = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /** The four prizes, clockwise from 12 o'clock. Every entry has the same weight. */
  var PRIZES = Object.freeze([
    Object.freeze({ value: 30, label: '30%', name: '30% OFF', color: '#00e5ff' }),
    Object.freeze({ value: 50, label: '50%', name: '50% OFF', color: '#4f8bff' }),
    Object.freeze({ value: 70, label: '70%', name: '70% OFF', color: '#c084fc' }),
    Object.freeze({ value: 100, label: '100%', name: '100% OFF', color: '#fbbf24' })
  ]);

  var SEGMENT_COUNT = PRIZES.length;            // 4
  var SEGMENT_ANGLE = 360 / SEGMENT_COUNT;       // 90°
  var POINTER_ANGLE = 0;                         // pointer at the top
  /** Keep the stopping point at least this far (degrees) from a segment edge. */
  var BOUNDARY_MARGIN = 15;

  var UINT32_RANGE = 4294967296; // 2^32

  /* ------------------------------------------------------------------ */
  /* Random source                                                       */
  /* ------------------------------------------------------------------ */

  var cryptoSource = (function () {
    var c = root && (root.crypto || root.msCrypto);
    if (c && typeof c.getRandomValues === 'function') return c;
    return null;
  })();

  var warnedFallback = false;
  var buffer = new Uint32Array(1);

  /** One uniformly distributed unsigned 32-bit integer. */
  function randomUint32() {
    if (cryptoSource) {
      cryptoSource.getRandomValues(buffer);
      return buffer[0];
    }
    // Only reached in very old browsers without the Web Crypto API.
    if (!warnedFallback && typeof console !== 'undefined') {
      warnedFallback = true;
      console.warn('[RayuFairness] crypto.getRandomValues unavailable, using Math.random fallback.');
    }
    return Math.floor(Math.random() * UINT32_RANGE);
  }

  /**
   * Uniform integer in [0, n) using rejection sampling, so no value is ever
   * favoured by modulo bias. (For n = 4, 2^32 divides evenly and nothing is
   * ever rejected, but the general form is kept for clarity and safety.)
   */
  function randomInt(n) {
    if (!(n >= 1 && n <= UINT32_RANGE && Math.floor(n) === n)) {
      throw new RangeError('randomInt: n must be an integer in [1, 2^32]');
    }
    var limit = UINT32_RANGE - (UINT32_RANGE % n);
    var x;
    do {
      x = randomUint32();
    } while (x >= limit);
    return x % n;
  }

  /** Uniform float in [0, 1). Used only for cosmetic values (turns, offset, duration). */
  function randomFloat() {
    return randomUint32() / UINT32_RANGE;
  }

  /** Uniform float in [min, max). */
  function randomBetween(min, max) {
    return min + (max - min) * randomFloat();
  }

  /* ------------------------------------------------------------------ */
  /* Prize selection                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Pick the winning segment index. Each of the four indexes has exactly a
   * 1/4 chance. No state, history, or weighting is involved.
   */
  function pickPrizeIndex() {
    return randomInt(SEGMENT_COUNT);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry                                                            */
  /* ------------------------------------------------------------------ */

  /** Positive modulo: mod(-30, 360) === 330. */
  function mod(a, n) {
    return ((a % n) + n) % n;
  }

  /** Wheel-local angle that sits under the fixed pointer for rotation R. */
  function localAngleAtPointer(rotation) {
    return mod(POINTER_ANGLE - rotation, 360);
  }

  /** Index of the segment under the pointer for rotation R. */
  function segmentIndexAtPointer(rotation) {
    var idx = Math.floor(localAngleAtPointer(rotation) / SEGMENT_ANGLE);
    // Guard against a floating-point result of exactly 360.
    return Math.min(SEGMENT_COUNT - 1, Math.max(0, idx));
  }

  /** Distance (degrees) from the pointer to the nearest segment edge for rotation R. */
  function distanceToBoundary(rotation) {
    var within = mod(localAngleAtPointer(rotation), SEGMENT_ANGLE);
    return Math.min(within, SEGMENT_ANGLE - within);
  }

  /**
   * Work out the final rotation that puts `prizeIndex` under the pointer.
   *
   * @param {number} currentRotation  Current wheel rotation in degrees.
   * @param {number} prizeIndex       Winning segment (already chosen).
   * @param {{minTurns?:number,maxTurns?:number}} [options]
   * @returns {{targetRotation:number, delta:number, turns:number, offset:number, landingAngle:number}}
   */
  function planSpin(currentRotation, prizeIndex, options) {
    if (!(prizeIndex >= 0 && prizeIndex < SEGMENT_COUNT && Math.floor(prizeIndex) === prizeIndex)) {
      throw new RangeError('planSpin: invalid prize index ' + prizeIndex);
    }
    var opts = options || {};
    var minTurns = opts.minTurns != null ? opts.minTurns : 6;
    var maxTurns = opts.maxTurns != null ? opts.maxTurns : 8;

    // Random landing spot inside the winning segment, away from both edges.
    var offset = randomBetween(BOUNDARY_MARGIN, SEGMENT_ANGLE - BOUNDARY_MARGIN);
    var landingAngle = prizeIndex * SEGMENT_ANGLE + offset;

    // Rotation (mod 360) that puts landingAngle under the pointer.
    var desired = mod(POINTER_ANGLE - landingAngle, 360);
    var current = mod(currentRotation, 360);
    var forward = mod(desired - current, 360); // always spin clockwise

    var turns = minTurns + randomInt(maxTurns - minTurns + 1);
    var delta = turns * 360 + forward;

    return {
      targetRotation: currentRotation + delta,
      delta: delta,
      turns: turns,
      offset: offset,
      landingAngle: landingAngle
    };
  }

  return Object.freeze({
    PRIZES: PRIZES,
    SEGMENT_COUNT: SEGMENT_COUNT,
    SEGMENT_ANGLE: SEGMENT_ANGLE,
    POINTER_ANGLE: POINTER_ANGLE,
    BOUNDARY_MARGIN: BOUNDARY_MARGIN,
    usesCrypto: !!cryptoSource,
    randomInt: randomInt,
    randomFloat: randomFloat,
    randomBetween: randomBetween,
    pickPrizeIndex: pickPrizeIndex,
    mod: mod,
    localAngleAtPointer: localAngleAtPointer,
    segmentIndexAtPointer: segmentIndexAtPointer,
    distanceToBoundary: distanceToBoundary,
    planSpin: planSpin
  });
});
