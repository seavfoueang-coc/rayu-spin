/*
 * RAYU CODE · Spin & Win — sound effects.
 *
 * Every sound is synthesised with the Web Audio API, so there are no audio
 * files to download and nothing needs the internet.
 *
 * The AudioContext is created on the first user gesture (unlock()), which
 * satisfies Chrome/Edge autoplay rules.
 */
(function (root) {
  'use strict';

  var MASTER_VOLUME = 0.85;

  function SoundEngine() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.spinVoice = null;
    this.voices = new Set(); // every scheduled one-shot source, so we can stop them
  }

  SoundEngine.prototype.isSupported = function () {
    return !!(root.AudioContext || root.webkitAudioContext);
  };

  /** Create/resume the audio context. Call from a click or key handler. */
  SoundEngine.prototype.unlock = function () {
    if (!this.isSupported()) return;
    if (!this.ctx) {
      var AC = root.AudioContext || root.webkitAudioContext;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch (e) {
        try { this.ctx = new AC(); } catch (e2) { this.ctx = null; return; }
      }
      var ctx = this.ctx;

      var compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.knee.value = 12;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.2;

      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? MASTER_VOLUME : 0;
      this.master.connect(compressor);
      compressor.connect(ctx.destination);

      // Two seconds of white noise, reused by ticks and the spin rumble.
      var len = Math.floor(ctx.sampleRate * 2);
      this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = this.noiseBuffer.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(function () {});
    }
  };

  SoundEngine.prototype.getState = function () {
    return this.ctx ? this.ctx.state : 'none';
  };

  SoundEngine.prototype.activeVoiceCount = function () {
    return this.voices.size + (this.spinVoice ? 1 : 0);
  };

  SoundEngine.prototype._ready = function () {
    return this.enabled && this.ctx && this.ctx.state !== 'closed';
  };

  SoundEngine.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(this.enabled ? MASTER_VOLUME : 0, t + 0.03);
    if (!this.enabled) this.stopAll();
  };

  /** Register a source node so stopAll() can silence it. */
  SoundEngine.prototype._track = function (node) {
    var voices = this.voices;
    voices.add(node);
    node.onended = function () {
      voices.delete(node);
      try { node.disconnect(); } catch (e) {}
    };
    return node;
  };

  /** Play a pitched note with an attack/decay envelope. */
  SoundEngine.prototype._note = function (opts) {
    var ctx = this.ctx;
    var t = opts.time;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'triangle';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd) osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
    if (opts.detune) osc.detune.value = opts.detune;
    var peak = opts.gain != null ? opts.gain : 0.2;
    var attack = opts.attack != null ? opts.attack : 0.008;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    osc.connect(gain);
    gain.connect(opts.out || this.master);
    osc.start(t);
    osc.stop(t + opts.dur + 0.05);
    this._track(osc);
  };

  /**
   * Mechanical tick from a peg passing the pointer.
   * @param {number} speed 0 (stopped) … 1 (full speed)
   */
  SoundEngine.prototype.tick = function (speed) {
    if (!this._ready()) return;
    var ctx = this.ctx;
    var t = ctx.currentTime;
    var s = Math.max(0, Math.min(1, speed));

    // Short filtered noise burst = the "clack" of plastic on a peg.
    var src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 + 900 * s + Math.random() * 300;
    bp.Q.value = 2.2;
    var g = ctx.createGain();
    var vol = 0.32 - 0.12 * s; // slow ticks stand out a little more
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t, Math.random() * 1.8, 0.05);
    this._track(src);

    // Small woody knock underneath.
    this._note({ time: t, type: 'triangle', freq: 1250 + 300 * s, freqEnd: 520, dur: 0.045, gain: 0.11, attack: 0.001 });
  };

  /** Start the rushing "air" sound of the spinning wheel. */
  SoundEngine.prototype.startSpin = function () {
    if (!this._ready()) return;
    this.stopSpin(true);
    var ctx = this.ctx;
    var t = ctx.currentTime;

    var src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.8;

    var hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 70;
    var humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 220;
    var humGain = ctx.createGain();
    humGain.gain.value = 0;

    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);

    src.connect(filter);
    filter.connect(gain);
    hum.connect(humFilter);
    humFilter.connect(humGain);
    humGain.connect(gain);
    gain.connect(this.master);

    src.start(t);
    hum.start(t);
    this.spinVoice = { src: src, hum: hum, filter: filter, gain: gain, humGain: humGain };
  };

  /** Follow the wheel speed (0…1) so the rumble slows down with the wheel. */
  SoundEngine.prototype.updateSpin = function (speed) {
    var v = this.spinVoice;
    if (!v || !this.ctx) return;
    var t = this.ctx.currentTime;
    var s = Math.max(0, Math.min(1, speed));
    v.filter.frequency.setTargetAtTime(260 + 2000 * s, t, 0.05);
    v.gain.gain.setTargetAtTime(0.13 * Math.pow(s, 1.3), t, 0.06);
    v.humGain.gain.setTargetAtTime(0.35 * s, t, 0.06);
    v.hum.frequency.setTargetAtTime(40 + 70 * s, t, 0.06);
    v.src.playbackRate.setTargetAtTime(0.55 + 0.6 * s, t, 0.06);
  };

  SoundEngine.prototype.stopSpin = function (immediate) {
    var v = this.spinVoice;
    if (!v) return;
    this.spinVoice = null;
    var t = this.ctx.currentTime;
    var end = t + (immediate ? 0.02 : 0.14);
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, end);
    try { v.src.stop(end + 0.02); } catch (e) {}
    try { v.hum.stop(end + 0.02); } catch (e) {}
    setTimeout(function () {
      try { v.gain.disconnect(); } catch (e) {}
    }, (end - t) * 1000 + 80);
  };

  /** Soft thump when the wheel comes to rest. */
  SoundEngine.prototype.stopThump = function () {
    if (!this._ready()) return;
    var t = this.ctx.currentTime;
    this._note({ time: t, type: 'sine', freq: 150, freqEnd: 55, dur: 0.32, gain: 0.45, attack: 0.004 });
    this._note({ time: t, type: 'triangle', freq: 900, freqEnd: 300, dur: 0.06, gain: 0.12, attack: 0.001 });
  };

  /**
   * Celebration jingle.
   * @param {boolean} jackpot  true for 100% OFF (longer fanfare)
   */
  SoundEngine.prototype.win = function (jackpot) {
    if (!this._ready()) return;
    var ctx = this.ctx;
    var t0 = ctx.currentTime + 0.04;
    var self = this;

    // Rising arpeggio: C5 E5 G5 C6 (E6 G6 for the jackpot).
    var arp = jackpot
      ? [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568.0]
      : [523.25, 659.25, 783.99, 1046.5];
    arp.forEach(function (f, i) {
      var t = t0 + i * 0.085;
      self._note({ time: t, type: 'triangle', freq: f, dur: 0.32, gain: 0.2 });
      self._note({ time: t, type: 'sine', freq: f * 2, dur: 0.22, gain: 0.05 });
    });

    // Sustained major chord with a slight detune for width.
    var chordAt = t0 + arp.length * 0.085 + 0.02;
    var chord = jackpot ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [523.25, 659.25, 783.99, 1046.5];
    chord.forEach(function (f) {
      self._note({ time: chordAt, type: 'triangle', freq: f, dur: jackpot ? 1.9 : 1.35, gain: 0.11, attack: 0.02, detune: -6 });
      self._note({ time: chordAt, type: 'sine', freq: f, dur: jackpot ? 1.9 : 1.35, gain: 0.08, attack: 0.02, detune: 6 });
    });
    // Low root for weight.
    this._note({ time: chordAt, type: 'sine', freq: 130.81, dur: 1.2, gain: 0.25, attack: 0.01 });

    // Sparkles.
    var sparkles = jackpot ? 16 : 9;
    for (var i = 0; i < sparkles; i++) {
      var st = chordAt + 0.05 + i * 0.07 + Math.random() * 0.04;
      var sf = 2000 + Math.random() * 2600;
      this._note({ time: st, type: 'sine', freq: sf, dur: 0.18, gain: 0.04 + Math.random() * 0.03, attack: 0.002 });
    }
  };

  /** Silence everything immediately (used when muting or resetting). */
  SoundEngine.prototype.stopAll = function () {
    this.stopSpin(true);
    this.voices.forEach(function (node) {
      try { node.stop(); } catch (e) {}
      try { node.disconnect(); } catch (e) {}
    });
    this.voices.clear();
  };

  root.RayuSound = SoundEngine;
})(window);
