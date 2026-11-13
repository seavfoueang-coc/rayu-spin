/*
 * End-to-end check in real headless Microsoft Edge (or Chrome) via the
 * DevTools protocol. The browser runs OFFLINE and opens index.html from disk.
 *
 *   node tests/browser-check.mjs [spins]
 *
 * Needs Node.js 22+ (global WebSocket). Not needed to run the website.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pageUrl = pathToFileURL(path.join(root, 'index.html')).href;
const shotDir = path.join(here, 'screenshots');
mkdirSync(shotDir, { recursive: true });
const SPINS = parseInt(process.argv[2], 10) || 16;

const candidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const browserPath = candidates.find(existsSync);
if (!browserPath) throw new Error('No Edge/Chrome found');

const port = 9333;
const profile = path.join(tmpdir(), 'rayu-spin-test-' + Date.now());
const browser = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1366,768', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const log = (...a) => console.log(...a);
function check(cond, msg) {
  if (cond) log('  ok   ' + msg);
  else { failures++; log('  FAIL ' + msg); }
}

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Browser did not start');
}

const ws = new WebSocket(await getTarget());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const errors = [];
const externalRequests = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
    errors.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push('log: ' + msg.params.entry.text);
  if (msg.method === 'Network.requestWillBeSent') {
    const u = msg.params.request.url;
    if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('about:')) externalRequests.push(u);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + expr + ' → ' + r.exceptionDetails.text);
  return r.result.value;
};
async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function clickEl(selector) {
  const c = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(c.x, c.y);
}
async function key(k, code, keyCode) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
}
async function screenshot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.data, 'base64'));
}
async function waitFor(expr, timeout = 12000, step = 40) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expr)) return true;
    await sleep(step);
  }
  return false;
}
async function setViewport(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
}
async function load() {
  await send('Page.navigate', { url: pageUrl });
  await waitFor(`document.readyState === 'complete' && !!window.RayuSpinApp`, 10000);
  await sleep(700);
}

// Geometry read straight from the DOM: which segment is physically under the pointer tip?
const SEGMENT_UNDER_POINTER = `(() => {
  const w = document.getElementById('wheel').getBoundingClientRect();
  const p = document.querySelector('.pointer-svg').getBoundingClientRect();
  const x = p.left + p.width / 2;
  const y = p.bottom + w.height * 0.06;     // just below the pointer tip
  const seg = document.elementsFromPoint(x, y).map((e) => e.closest && e.closest('.seg')).find(Boolean);
  return seg ? seg.getAttribute('data-prize') : null;
})()`;

const LAYOUT = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const rect = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; };
  return {
    vw, vh,
    scrollH: document.documentElement.scrollHeight, scrollW: document.documentElement.scrollWidth,
    wheel: rect('#wheel'), pointer: rect('.pointer'), btn: rect('#spin-btn'), title: rect('.title'),
    hint: rect('.hint'), footer: rect('.footer'), header: rect('.topbar'),
    logos: [...document.images].map((i) => i.complete && i.naturalWidth > 0),
    hubLogo: (() => { const im = document.querySelector('#wheel-overlay image'); const b = im.getBBox(); return b.width > 0; })(),
    fontPct: getComputedStyle(document.querySelector('.seg-pct')).fontWeight
  };
})()`;

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  const tally = { '30% OFF': 0, '50% OFF': 0, '70% OFF': 0, '100% OFF': 0 };

  for (const [w, h] of [[1366, 768], [1920, 1080], [2576, 1010], [3840, 1080], [2560, 1440], [1024, 768]]) {
    log(`\n== Layout ${w}x${h} (offline) ==`);
    await setViewport(w, h);
    await load();
    const L = await evaluate(LAYOUT);
    const G = await evaluate(`(() => {
      const i = document.querySelector('.intro').getBoundingClientRect();
      const wh = document.getElementById('wheel').getBoundingClientRect();
      const t = document.querySelector('.title'); const words = [...t.children].map((c) => c.getBoundingClientRect().top);
      return { left: i.left, right: innerWidth - wh.right, overlap: i.right > wh.left, titleOneLine: Math.max(...words) - Math.min(...words) < 40 };
    })()`);
    check(Math.abs(G.left - G.right) < 0.06 * L.vw && !G.overlap, `text + wheel centred as a group (margins ${Math.round(G.left)} / ${Math.round(G.right)})`);
    if (w >= 1366) check(G.titleOneLine, 'SPIN & WIN on one line');
    check(L.scrollH <= L.vh && L.scrollW <= L.vw, `no scrolling (scroll ${L.scrollW}x${L.scrollH} vs ${L.vw}x${L.vh})`);
    check(L.wheel.top >= 0 && L.wheel.bottom <= L.footer.top && L.wheel.right <= L.vw, `wheel fits (${Math.round(L.wheel.w)}px, top ${Math.round(L.wheel.top)}, bottom ${Math.round(L.wheel.bottom)})`);
    check(L.pointer.top >= L.header.bottom - 1, `pointer below header (${Math.round(L.pointer.top)} ≥ ${Math.round(L.header.bottom)})`);
    check(L.btn.bottom <= L.footer.top && L.hint.bottom <= L.footer.top && L.title.top >= L.header.bottom, 'title, button and hint visible');
    check(L.logos.every(Boolean) && L.hubLogo, `logo images loaded offline (${L.logos.length} <img> + hub)`);
    await screenshot(`ready-${w}x${h}`);
  }

  log(`\n== ${SPINS} spins at 1366x768 ==`);
  await setViewport(1366, 768);
  await load();
  for (let s = 1; s <= SPINS; s++) {
    const before = await evaluate('RayuSpinApp.getSpinsCompleted()');
    await clickEl('#spin-btn');
    await clickEl('#spin-btn');   // double click attempt
    await key(' ', 'Space', 32);  // keyboard attempt while spinning
    await sleep(120);
    const st = await evaluate(`({ phase: RayuSpinApp.getPhase(), disabled: document.getElementById('spin-btn').disabled, sound: RayuSpinApp.getSoundState() })`);
    if (s === 1) {
      check(st.phase === 'spinning' && st.disabled, 'button disabled while spinning');
      check(st.sound.context === 'running', `audio context running after click (${st.sound.context})`);
      check(st.sound.activeVoices > 0, `spin sound playing (${st.sound.activeVoices} voices)`);
      await sleep(1500);
      await screenshot('spinning-1366x768');
    }
    if (s === 2) {
      // Mute mid-spin: everything must go silent.
      await sleep(800);
      await clickEl('#sound-toggle');
      await sleep(150);
      const muted = await evaluate('RayuSpinApp.getSoundState()');
      check(!muted.enabled && muted.activeVoices === 0, `mute stops all sound mid-spin (${muted.activeVoices} voices)`);
      await sleep(500);
      const still = await evaluate('RayuSpinApp.getSoundState()');
      check(still.activeVoices === 0, 'no new sounds while muted');
      await clickEl('#sound-toggle');
      const un = await evaluate('RayuSpinApp.getSoundState()');
      check(un.enabled && un.activeVoices > 0, 'unmuting mid-spin resumes the spin sound');
    }
    const t0 = Date.now();
    const stopped = await waitFor(`RayuSpinApp.getPhase() === 'result'`, 12000, 25);
    const elapsed = Date.now() - t0 + 120;
    const geo = await evaluate(SEGMENT_UNDER_POINTER);
    const opened = await waitFor(`document.getElementById('result').classList.contains('is-open')`, 3000);
    await sleep(1200);
    const shown = await evaluate(`document.getElementById('result-value').textContent + ' OFF'`);
    const completed = await evaluate('RayuSpinApp.getSpinsCompleted()');
    check(stopped && opened, `spin ${s}: stopped after ~${(elapsed / 1000).toFixed(1)}s, popup open`);
    check(geo === shown, `spin ${s}: pointer on "${geo}", popup shows "${shown}"`);
    check(completed === before + 1, `spin ${s}: exactly one spin counted despite double click`);
    tally[shown] = (tally[shown] || 0) + 1;

    if (s === 1) {
      await screenshot('popup-1366x768');
      const fit = await evaluate(`(() => { const r = document.getElementById('result-card').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
      check(fit, 'popup card fits 1366x768');
      // Popup must not close by itself, by backdrop click, or by Escape.
      await sleep(3000);
      await click(15, 400);
      await key('Escape', 'Escape', 27);
      await sleep(400);
      const stillOpen = await evaluate(`!document.getElementById('result').hidden && document.getElementById('result').classList.contains('is-open')`);
      check(stillOpen, 'popup stays open (time, backdrop click, Escape)');
      const focus = await evaluate(`document.activeElement && document.activeElement.id`);
      check(focus === 'spin-again-btn', 'SPIN AGAIN has keyboard focus');
    }

    await clickEl('#spin-again-btn');
    const reset = await waitFor(`RayuSpinApp.getPhase() === 'ready' && document.getElementById('result').hidden`, 2000);
    const after = await evaluate(`({ disabled: document.getElementById('spin-btn').disabled, label: document.querySelector('#spin-btn .btn-label').textContent, highlight: document.getElementById('wheel').classList.contains('has-result'), result: RayuSpinApp.getResultIndex(), focus: document.activeElement.id, voices: RayuSpinApp.getSoundState().activeVoices })`);
    check(reset && !after.disabled && after.label === 'SPIN NOW' && !after.highlight && after.result === null,
      `spin ${s}: SPIN AGAIN reset the wheel (focus: ${after.focus}, voices left: ${after.voices})`);
  }
  log('\nResults seen: ' + JSON.stringify(tally));
  if (SPINS >= 12) check(Object.values(tally).every((n) => n > 0), 'all four prizes appeared in the browser run');

  log('\n== Spin time setting ==');
  await setViewport(1366, 768);
  await load();
  const d0 = await evaluate(`({ s: RayuSpinApp.getSpinSeconds(), label: document.getElementById('settings-value').textContent, reset: document.getElementById('spin-time-reset').disabled })`);
  check(d0.s === 6 && d0.label === '6 s' && d0.reset, `default is 6 s (${d0.label})`);
  await clickEl('#settings-toggle');
  await sleep(250);
  const p0 = await evaluate(`({ open: !document.getElementById('settings-panel').hidden, focus: document.activeElement.id })`);
  check(p0.open && p0.focus === 'spin-time', 'panel opens with slider focused');
  await key(' ', 'Space', 32);
  await key('Enter', 'Enter', 13);
  await sleep(200);
  check(await evaluate(`RayuSpinApp.getPhase() === 'ready'`), 'Space/Enter on the slider does not spin');
  for (let i = 0; i < 3; i++) await key('ArrowLeft', 'ArrowLeft', 37);
  await sleep(150);
  const p1 = await evaluate(`({ s: RayuSpinApp.getSpinSeconds(), out: document.getElementById('spin-time-output').textContent, btn: document.getElementById('settings-value').textContent })`);
  check(p1.s === 3 && p1.out === '3 s' && p1.btn === '3 s', `slider sets 3 s (${p1.out} / ${p1.btn})`);
  await screenshot('settings-1366x768');
  await key('Escape', 'Escape', 27);
  await sleep(100);
  check(await evaluate(`document.getElementById('settings-panel').hidden`), 'Escape closes the panel');

  async function timedSpin() {
    const t = Date.now();
    await clickEl('#spin-btn');
    await waitFor(`RayuSpinApp.getPhase() === 'result'`, 20000, 20);
    const ms = Date.now() - t;
    const g = await evaluate(SEGMENT_UNDER_POINTER);
    await waitFor(`document.getElementById('result').classList.contains('is-open')`, 3000);
    await sleep(1200);
    const shown = await evaluate(`document.getElementById('result-value').textContent + ' OFF'`);
    await clickEl('#spin-again-btn');
    await waitFor(`RayuSpinApp.getPhase() === 'ready'`, 2000);
    return { ms, ok: g === shown, g };
  }
  const fast = await timedSpin();
  check(fast.ms >= 2600 && fast.ms <= 3600 && fast.ok, `3 s setting: spin took ${(fast.ms / 1000).toFixed(2)}s, pointer matches (${fast.g})`);

  await load();
  check(await evaluate(`RayuSpinApp.getSpinSeconds() === 3 && document.getElementById('settings-value').textContent === '3 s'`), 'setting kept after reload');
  await setViewport(1366, 768);
  await evaluate(`(() => { const i = document.getElementById('spin-time'); i.value = '12'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const slow = await timedSpin();
  check(slow.ms >= 10600 && slow.ms <= 13600 && slow.ok, `12 s setting: spin took ${(slow.ms / 1000).toFixed(2)}s, pointer matches (${slow.g})`);

  await clickEl('#settings-toggle');
  await sleep(200);
  await clickEl('#spin-time-reset');
  await sleep(150);
  const r = await evaluate(`({ s: RayuSpinApp.getSpinSeconds(), stored: localStorage.getItem('rayuSpin.spinSeconds'), reset: document.getElementById('spin-time-reset').disabled })`);
  check(r.s === 6 && r.stored === null && r.reset, 'reset returns to the 6 s default');
  await click(400, 400); // outside click closes the panel
  await sleep(150);
  check(await evaluate(`document.getElementById('settings-panel').hidden`), 'outside click closes the panel');
  const normal = await timedSpin();
  check(normal.ms >= 5300 && normal.ms <= 7100 && normal.ok, `default: spin took ${(normal.ms / 1000).toFixed(2)}s (5.4–6.6 s expected)`);

  log('\n== 1920x1080 popup ==');
  await setViewport(1920, 1080);
  await load();
  await clickEl('#spin-btn');
  await waitFor(`document.getElementById('result').classList.contains('is-open')`, 12000);
  await sleep(1300);
  await screenshot('popup-1920x1080');
  const fit2 = await evaluate(`(() => { const r = document.getElementById('result-card').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
  check(fit2, 'popup card fits 1920x1080');

  log('\n== Reduced motion ==');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await setViewport(1366, 768);
  await load();
  const r0 = Date.now();
  await clickEl('#spin-btn');
  await waitFor(`RayuSpinApp.getPhase() === 'result'`, 6000, 25);
  const rd = Date.now() - r0;
  const rgeo = await evaluate(SEGMENT_UNDER_POINTER);
  await waitFor(`document.getElementById('result').classList.contains('is-open')`, 3000);
  await sleep(300);
  const rshown = await evaluate(`document.getElementById('result-value').textContent + ' OFF'`);
  check(rd < 3500 && rgeo === rshown, `reduced-motion spin took ${(rd / 1000).toFixed(1)}s and matches (${rgeo})`);
  await send('Emulation.setEmulatedMedia', { features: [] });

  for (const [w, h, name] of [[390, 844, 'phone'], [820, 1180, 'tablet'], [1366, 600, 'laptop-browser-window']]) {
    log(`\n== ${name} ${w}x${h} ==`);
    await setViewport(w, h, name === 'phone');
    await load();
    const L = await evaluate(LAYOUT);
    check(L.scrollW <= L.vw, `no horizontal scroll (${L.scrollW} ≤ ${L.vw})`);
    const hdr = await evaluate(`(() => { const c = document.querySelector('.controls').getBoundingClientRect(); const b = document.querySelector('.brand').getBoundingClientRect(); return { right: c.right, left: c.left, brandRight: b.right }; })()`);
    check(hdr.right <= L.vw && hdr.left >= hdr.brandRight, `header buttons fully visible (right edge ${Math.round(hdr.right)} ≤ ${L.vw})`);
    const panel = await evaluate(`(() => { document.getElementById('settings-toggle').click(); const r = document.getElementById('settings-panel').getBoundingClientRect(); document.getElementById('settings-toggle').click(); return { l: r.left, r: r.right }; })()`);
    check(panel.l >= 0 && panel.r <= L.vw, `settings panel on screen (${Math.round(panel.l)}–${Math.round(panel.r)})`);
    check(L.wheel.left >= 0 && L.wheel.right <= L.vw, `wheel within width (${Math.round(L.wheel.w)}px)`);
    if (name !== 'laptop-browser-window') check(L.scrollH <= L.vh + 2, `fits without vertical scroll (${L.scrollH} vs ${L.vh})`);
    else check(L.scrollH <= L.vh, `fits short window (${L.scrollH} vs ${L.vh})`);
    await screenshot(`ready-${name}`);
  }

  log('\n== Errors and network ==');
  check(errors.length === 0, 'no JavaScript errors or warnings' + (errors.length ? ': ' + errors.join(' | ') : ''));
  check(externalRequests.length === 0, 'no network requests' + (externalRequests.length ? ': ' + externalRequests.join(', ') : ''));
} catch (e) {
  failures++;
  console.error(e);
} finally {
  try { ws.close(); } catch {}
  browser.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

log('\n' + (failures === 0 ? 'ALL BROWSER CHECKS PASSED' : failures + ' BROWSER CHECK(S) FAILED'));
process.exit(failures ? 1 : 0);
