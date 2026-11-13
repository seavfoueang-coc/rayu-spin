/*
 * RAYU CODE · Spin & Win — visual effects.
 *   ParticleField : slow floating network of glowing dots behind the page.
 *   Confetti      : canvas confetti bursts for the winning popup.
 * Both are DPR-aware and pause when the page is hidden.
 */
(function (root) {
  'use strict';

  function fitCanvas(canvas, ctx) {
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var w = root.innerWidth;
    var h = root.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  /* ------------------------------------------------------------------ */
  /* Background particles                                                */
  /* ------------------------------------------------------------------ */

  var PARTICLE_COLORS = ['0,229,255', '192,132,252', '79,139,255', '0,229,255'];

  function ParticleField(canvas, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.reduced = !!(options && options.reduced);
    this.particles = [];
    this.raf = 0;
    this.last = 0;
    this.size = { w: 0, h: 0 };
    var self = this;
    this._frame = function (now) { self.frame(now); };
    this._resize = function () { self.resize(); };
    root.addEventListener('resize', this._resize);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) self.stop(); else self.start();
    });
    this.resize();
  }

  ParticleField.prototype.resize = function () {
    this.size = fitCanvas(this.canvas, this.ctx);
    var target = Math.round(Math.min(110, (this.size.w * this.size.h) / 15000));
    var list = this.particles;
    while (list.length < target) list.push(this.spawn(true));
    list.length = target;
    if (this.reduced) this.draw();
  };

  ParticleField.prototype.spawn = function (anywhere) {
    var w = this.size.w, h = this.size.h;
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 10,
      vx: (Math.random() - 0.5) * 0.12,
      vy: -(0.05 + Math.random() * 0.22),
      r: 0.6 + Math.random() * 1.8,
      c: PARTICLE_COLORS[(Math.random() * PARTICLE_COLORS.length) | 0],
      phase: Math.random() * Math.PI * 2,
      twinkle: 0.4 + Math.random() * 1.2
    };
  };

  ParticleField.prototype.setReduced = function (reduced) {
    this.reduced = reduced;
    if (reduced) { this.stop(); this.draw(); } else { this.start(); }
  };

  ParticleField.prototype.start = function () {
    if (this.raf || this.reduced || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this._frame);
  };

  ParticleField.prototype.stop = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  ParticleField.prototype.frame = function (now) {
    var dt = Math.min(50, now - this.last) / 16.67;
    this.last = now;
    var w = this.size.w, h = this.size.h;
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.phase += 0.02 * p.twinkle * dt;
      if (p.y < -10 || p.x < -10 || p.x > w + 10) this.particles[i] = this.spawn(false);
    }
    this.draw();
    this.raf = requestAnimationFrame(this._frame);
  };

  ParticleField.prototype.draw = function () {
    var ctx = this.ctx;
    var list = this.particles;
    var w = this.size.w, h = this.size.h;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // Faint links between nearby dots.
    var maxD = 120, maxD2 = maxD * maxD;
    ctx.lineWidth = 0.6;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      for (var j = i + 1; j < list.length; j++) {
        var b = list[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d2 = dx * dx + dy * dy;
        if (d2 < maxD2) {
          var alpha = (1 - Math.sqrt(d2) / maxD) * 0.12;
          ctx.strokeStyle = 'rgba(0,229,255,' + alpha.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    for (var k = 0; k < list.length; k++) {
      var p = list[k];
      var o = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(p.phase));
      ctx.fillStyle = 'rgba(' + p.c + ',' + (o * 0.18).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(' + p.c + ',' + o.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  };

  /* ------------------------------------------------------------------ */
  /* Confetti                                                            */
  /* ------------------------------------------------------------------ */

  function Confetti(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pieces = [];
    this.raf = 0;
    this.last = 0;
    this.timers = [];
    this.size = fitCanvas(canvas, this.ctx);
    var self = this;
    this._frame = function (now) { self.frame(now); };
    root.addEventListener('resize', function () { self.size = fitCanvas(self.canvas, self.ctx); });
  }

  /**
   * @param {{x:number,y:number,count:number,angle:number,spread:number,speed:number,colors:string[]}} o
   * angle in degrees: -90 = straight up.
   */
  Confetti.prototype.burst = function (o) {
    for (var i = 0; i < o.count; i++) {
      var ang = (o.angle + (Math.random() - 0.5) * o.spread) * Math.PI / 180;
      var sp = o.speed * (0.45 + Math.random() * 0.75);
      this.pieces.push({
        x: o.x,
        y: o.y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        w: 6 + Math.random() * 8,
        h: 4 + Math.random() * 6,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.35,
        tilt: Math.random() * Math.PI * 2,
        vt: 0.08 + Math.random() * 0.18,
        shape: Math.random() < 0.22 ? 'circle' : (Math.random() < 0.15 ? 'star' : 'rect'),
        color: o.colors[(Math.random() * o.colors.length) | 0],
        life: 0,
        maxLife: 260 + Math.random() * 160
      });
    }
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this._frame);
    }
  };

  /** Full celebration: side cannons + centre fountain, in waves. */
  Confetti.prototype.celebrate = function (colors, options) {
    var self = this;
    var big = options && options.big;
    var light = options && options.reduced;
    var w = this.size.w, h = this.size.h;
    var scale = Math.max(0.6, Math.min(1.4, w / 1366));
    var n = light ? 0.35 : 1;

    function wave(mult) {
      var c = Math.round(110 * mult * n);
      self.burst({ x: -10, y: h * 0.9, count: c, angle: -58, spread: 34, speed: 26 * scale, colors: colors });
      self.burst({ x: w + 10, y: h * 0.9, count: c, angle: -122, spread: 34, speed: 26 * scale, colors: colors });
      self.burst({ x: w / 2, y: h * 0.45, count: Math.round(c * 0.9), angle: -90, spread: 360, speed: 17 * scale, colors: colors });
    }

    wave(1);
    if (light) return;
    this.timers.push(setTimeout(function () { wave(0.7); }, 420));
    if (big) {
      this.timers.push(setTimeout(function () { wave(0.9); }, 900));
      this.timers.push(setTimeout(function () { self.rain(colors, 2600); }, 1200));
    }
  };

  /** Gentle confetti falling from the top for `ms` milliseconds. */
  Confetti.prototype.rain = function (colors, ms) {
    var self = this;
    var end = performance.now() + ms;
    function drop() {
      if (performance.now() > end) return;
      for (var i = 0; i < 6; i++) {
        self.burst({ x: Math.random() * self.size.w, y: -20, count: 1, angle: 90, spread: 40, speed: 3, colors: colors });
      }
      self.timers.push(setTimeout(drop, 60));
    }
    drop();
  };

  Confetti.prototype.frame = function (now) {
    var dt = Math.min(48, now - this.last) / 16.67;
    this.last = now;
    var ctx = this.ctx;
    var w = this.size.w, h = this.size.h;
    ctx.clearRect(0, 0, w, h);

    var alive = [];
    for (var i = 0; i < this.pieces.length; i++) {
      var p = this.pieces[i];
      p.life += dt;
      p.vy += 0.42 * dt;               // gravity
      p.vx *= Math.pow(0.965, dt);     // air drag
      p.vy *= Math.pow(0.965, dt);
      p.vx += Math.sin(p.tilt) * 0.08 * dt; // flutter
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.tilt += p.vt * dt;
      if (p.y > h + 40 || p.life > p.maxLife) continue;
      alive.push(p);

      var fade = p.life > p.maxLife - 40 ? (p.maxLife - p.life) / 40 : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, fade);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.tilt));
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.h * 0.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.shape === 'star') {
        drawStar(ctx, p.w * 0.7);
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    this.pieces = alive;

    if (alive.length) {
      this.raf = requestAnimationFrame(this._frame);
    } else {
      this.raf = 0;
      ctx.clearRect(0, 0, w, h);
    }
  };

  function drawStar(ctx, r) {
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var rad = i % 2 === 0 ? r : r * 0.45;
      var a = (i * Math.PI) / 5 - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
  }

  Confetti.prototype.clear = function () {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.pieces = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ctx.clearRect(0, 0, this.size.w, this.size.h);
  };

  root.RayuEffects = { ParticleField: ParticleField, Confetti: Confetti };
})(window);
