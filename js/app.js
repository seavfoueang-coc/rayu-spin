/*
 * RAYU CODE · Spin & Win — UI, wheel rendering and spin animation.
 *
 * Flow:  ready ──SPIN NOW──▶ spinning ──wheel stops──▶ result ──SPIN AGAIN──▶ ready
 *
 * The prize is chosen by RayuFairness BEFORE the animation starts. The
 * animation then rotates the wheel to the exact angle planned for that
 * prize. When it stops, the prize shown in the popup is read back from the
 * wheel's final rotation (the segment physically under the pointer).
 */
(function () {
  'use strict';

  var F = window.RayuFairness;
  var Effects = window.RayuEffects;

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */

  var CONFIG = {
    // Normal spin timing is derived from the operator's "Spin time" setting:
    // duration = seconds × (0.9 … 1.1), full turns = seconds … seconds + 2.
    // The default of 6 s gives 5.4–6.6 s and 6–8 turns.
    spinSeconds: { min: 3, max: 15, fallback: 6 },
    reduced: { duration: [2200, 2700], minTurns: 2, maxTurns: 3 },
    popupDelay: 900,        // ms between the wheel stopping and the popup
    popupGuard: 700,        // ms after opening during which SPIN AGAIN is ignored
    pegCount: 20,           // pegs on the rim (5 per segment) → ticking sound
    ledCount: 24,
    initialRotation: -45    // centre of 30% under the pointer on load
  };

  // Visual style of each segment (index matches F.PRIZES).
  var SEGMENT_STYLE = [
    { inner: '#004c63', mid: '#00b4d6', outer: '#5ff2ff', text: '#04121f', sub: 'rgba(4,18,31,0.78)' },
    { inner: '#12205f', mid: '#2f5fe6', outer: '#7aa8ff', text: '#ffffff', sub: 'rgba(255,255,255,0.82)' },
    { inner: '#35106e', mid: '#8a3ee6', outer: '#d9a8ff', text: '#ffffff', sub: 'rgba(255,255,255,0.82)' },
    { inner: '#6e3a03', mid: '#e39a0f', outer: '#ffd866', text: '#1d1100', sub: 'rgba(29,17,0,0.78)' }
  ];

  var CONFETTI_COLORS = ['#00e5ff', '#0099cc', '#c084fc', '#4ade80', '#fbbf24', '#e2e8f0', '#4f8bff'];

  /* ------------------------------------------------------------------ */
  /* Elements and state                                                  */
  /* ------------------------------------------------------------------ */

  var $ = function (id) { return document.getElementById(id); };
  var appEl = $('app');
  var wheelEl = $('wheel');
  var discEl = $('wheel-disc');
  var pointerEl = $('pointer');
  var pointerSvg = $('pointer-svg');
  var spinBtn = $('spin-btn');
  var spinLabel = spinBtn.querySelector('.btn-label');
  var resultEl = $('result');
  var resultCard = $('result-card');
  var resultValue = $('result-value');
  var againBtn = $('spin-again-btn');
  var soundBtn = $('sound-toggle');
  var fsBtn = $('fullscreen-toggle');
  var liveRegion = $('live-region');
  var settingsBtn = $('settings-toggle');
  var settingsPanel = $('settings-panel');
  var settingsValue = $('settings-value');
  var spinTimeInput = $('spin-time');
  var spinTimeOutput = $('spin-time-output');
  var spinTimeReset = $('spin-time-reset');

  /* Operator setting, saved on this laptop only (no visitor data). */
  var SPIN_TIME_KEY = 'rayuSpin.spinSeconds';

  function clampSeconds(v) {
    var s = CONFIG.spinSeconds;
    v = Math.round(Number(v));
    if (!isFinite(v)) return s.fallback;
    return Math.min(s.max, Math.max(s.min, v));
  }

  function loadSpinSeconds() {
    try {
      var saved = window.localStorage.getItem(SPIN_TIME_KEY);
      if (saved !== null) return clampSeconds(saved);
    } catch (e) { /* storage blocked: use default */ }
    return CONFIG.spinSeconds.fallback;
  }

  function saveSpinSeconds(v) {
    try {
      if (v === CONFIG.spinSeconds.fallback) window.localStorage.removeItem(SPIN_TIME_KEY);
      else window.localStorage.setItem(SPIN_TIME_KEY, String(v));
    } catch (e) { /* storage blocked: setting lasts until reload */ }
  }

  var reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  var state = {
    phase: 'ready',          // 'ready' | 'spinning' | 'result'
    rotation: CONFIG.initialRotation,
    raf: 0,
    resultIndex: null,
    resultOpenedAt: 0,
    popupTimer: 0,
    pointerAngle: 0,
    reduced: !!(reducedQuery && reducedQuery.matches),
    spinSeconds: loadSpinSeconds(),
    spinsCompleted: 0
  };

  var sound = new window.RayuSound();
  var particles = new Effects.ParticleField($('bg-canvas'), { reduced: state.reduced });
  var confetti = new Effects.Confetti($('confetti-canvas'));

  /* ------------------------------------------------------------------ */
  /* SVG helpers                                                         */
  /* ------------------------------------------------------------------ */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  /** Point at radius r and angle deg (clockwise from 12 o'clock). */
  function polar(r, deg) {
    var a = (deg * Math.PI) / 180;
    return [r * Math.sin(a), -r * Math.cos(a)];
  }

  function fmt(n) { return Math.round(n * 1000) / 1000; }

  /** Pie slice from angle a0 to a1 (clockwise) with radius r. */
  function slicePath(r, a0, a1) {
    var p0 = polar(r, a0);
    var p1 = polar(r, a1);
    var large = a1 - a0 > 180 ? 1 : 0;
    return 'M0 0 L' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
      ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + fmt(p1[0]) + ' ' + fmt(p1[1]) + ' Z';
  }

  function gradientStops(grad, stops) {
    stops.forEach(function (s) {
      svg('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] != null ? s[2] : 1 }, grad);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Build the wheel                                                     */
  /* ------------------------------------------------------------------ */

  var SEG_R = 222;   // radius of the coloured segments
  var segmentGroups = [];

  function buildFrame() {
    var root = $('wheel-frame');
    var defs = svg('defs', null, root);

    var rim = svg('linearGradient', { id: 'rim-metal', x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
    gradientStops(rim, [[0, '#3c5279'], [0.35, '#16223f'], [0.6, '#0c1225'], [1, '#2a3b5e']]);

    var halo = svg('radialGradient', { id: 'led-halo' }, defs);
    svg('stop', { offset: 0, class: 'led-stop', 'stop-opacity': 0.9 }, halo);
    svg('stop', { offset: 1, class: 'led-stop', 'stop-opacity': 0 }, halo);

    var glow = svg('filter', { id: 'neon-glow', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
    svg('feGaussianBlur', { stdDeviation: 4, result: 'b' }, glow);
    var merge = svg('feMerge', null, glow);
    svg('feMergeNode', { in: 'b' }, merge);
    svg('feMergeNode', { in: 'SourceGraphic' }, merge);

    svg('circle', { r: 259, fill: '#050914' }, root);
    svg('circle', { r: 246, fill: 'none', stroke: 'url(#rim-metal)', 'stroke-width': 24 }, root);
    svg('circle', { r: 258, fill: 'none', stroke: 'rgba(0,229,255,0.55)', 'stroke-width': 1.5 }, root);
    svg('circle', { r: 234.5, fill: 'none', stroke: '#00e5ff', 'stroke-width': 2.5, filter: 'url(#neon-glow)', class: 'rim-neon' }, root);

    var leds = svg('g', { class: 'leds' }, root);
    for (var i = 0; i < CONFIG.ledCount; i++) {
      var p = polar(246, (360 / CONFIG.ledCount) * i + 360 / CONFIG.ledCount / 2);
      var g = svg('g', { class: 'led', style: '--i:' + i, transform: 'translate(' + fmt(p[0]) + ' ' + fmt(p[1]) + ')' }, leds);
      svg('circle', { r: 11, fill: 'url(#led-halo)', class: 'led-halo' }, g);
      svg('circle', { r: 4.3, class: 'led-core' }, g);
    }
  }

  function buildDisc() {
    var root = $('wheel-svg');
    var defs = svg('defs', null, root);

    var txtShadow = svg('filter', { id: 'label-shadow', x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs);
    svg('feDropShadow', { dx: 0, dy: 2, stdDeviation: 2.2, 'flood-color': '#000', 'flood-opacity': 0.35 }, txtShadow);

    var pegGrad = svg('radialGradient', { id: 'peg', cx: '0.35', cy: '0.35', r: '0.75' }, defs);
    gradientStops(pegGrad, [[0, '#ffffff'], [0.5, '#c9d4e8'], [1, '#56688c']]);

    svg('circle', { r: 236, fill: '#0c1225' }, root);

    F.PRIZES.forEach(function (prize, i) {
      var st = SEGMENT_STYLE[i];
      var grad = svg('radialGradient', { id: 'seg-' + i, cx: 0, cy: 0, r: SEG_R, gradientUnits: 'userSpaceOnUse' }, defs);
      gradientStops(grad, [[0, st.inner], [0.42, st.mid], [0.86, st.outer], [1, st.mid]]);

      var a0 = i * F.SEGMENT_ANGLE;
      var a1 = (i + 1) * F.SEGMENT_ANGLE;
      var center = a0 + F.SEGMENT_ANGLE / 2;

      var g = svg('g', { class: 'seg', 'data-index': i, 'data-prize': prize.name }, root);
      svg('path', { class: 'seg-fill', d: slicePath(SEG_R, a0, a1), fill: 'url(#seg-' + i + ')' }, g);
      // Faint diagonal sheen inside each slice for depth.
      svg('path', { class: 'seg-sheen', d: slicePath(SEG_R, a0 + 6, a0 + 30), fill: 'rgba(255,255,255,0.07)' }, g);
      svg('path', { class: 'seg-outline', d: slicePath(SEG_R - 3, a0 + 0.8, a1 - 0.8), fill: 'none' }, g);

      var label = svg('g', { class: 'seg-label', transform: 'rotate(' + center + ')', filter: 'url(#label-shadow)' }, g);
      var pct = svg('text', {
        class: 'seg-pct', x: 0, y: -126, 'text-anchor': 'middle', fill: st.text,
        'font-size': prize.value === 100 ? 60 : 72
      }, label);
      pct.textContent = prize.label;
      var off = svg('text', { class: 'seg-off', x: 0, y: -90, 'text-anchor': 'middle', fill: st.sub, 'font-size': 26 }, label);
      off.textContent = 'OFF';

      segmentGroups.push(g);
    });

    // Decorative concentric rings.
    [96, 150, 196].forEach(function (r) {
      svg('circle', { r: r, fill: 'none', stroke: 'rgba(255,255,255,0.07)', 'stroke-width': 1, class: 'deco' }, root);
    });
    svg('circle', { r: SEG_R, fill: 'none', stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 2, class: 'deco' }, root);

    // Segment dividers.
    for (var d = 0; d < F.SEGMENT_COUNT; d++) {
      var ang = d * F.SEGMENT_ANGLE;
      var a = polar(70, ang), b = polar(SEG_R, ang);
      svg('line', { x1: fmt(a[0]), y1: fmt(a[1]), x2: fmt(b[0]), y2: fmt(b[1]), stroke: 'rgba(0,229,255,0.35)', 'stroke-width': 9, 'stroke-linecap': 'round', class: 'deco divider-glow' }, root);
      svg('line', { x1: fmt(a[0]), y1: fmt(a[1]), x2: fmt(b[0]), y2: fmt(b[1]), stroke: '#e2e8f0', 'stroke-width': 3, 'stroke-linecap': 'round', class: 'deco' }, root);
    }

    // Pegs (one tick sound each time a peg passes the pointer).
    var pegAngle = 360 / CONFIG.pegCount;
    for (var k = 0; k < CONFIG.pegCount; k++) {
      var pp = polar(212, k * pegAngle);
      var boundary = (k * pegAngle) % F.SEGMENT_ANGLE === 0;
      svg('circle', {
        cx: fmt(pp[0]), cy: fmt(pp[1]), r: boundary ? 6.5 : 4.6,
        fill: 'url(#peg)', stroke: '#080d1a', 'stroke-width': 1.5, class: 'deco'
      }, root);
    }
  }

  function buildOverlay() {
    var root = $('wheel-overlay');
    var defs = svg('defs', null, root);

    var gloss = svg('radialGradient', { id: 'gloss', cx: -80, cy: -140, r: 300, gradientUnits: 'userSpaceOnUse' }, defs);
    gradientStops(gloss, [[0, '#ffffff', 0.22], [0.45, '#ffffff', 0.05], [1, '#ffffff', 0]]);
    var vignette = svg('radialGradient', { id: 'vignette', cx: 0, cy: 0, r: SEG_R, gradientUnits: 'userSpaceOnUse' }, defs);
    gradientStops(vignette, [[0.62, '#000', 0], [1, '#000', 0.32]]);
    var hubRing = svg('linearGradient', { id: 'hub-ring', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    gradientStops(hubRing, [[0, '#e2e8f0'], [0.3, '#5d7299'], [0.65, '#1a2744'], [1, '#00e5ff']]);
    var hubFace = svg('radialGradient', { id: 'hub-face', cx: '0.5', cy: '0.4', r: '0.65' }, defs);
    gradientStops(hubFace, [[0, '#16244a'], [1, '#060a16']]);
    var hubGlow = svg('filter', { id: 'hub-glow', x: '-40%', y: '-40%', width: '180%', height: '180%' }, defs);
    svg('feDropShadow', { dx: 0, dy: 0, stdDeviation: 7, 'flood-color': '#00e5ff', 'flood-opacity': 0.75 }, hubGlow);

    svg('circle', { r: SEG_R, fill: 'url(#vignette)' }, root);
    svg('circle', { r: SEG_R, fill: 'url(#gloss)' }, root);

    svg('circle', { r: 80, fill: 'rgba(0,0,0,0.35)' }, root); // hub shadow
    svg('circle', { r: 75, fill: 'url(#hub-ring)', filter: 'url(#hub-glow)' }, root);
    svg('circle', { r: 67, fill: 'url(#hub-face)', stroke: '#00e5ff', 'stroke-width': 2, class: 'hub-face' }, root);
    var img = svg('image', { x: -55, y: -57, width: 110, height: 110, preserveAspectRatio: 'xMidYMid meet' }, root);
    img.setAttribute('href', 'assets/rayucode-logo.png');
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', 'assets/rayucode-logo.png');
  }

  /* ------------------------------------------------------------------ */
  /* Spin easing curve                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Velocity profile: a very short smooth spin-up (first 6% of the time),
   * then a decay proportional to (1 − p)², like friction slowing the wheel.
   * Position is the normalised integral of velocity, so it ends at exactly 1.
   */
  var curve = (function buildCurve() {
    var N = 2000;
    var RAMP = 0.06;
    var pos = new Float64Array(N + 1);
    var vel = new Float64Array(N + 1);
    function v(p) {
      var ramp = p < RAMP ? Math.sin((p / RAMP) * (Math.PI / 2)) : 1;
      return ramp * (1 - p) * (1 - p);
    }
    var vmax = 0;
    for (var i = 0; i <= N; i++) {
      vel[i] = v(i / N);
      if (vel[i] > vmax) vmax = vel[i];
      if (i > 0) pos[i] = pos[i - 1] + (vel[i - 1] + vel[i]) / (2 * N);
    }
    var total = pos[N];
    for (var j = 0; j <= N; j++) { pos[j] /= total; vel[j] /= vmax; }
    pos[N] = 1;

    function sample(arr, p) {
      if (p <= 0) return arr[0];
      if (p >= 1) return arr[N];
      var x = p * N;
      var i0 = Math.floor(x);
      var f = x - i0;
      return arr[i0] + (arr[i0 + 1] - arr[i0]) * f;
    }
    return {
      position: function (p) { return sample(pos, p); },
      speed: function (p) { return sample(vel, p); }
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function setRotation(deg) {
    discEl.style.transform = 'rotate(' + deg.toFixed(4) + 'deg)';
  }

  function setPointerAngle(deg) {
    pointerSvg.style.transform = 'rotate(' + deg.toFixed(2) + 'deg)';
  }

  function setPhase(phase) {
    state.phase = phase;
    wheelEl.setAttribute('data-phase', phase);
    document.body.setAttribute('data-phase', phase);
    var busy = phase !== 'ready';
    spinBtn.disabled = busy;
    spinBtn.setAttribute('aria-disabled', busy ? 'true' : 'false');
    spinLabel.textContent = phase === 'spinning' ? 'SPINNING…' : (phase === 'result' ? 'WINNER!' : 'SPIN NOW');
  }

  function announce(text) {
    liveRegion.textContent = '';
    setTimeout(function () { liveRegion.textContent = text; }, 30);
  }

  function clearHighlight() {
    wheelEl.classList.remove('has-result');
    wheelEl.style.removeProperty('--led-color');
    segmentGroups.forEach(function (g) { g.classList.remove('is-winner'); });
  }

  /* ------------------------------------------------------------------ */
  /* Spin                                                                */
  /* ------------------------------------------------------------------ */

  function spin() {
    if (state.phase !== 'ready') return;   // blocks double clicks / repeated keys
    closeSettings(false);
    setPhase('spinning');
    clearHighlight();
    sound.unlock();

    // 1) Fair, independent choice of the prize, made before any animation.
    var prizeIndex = F.pickPrizeIndex();

    // 2) Exact final rotation for that prize (random turns + random landing
    //    point inside the segment, at least 15° from either edge).
    //    Spin time only changes duration and turns, never the prize.
    var timing = state.reduced ? CONFIG.reduced : normalTiming();
    var plan = F.planSpin(state.rotation, prizeIndex, { minTurns: timing.minTurns, maxTurns: timing.maxTurns });
    var duration = F.randomBetween(timing.duration[0], timing.duration[1]);

    announce('Spinning the wheel. Good luck!');
    animateTo(state.rotation, plan.targetRotation, duration, function () {
      onSpinComplete(prizeIndex, plan.targetRotation);
    });
  }

  function animateTo(from, to, duration, done) {
    var start = performance.now();
    var last = start;
    var pegAngle = 360 / CONFIG.pegCount;
    var lastPeg = Math.floor(from / pegAngle);
    var distance = to - from;

    sound.startSpin();

    function frame(now) {
      var p = Math.min(1, (now - start) / duration);
      var rot = p >= 1 ? to : from + distance * curve.position(p);
      var speed = p >= 1 ? 0 : curve.speed(p);
      var dt = Math.min(64, now - last);
      last = now;

      setRotation(rot);
      state.rotation = rot;

      // Ticks: one per peg crossing (at most one sound per frame).
      var peg = Math.floor(rot / pegAngle);
      if (peg !== lastPeg) {
        lastPeg = peg;
        sound.tick(speed);
        var kick = -(7 + 15 * Math.min(1, speed * 1.8));
        state.pointerAngle = Math.min(state.pointerAngle, kick);
      }
      // Pointer springs back towards rest.
      state.pointerAngle *= Math.exp(-dt / 55);
      setPointerAngle(state.pointerAngle);
      sound.updateSpin(speed);

      if (p < 1) {
        state.raf = requestAnimationFrame(frame);
      } else {
        state.raf = 0;
        state.pointerAngle = 0;
        setPointerAngle(0);
        done();
      }
    }
    state.raf = requestAnimationFrame(frame);
  }

  function onSpinComplete(plannedIndex, finalRotation) {
    sound.stopSpin();

    // Keep the same visual angle but store a small number for the next spin.
    state.rotation = F.mod(finalRotation, 360);
    setRotation(state.rotation);

    // The segment physically under the pointer decides the displayed prize.
    var landedIndex = F.segmentIndexAtPointer(state.rotation);
    if (landedIndex !== plannedIndex) {
      // Should be impossible; logged so it would be caught during testing.
      console.error('[Spin] Planned segment ' + plannedIndex + ' but wheel shows ' + landedIndex);
    }
    state.resultIndex = landedIndex;
    state.spinsCompleted += 1;

    var prize = F.PRIZES[landedIndex];
    setPhase('result');
    wheelEl.classList.add('has-result');
    wheelEl.style.setProperty('--led-color', prize.color);
    segmentGroups[landedIndex].classList.add('is-winner');

    pointerEl.classList.remove('is-bounce');
    void pointerEl.offsetWidth; // restart CSS animation
    pointerEl.classList.add('is-bounce');

    sound.stopThump();
    sound.win(prize.value === 100);

    state.popupTimer = setTimeout(function () { openResult(landedIndex); }, state.reduced ? 300 : CONFIG.popupDelay);
  }

  /* ------------------------------------------------------------------ */
  /* Result popup                                                        */
  /* ------------------------------------------------------------------ */

  function openResult(index) {
    var prize = F.PRIZES[index];
    resultValue.textContent = prize.label;
    resultCard.style.setProperty('--prize', prize.color);
    resultCard.classList.toggle('is-jackpot', prize.value === 100);
    resultEl.setAttribute('data-prize', String(prize.value));

    resultEl.hidden = false;
    appEl.inert = true;
    appEl.setAttribute('aria-hidden', 'true');
    state.resultOpenedAt = performance.now();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { resultEl.classList.add('is-open'); });
    });
    setTimeout(function () { againBtn.focus({ preventScroll: true }); }, 60);

    confetti.celebrate(CONFETTI_COLORS.concat([prize.color, prize.color]), {
      big: prize.value === 100,
      reduced: state.reduced
    });
    announce('Congratulations! You won ' + prize.name + '. Show this screen to Rayu Code staff to claim your discount.');
  }

  function spinAgain() {
    if (state.phase !== 'result' || resultEl.hidden) return;
    // Ignore an accidental press right as the popup appears (e.g. a visitor
    // still mashing Enter/Space from the spin).
    if (performance.now() - state.resultOpenedAt < CONFIG.popupGuard) return;

    sound.unlock();
    sound.stopAll();
    confetti.clear();
    resultEl.classList.remove('is-open');
    state.resultIndex = null;

    setTimeout(function () {
      resultEl.hidden = true;
      resultEl.removeAttribute('data-prize');
      resultValue.textContent = '';
      appEl.inert = false;
      appEl.removeAttribute('aria-hidden');
      clearHighlight();
      pointerEl.classList.remove('is-bounce');
      setPhase('ready');
      spinBtn.focus({ preventScroll: true });
      announce('Ready for the next spin.');
    }, state.reduced ? 0 : 280);
  }

  /* ------------------------------------------------------------------ */
  /* Sound + fullscreen controls                                         */
  /* ------------------------------------------------------------------ */

  function updateSoundButton() {
    var on = sound.enabled;
    soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    soundBtn.setAttribute('aria-label', on ? 'Sound is on. Mute sound' : 'Sound is off. Turn sound on');
    soundBtn.title = on ? 'Sound on (M)' : 'Sound off (M)';
    soundBtn.classList.toggle('is-off', !on);
  }

  function toggleSound() {
    sound.unlock();
    sound.setEnabled(!sound.enabled);
    if (sound.enabled && state.phase === 'spinning' && !document.hidden) sound.startSpin();
    updateSoundButton();
  }

  var fsSupported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (!fsSupported) return;
    var docEl = document.documentElement;
    try {
      if (isFullscreen()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        var req = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
        var res = req.call(docEl, { navigationUI: 'hide' });
        if (res && res.catch) res.catch(function () {});
      }
    } catch (e) { /* ignored: browser refused */ }
  }

  function updateFullscreenButton() {
    var fs = isFullscreen();
    fsBtn.setAttribute('aria-pressed', fs ? 'true' : 'false');
    fsBtn.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Enter fullscreen');
    fsBtn.classList.toggle('is-fullscreen', fs);
  }

  /* ------------------------------------------------------------------ */
  /* Spin time setting                                                   */
  /* ------------------------------------------------------------------ */

  function normalTiming() {
    var s = state.spinSeconds;
    return { duration: [s * 900, s * 1100], minTurns: s, maxTurns: s + 2 };
  }

  function renderSpinTime() {
    var s = state.spinSeconds;
    var text = s + ' s';
    spinTimeInput.value = String(s);
    spinTimeInput.setAttribute('aria-valuetext', s + ' seconds');
    spinTimeOutput.textContent = text;
    settingsValue.textContent = text;
    spinTimeReset.disabled = s === CONFIG.spinSeconds.fallback;
    settingsBtn.setAttribute('aria-label', 'Spin time settings, currently ' + s + ' seconds');
  }

  function setSpinSeconds(v) {
    state.spinSeconds = clampSeconds(v);
    saveSpinSeconds(state.spinSeconds);
    renderSpinTime();
  }

  function openSettings() {
    settingsPanel.hidden = false;
    settingsBtn.setAttribute('aria-expanded', 'true');
    spinTimeInput.focus({ preventScroll: true });
  }

  function closeSettings(returnFocus) {
    if (settingsPanel.hidden) return;
    settingsPanel.hidden = true;
    settingsBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) settingsBtn.focus({ preventScroll: true });
  }

  function toggleSettings() {
    if (settingsPanel.hidden) openSettings(); else closeSettings(true);
  }

  settingsBtn.addEventListener('click', toggleSettings);
  spinTimeInput.addEventListener('input', function () { setSpinSeconds(spinTimeInput.value); });
  spinTimeReset.addEventListener('click', function () {
    setSpinSeconds(CONFIG.spinSeconds.fallback);
    spinTimeInput.focus({ preventScroll: true });
  });
  // Close when clicking anywhere outside the panel.
  document.addEventListener('pointerdown', function (e) {
    if (!settingsPanel.hidden && !$('settings').contains(e.target)) closeSettings(false);
  });

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  spinBtn.addEventListener('click', spin);
  againBtn.addEventListener('click', spinAgain);
  soundBtn.addEventListener('click', toggleSound);
  if (fsSupported) {
    fsBtn.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
  } else {
    fsBtn.hidden = true;
  }

  // The popup can only be closed with SPIN AGAIN: swallow clicks on the
  // backdrop and keep keyboard focus inside the dialog.
  resultEl.addEventListener('click', function (e) {
    if (e.target === resultEl) { e.preventDefault(); e.stopPropagation(); }
  });
  resultEl.addEventListener('mousedown', function (e) {
    if (e.target !== againBtn && !againBtn.contains(e.target)) e.preventDefault(); // keep focus on SPIN AGAIN
  });

  document.addEventListener('keydown', function (e) {
    var popupOpen = !resultEl.hidden;
    if (popupOpen) {
      if (e.key === 'Tab') { e.preventDefault(); againBtn.focus(); }
      if (e.key === 'Escape') e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!settingsPanel.hidden && $('settings').contains(e.target)) {
      // Inside the settings panel: arrows move the slider; nothing spins.
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(true); }
      return;
    }
    var tag = e.target && e.target.tagName;
    var onButton = tag === 'BUTTON' || tag === 'INPUT';
    if ((e.key === ' ' || e.key === 'Enter') && !onButton) {
      e.preventDefault();
      spin();
    } else if (e.key === 'Escape') {
      closeSettings(true);
    } else if ((e.key === 's' || e.key === 'S') && state.phase === 'ready') {
      toggleSettings();
    } else if (e.key === 'm' || e.key === 'M') {
      toggleSound();
    } else if ((e.key === 'f' || e.key === 'F') && fsSupported) {
      toggleFullscreen();
    }
  });

  // Stop sound cleanly if the page is hidden mid-spin.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      sound.stopSpin(true);
    } else if (state.phase === 'spinning') {
      sound.startSpin();
    }
  });
  window.addEventListener('pagehide', function () { sound.stopAll(); });

  if (reducedQuery) {
    var onReducedChange = function (e) {
      state.reduced = e.matches;
      particles.setReduced(e.matches);
    };
    if (reducedQuery.addEventListener) reducedQuery.addEventListener('change', onReducedChange);
    else if (reducedQuery.addListener) reducedQuery.addListener(onReducedChange);
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */

  buildFrame();
  buildDisc();
  buildOverlay();
  setRotation(state.rotation);
  setPhase('ready');
  renderSpinTime();
  updateSoundButton();
  updateFullscreenButton();
  particles.start();
  document.body.classList.add('is-loaded');

  // Read-only hooks for diagnostics and automated testing.
  window.RayuSpinApp = Object.freeze({
    getPhase: function () { return state.phase; },
    getRotation: function () { return state.rotation; },
    getResultIndex: function () { return state.resultIndex; },
    getSpinsCompleted: function () { return state.spinsCompleted; },
    getSpinSeconds: function () { return state.spinSeconds; },
    getSoundState: function () {
      return { enabled: sound.enabled, context: sound.getState(), activeVoices: sound.activeVoiceCount() };
    },
    segmentAtPointer: function () { return F.segmentIndexAtPointer(state.rotation); }
  });
})();
