// Reproduces the suspected defects against the real, unmodified source.
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const PROBE = "\n    window.__t = { state, DataManager, CSVDataManager, MathUtils, Renderer, UIManager," +
              " ExportManager, AircraftStateManager, EventHandlers, ScopeLoop, App, SoundManager," +
              " ThemeManager, canvasRenderer };\n";

function boot({ storage = {}, feed = null } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  vc.on('warn', () => {}); vc.on('log', () => {});

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/g, '');

  const FEED = feed || { messages: 1, aircraft: [
    { hex: 'c0ffee', flight: 'EMG999', lat: 0.1, lon: 0.1, alt_baro: 8000, gs: 200, track: 90, squawk: '7700' }] };

  const dom = new JSDOM(html, {
    url: 'http://localhost:8000/', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = u => {
        const s = String(u);
        if (!/^https?:\/\/localhost:8000\//.test(s) && !/^[a-z]/i.test(s.replace(/^https?:\/\//,''))) {}
        if (/\.invalid\//.test(s) || (/^https?:\/\//.test(s) && !s.startsWith('http://localhost:8000/')))
          return Promise.reject(new Error('unreachable host'));
        const body = s.includes('aircraft.json') ? JSON.stringify(FEED)
          : s.includes('airports.csv') ? 'icao_code,name,latitude_deg,longitude_deg,elevation_ft,type,municipality,iso_country\n'
          : s.includes('navaids.csv') ? 'ident,name,type,latitude_deg,longitude_deg,elevation_ft,frequency_khz,associated_airport\n'
          : s.includes('runways.csv') ? 'airport_ident,le_ident,he_ident,length_ft,width_ft,surface,lighted,closed,le_latitude_deg,le_longitude_deg,he_latitude_deg,he_longitude_deg,le_heading_degT,he_heading_degT\n'
          : null;
        if (body === null) return Promise.reject(new Error('unreachable host'));
        return Promise.resolve({ ok: true, status: 200,
          text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)) });
      };
      w.HTMLCanvasElement.prototype.getContext = function () {
        const n = () => () => {};
        return { canvas: this, save: n(), restore: n(), beginPath: n(), closePath: n(), moveTo: n(),
          lineTo: n(), arc: n(), rect: n(), fill: n(), stroke: n(), fillRect: n(), clearRect: n(),
          fillText: n(), translate: n(), rotate: n(), setLineDash: n(), quadraticCurveTo: n(),
          putImageData: n(), measureText: t => ({ width: String(t).length * 6 }),
          getImageData: (x, y, ww, hh) => ({ width: ww, height: hh, data: new Uint8ClampedArray(4) }) };
      };
      w.__sound = 0;
      w.AudioContext = function () {
        w.__sound++;
        return { currentTime: 0, destination: {},
          createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {} } }),
          createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }) };
      };
      w.OffscreenCanvas = undefined;
      w.__frames = [];
      w.requestAnimationFrame = cb => w.__frames.push(cb);
      w.cancelAnimationFrame = () => {};
    }
  });

  const { window } = dom, doc = window.document;
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const c = doc.getElementById('canvas-container');
  Object.defineProperty(c, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(c, 'clientHeight', { value: 800, configurable: true });
  window.HTMLCanvasElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800 });

  for (const f of ['config.js', 'app.js']) {
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (f === 'app.js') { const i = src.lastIndexOf('})();'); src = src.slice(0, i) + PROBE + src.slice(i); }
    const s = doc.createElement('script'); s.textContent = src; doc.body.appendChild(s);
    if (f === 'config.js') {
      const cfg = doc.createElement('script');
      cfg.textContent = "CONFIG.DEFAULT_HOME_LAT=0;CONFIG.DEFAULT_HOME_LON=0;" +
        "CONFIG.DEFAULT_TAR1090_URL='http://localhost:8000/data/aircraft.json';" +
        "CONFIG.DATA_PATHS.AIRPORTS='data/airports.csv';CONFIG.DATA_PATHS.NAVAIDS='data/navaids.csv';" +
        "CONFIG.DATA_PATHS.RUNWAYS='data/runways.csv';";
      doc.body.appendChild(cfg);
    }
  }
  const frames = (n, t0 = 0) => { for (let i = 0; i < n; i++) {
    const q = window.__frames.splice(0); if (!q.length) return; for (const cb of q) cb(t0 + i * 20); } };
  const g = expr => window.eval(`(function(){try{return ${expr}}catch(e){return '__ERR__: '+e.message}})()`);
  return { window, doc, frames, g, errors };
}

const out = [];
const rep = (id, title, verdict, evidence) => out.push({ id, title, verdict, evidence });

(async () => {
  // ---------------------------------------------------------------- BUG 1
  // saveSettings writes showRunways:true -> loadSettings reads it back as false
  {
    const saved = JSON.stringify({ homeLat: 0, homeLon: 0, showRunways: true, showAirports: true, soundEnabled: true });
    const { g } = boot({ storage: { adsbScope_settings: saved } });
    await new Promise(r => setTimeout(r, 120));
    const runways = g('window.__t.state.showRunways');
    const airports = g('window.__t.state.showAirports');
    rep('BUG-1', 'loadSettings inverts showRunways',
        runways === false ? 'CONFIRMED' : 'not reproduced',
        `saved {showRunways:true, showAirports:true} -> loaded showRunways=${runways} (showAirports=${airports}, correct)`);
  }

  // ---------------------------------------------------------------- BUG 2
  // frameCount is incremented twice per rendered frame -> FPS ~2x
  {
    const { g, frames, window } = boot();
    await new Promise(r => setTimeout(r, 120));
    window.eval('performance.now = () => 0;');           // freeze the 1 s FPS window
    frames(50, 0);
    const fc = g('window.__t.state.frameCount');
    rep('BUG-2', 'FPS counter double-counts every frame',
        fc >= 90 ? 'CONFIRMED' : 'not reproduced',
        `50 rendered frames -> state.frameCount = ${fc} (expected 50)`);
  }

  // ---------------------------------------------------------------- BUG 3
  // keyboard shortcuts fire while typing in the settings form
  {
    const { g, doc, window } = boot();
    await new Promise(r => setTimeout(r, 120));
    const input = doc.getElementById('home-lat');
    input.focus();
    const before = g('window.__t.state.showTrails');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 't', bubbles: true }));
    const after = g('window.__t.state.showTrails');
    rep('BUG-3', 'shortcuts fire while typing in form fields',
        before !== after ? 'CONFIRMED' : 'not reproduced',
        `typing "t" in #home-lat toggled showTrails ${before} -> ${after}`);
  }

  // ---------------------------------------------------------------- BUG 4
  // emergency tone replays on every poll; only the banner is de-duplicated
  {
    const { g, doc, window, frames } = boot();
    await new Promise(r => setTimeout(r, 120));
    doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));  // unlock audio
    let tones = 0;
    window.eval('window.__toneCount = 0;');
    const orig = g('typeof window.__t.SoundManager.playEmergencyAlert');
    window.eval('(function(){const o=window.__t.SoundManager.playEmergencyAlert;' +
                'window.__t.SoundManager.playEmergencyAlert=function(){window.__toneCount++;return o.apply(this,arguments)};})()');
    for (let i = 0; i < 4; i++) { g('window.__t.DataManager.fetchData()'); await new Promise(r => setTimeout(r, 60)); }
    frames(20);
    tones = g('window.__toneCount');
    const banners = doc.getElementById('alert-container').children.length;
    rep('BUG-4', 'emergency tone repeats every poll',
        tones >= 4 ? 'CONFIRMED' : 'not reproduced',
        `4 polls of one 7700 target -> ${tones} tone(s), ${banners} banner(s). Banner de-dup works; sound has none (typeof=${orig})`);
  }

  // BUG 5 (failed-source warning named the wrong source) is not reproducible
  // from here: warnings are now de-duplicated per outage and the banner expires
  // before this suite finishes waiting out the retry backoff. It is covered
  // properly, with a MutationObserver, by multisource.js.

  // ---------------------------------------------------------------- BUG 6
  // drawAirportsAndNavaids ignores its own airportData fallback
  {
    const { g } = boot();
    await new Promise(r => setTimeout(r, 120));
    const r = g('(function(){window.__t.state.showAirports=true;' +
                'var c=document.createElement("canvas").getContext("2d");' +
                'window.__t.canvasRenderer.drawAirportsAndNavaids(c,100,100,80);' +
                'return "no throw"})()');
    rep('BUG-6', 'drawAirportsAndNavaids throws on its documented default',
        String(r).startsWith('__ERR__') ? 'CONFIRMED' : 'not reproduced',
        `called with airports omitted (defaults to null) -> ${r}`);
  }

  console.log('\n' + '='.repeat(74));
  console.log('DEFECT REPRODUCTION — against unmodified app.js / config.js');
  console.log('='.repeat(74));
  for (const r of out) {
    console.log(`\n[${r.id}] ${r.title}\n  verdict : ${r.verdict}\n  evidence: ${r.evidence}`);
  }
  const reproduced = out.filter(r => r.verdict === 'CONFIRMED');
  if (reproduced.length) {
    console.log(`REGRESSION: ${reproduced.length} defect(s) reproduced — ` +
                reproduced.map(r => r.id).join(', '));
  } else {
    console.log(`None of the ${out.length} audited defects reproduce.`);
  }
  console.log('');
  process.exit(reproduced.length ? 1 : 0);
})();
