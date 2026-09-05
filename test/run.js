// Boots the real index.html + config.js + app.js in jsdom, stubs the 2D canvas
// context and the network, then drives real frames and a real data poll.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const errors = [];
const logs = [];

const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => logs.push('warn: ' + a.join(' ')));
vc.on('log', (...a) => logs.push('log: ' + a.join(' ')));

// ---- fake aircraft feed --------------------------------------------------
const FEED = {
  messages: 12345,
  aircraft: [
    { hex: 'a12345', flight: 'UAL123 ', lat: 0.30, lon: -0.20, alt_baro: 35000, gs: 450, track: 270, squawk: '1200', adsb_version: 2 },
    { hex: 'ae1234', flight: 'RCH451 ', lat: 0.10, lon: 0.15, alt_baro: 24000, gs: 390, track: 90,  squawk: '4512', adsb_version: 2 }, // military range
    { hex: 'c0ffee', flight: 'EMG999 ', lat: -0.20, lon: 0.05, alt_baro: 8000,  gs: 210, track: 180, squawk: '7700', mlat: ['lat','lon'] }, // emergency + mlat
    { hex: 'b0b0b0', flight: 'GND001 ', lat: 0.01, lon: 0.01, gnd: true, gs: 12, track: 45, squawk: '2000' },
    { hex: 'deadbe', flight: 'BAD001 ', lat: 999, lon: 999, alt_baro: 1000 },      // invalid -> must be filtered
    { hex: '',       flight: 'NOHEX  ', lat: 0.1, lon: 0.1, alt_baro: 1000 }       // invalid -> must be filtered
  ]
};

const CSV = {
  airports: 'icao_code,name,latitude_deg,longitude_deg,elevation_ft,type,municipality,iso_country\nZZZZ,Test Field,0.25,0.10,100,small_airport,Testville,ZZ\n',
  navaids:  'ident,name,type,latitude_deg,longitude_deg,elevation_ft,frequency_khz,associated_airport\nTST,Test VOR,VOR,0.05,-0.10,50,11230,ZZZZ\n',
  runways:  'airport_ident,le_ident,he_ident,length_ft,width_ft,surface,lighted,closed,le_latitude_deg,le_longitude_deg,he_latitude_deg,he_longitude_deg,le_heading_degT,he_heading_degT\nZZZZ,09,27,8000,150,ASP,1,0,0.245,0.095,0.255,0.105,90,270\n'
};

const fetchLog = [];
function fakeFetch(url) {
  fetchLog.push(String(url));
  const u = String(url);
  let body;
  if (u.includes('airports.csv')) body = CSV.airports;
  else if (u.includes('navaids.csv')) body = CSV.navaids;
  else if (u.includes('runways.csv')) body = CSV.runways;
  else if (u.includes('aircraft.json')) body = JSON.stringify(FEED);
  else return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(''), json: () => Promise.resolve({}) });
  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body))
  });
}

// ---- 2D context stub: records every call so we can assert on drawing ------
const drawCalls = Object.create(null);
function makeCtx(canvas) {
  const rec = name => (...args) => { drawCalls[name] = (drawCalls[name] || 0) + 1; };
  const ctx = {
    canvas,
    save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'),
    closePath: rec('closePath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    arc: rec('arc'), rect: rec('rect'), fill: rec('fill'), stroke: rec('stroke'),
    fillRect: rec('fillRect'), clearRect: rec('clearRect'), fillText: rec('fillText'),
    strokeText: rec('strokeText'), translate: rec('translate'), rotate: rec('rotate'),
    scale: rec('scale'), setLineDash: rec('setLineDash'),
    quadraticCurveTo: rec('quadraticCurveTo'), putImageData: rec('putImageData'),
    measureText: t => { drawCalls.measureText = (drawCalls.measureText || 0) + 1; return { width: String(t).length * 6 }; },
    getImageData: (x, y, w, h) => {
      drawCalls.getImageData = (drawCalls.getImageData || 0) + 1;
      return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) };
    },
    createLinearGradient: () => ({ addColorStop() {} })
  };
  return ctx;
}

// ---- boot ----------------------------------------------------------------
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  // jsdom must not try to fetch the Tailwind CDN
  .replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/g, '');

const dom = new JSDOM(html, {
  url: 'http://localhost:8000/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  resources: undefined,
  beforeParse(window) {
    window.fetch = fakeFetch;
    window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(this); };
    window.AudioContext = function () {
      return {
        currentTime: 0, destination: {},
        createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {} } }),
        createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } })
      };
    };
    window.OffscreenCanvas = undefined;
    // deterministic frame driver
    window.__frames = [];
    window.requestAnimationFrame = cb => { window.__frames.push(cb); return window.__frames.length; };
    window.cancelAnimationFrame = () => {};
  }
});

const { window } = dom;
const doc = window.document;

// give the canvas container a size (jsdom reports 0 for everything)
const container = doc.getElementById('canvas-container');
Object.defineProperty(container, 'clientWidth', { value: 1200, configurable: true });
Object.defineProperty(container, 'clientHeight', { value: 900, configurable: true });
window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 900, width: 1200, height: 900 };
};

// inject the two application scripts in document order
// app.js is injected verbatim except for ONE appended probe line that exposes
// the IIFE internals as window.__t, so the harness can assert on real state.
const PROBE = "\n    window.__t = { state, DataManager, CSVDataManager, MathUtils, Renderer, " +
              "UIManager, ExportManager, AircraftStateManager, EventHandlers, ScopeLoop, App, " +
              "ThemeManager, URLValidator, SoundManager };\n";
for (const f of ['config.js', 'app.js']) {
  let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (f === 'app.js') {
    const idx = src.lastIndexOf('})();');
    if (idx < 0) throw new Error('could not locate IIFE close in app.js');
    src = src.slice(0, idx) + PROBE + src.slice(idx);
  }
  const s = doc.createElement('script');
  s.textContent = src;
  doc.body.appendChild(s);
  if (f === 'config.js') {
    // Stand in for the three values every install must set in config.js.
    const cfg = doc.createElement('script');
    cfg.textContent = `
      CONFIG.DEFAULT_HOME_LAT = 0.0;
      CONFIG.DEFAULT_HOME_LON = 0.0;
      CONFIG.DEFAULT_TAR1090_URL = 'http://localhost:8000/data/aircraft.json';
      CONFIG.DATA_PATHS.AIRPORTS = 'data/airports.csv';
      CONFIG.DATA_PATHS.NAVAIDS  = 'data/navaids.csv';
      CONFIG.DATA_PATHS.RUNWAYS  = 'data/runways.csv';
    `;
    doc.body.appendChild(cfg);
  }
}

function frames(n, startTime = 0, step = 20) {
  for (let i = 0; i < n; i++) {
    const q = window.__frames.splice(0, window.__frames.length);
    if (!q.length) return i;
    for (const cb of q) cb(startTime + i * step);
  }
  return n;
}

const results = [];
const check = (name, cond, detail = '') =>
  results.push({ name, pass: !!cond, detail: String(detail) });

(async () => {
  // App.init runs on DOMContentLoaded / immediately
  await new Promise(r => setTimeout(r, 50));
  frames(5);
  await new Promise(r => setTimeout(r, 250));   // let CSV + feed promises settle
  frames(400, 0, 20);                            // ~8 s of scope time, > 2 sweeps
  await new Promise(r => setTimeout(r, 150));
  frames(200, 8000, 20);
  await new Promise(r => setTimeout(r, 150));
  frames(200, 12000, 20);

  const g = k => window.eval(`(function(){try{return ${k}}catch(e){return '__ERR__'+e.message}})()`);

  // --- 1. boot -----------------------------------------------------------
  check('config.js + app.js execute without throwing', errors.length === 0, errors.slice(0, 4).join(' | '));
  check('version string reaches the DOM', /v0\.0\.2/.test(doc.getElementById('version-display').innerHTML),
        doc.getElementById('version-display').innerHTML);
  check('document.title carries the version', /v0\.0\.2/.test(doc.title), doc.title);

  // --- 2. data pipeline --------------------------------------------------
  check('feed was polled', fetchLog.some(u => u.includes('aircraft.json')), fetchLog.length + ' requests');
  check('all three CSVs were requested',
        ['airports.csv', 'navaids.csv', 'runways.csv'].every(f => fetchLog.some(u => u.includes(f))));
  check('reference data parsed (1 airport / 1 navaid / 1 runway)',
        g('window.__t.state.airports.length') === 1 &&
        g('window.__t.state.navaids.length') === 1 &&
        g('window.__t.state.runways.length') === 1,
        `${g('window.__t.state.airports.length')}/${g('window.__t.state.navaids.length')}/${g('window.__t.state.runways.length')}`);
  check('invalid aircraft filtered out (4 of 6 kept)',
        Object.keys(g('window.__t.state.aircraftData') || {}).length === 4,
        Object.keys(g('window.__t.state.aircraftData') || {}).join(','));

  // --- 3. sweep-gated display -------------------------------------------
  const displayed = Object.keys(g('window.__t.state.displayedAircraft') || {});
  check('sweep promoted aircraft to the display', displayed.length > 0, displayed.join(','));
  check('ground traffic reaches the display despite having no alt_baro',
        displayed.includes('B0B0B0'), displayed.join(','));
  check('trails accumulated geographic points',
        g('Object.values(window.__t.state.displayedAircraft).some(a=>a.geoTrail && a.geoTrail.length>0)'));
  check('distance computed for every displayed aircraft',
        displayed.length > 0 &&
        g('Object.values(window.__t.state.displayedAircraft).every(a=>typeof a.dist==="number")'),
        displayed.length + ' displayed');

  // --- 4. rendering ------------------------------------------------------
  check('canvas was painted (fillRect + stroke + fillText)',
        drawCalls.fillRect > 0 && drawCalls.stroke > 0 && drawCalls.fillText > 0,
        JSON.stringify({ fillRect: drawCalls.fillRect, stroke: drawCalls.stroke, fillText: drawCalls.fillText, arc: drawCalls.arc }));
  check('static layer cached via getImageData/putImageData',
        drawCalls.getImageData > 0 && drawCalls.putImageData > 0,
        `getImageData=${drawCalls.getImageData} putImageData=${drawCalls.putImageData}`);

  // --- 5. UI panels ------------------------------------------------------
  const listHTML = doc.getElementById('aircraft-list-body').innerHTML;
  check('aircraft table populated', /aircraft-row/.test(listHTML), listHTML.slice(0, 80));
  check('metrics panel populated', /Session Stats/.test(doc.getElementById('metrics-panel').innerHTML));
  check('status bar shows connection OK', /CONN: OK/.test(doc.getElementById('scope-status-bar').innerHTML),
        doc.getElementById('scope-status-bar').textContent.slice(0, 90));
  check('shortcut bar rendered', doc.getElementById('shortcut-bar').children.length > 0);
  check('theme menus built (35 UI / 51 scope)',
        doc.getElementById('scope-theme-menu').querySelectorAll('[data-theme-id]').length === 51 &&
        doc.getElementById('ui-theme-menu').querySelectorAll('[data-theme]').length === 35,
        `${doc.getElementById('ui-theme-menu').querySelectorAll('[data-theme]').length}/${doc.getElementById('scope-theme-menu').querySelectorAll('[data-theme-id]').length}`);

  // --- 6. emergency ------------------------------------------------------
  check('emergency banner raised for squawk 7700',
        /EMERGENCY/.test(doc.getElementById('alert-container').innerHTML),
        doc.getElementById('alert-container').textContent.trim().slice(0, 60));
  check('emergency banner de-duplicated (exactly 1)',
        doc.getElementById('alert-container').children.length === 1,
        doc.getElementById('alert-container').children.length + ' banners');

  // --- 7. classification -------------------------------------------------
  check('military heuristic flags ae1234', g('window.__t.DataManager.isMilitary("ae1234")') === true);
  check('civilian heuristic clears a12345', g('window.__t.DataManager.isMilitary("a12345")') === false);
  check('mlat target classified as M', g('window.__t.DataManager.getDataSourceIndicator({mlat:["x"]})') === 'M');

  // --- 8. interaction ----------------------------------------------------
  const rangeBefore = g('window.__t.state.maxRangeNm');
  doc.getElementById('vectors-button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('toolbar toggle flips showVectors', g('window.__t.state.showVectors') === true);
  const kd = k => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  kd('+'); kd('+');
  check('keyboard zoom changes range', g('window.__t.state.maxRangeNm') === rangeBefore + 10,
        `${rangeBefore} -> ${g('window.__t.state.maxRangeNm')}`);
  kd(' ');
  check('space pauses the scope', g('window.__t.state.isPaused') === true);
  kd(' ');
  kd('m');
  check('M cycles the aircraft filter', g('window.__t.state.aircraftFilter') === 'military',
        g('window.__t.state.aircraftFilter'));
  kd('m'); kd('m');
  kd('h');
  check('H opens the help modal', !doc.getElementById('help-modal').classList.contains('hidden'));

  // --- 9. export ---------------------------------------------------------
  const saved = [];
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};
  const origClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () { saved.push(this.download); };
  g('window.__t.ExportManager.exportCSV()');
  g('window.__t.ExportManager.exportKML()');
  g('window.__t.ExportManager.exportStatistics()');
  window.HTMLAnchorElement.prototype.click = origClick;
  check('all three exports produce a download',
        saved.join(',') === 'aircraft_data.csv,aircraft_positions.kml,adsb_statistics.json', saved.join(','));

  // --- 10. persistence ---------------------------------------------------
  await new Promise(r => setTimeout(r, 700));   // LOCALSTORAGE_DEBOUNCE_MS = 500
  check('localStorage keys written',
        window.localStorage.getItem('adsbScope_uiState') !== null,
        Object.keys(window.localStorage).join(','));

  // --- 11. teardown ------------------------------------------------------
  const before = g('window.__t.state.intervals.length');
  window.dispatchEvent(new window.Event('beforeunload'));
  check('cleanup clears intervals and listeners',
        g('window.__t.state.intervals.length') === 0 && g('window.__t.state.eventListeners.length') === 0,
        `intervals ${before} -> ${g('window.__t.state.intervals.length')}`);

  // ---- report -----------------------------------------------------------
  const pass = results.filter(r => r.pass).length;
  console.log('\n' + '='.repeat(72));
  console.log(`RUNTIME VERIFICATION — ${pass}/${results.length} checks passed`);
  console.log('='.repeat(72));
  for (const r of results) {
    console.log(`${r.pass ? ' PASS' : '*FAIL'}  ${r.name}${r.detail ? '\n         ' + r.detail : ''}`);
  }
  if (errors.length) {
    console.log('\n--- uncaught errors -------------------------------------------------');
    errors.slice(0, 10).forEach(e => console.log('  ' + e.split('\n').slice(0, 3).join('\n  ')));
  }
  const warns = logs.filter(l => l.startsWith('warn'));
  if (warns.length) {
    console.log('\n--- warnings --------------------------------------------------------');
    [...new Set(warns)].slice(0, 8).forEach(w => console.log('  ' + w));
  }
  console.log('\n--- console output from the app -------------------------------------');
  logs.filter(l => l.startsWith('log')).slice(0, 6).forEach(l => console.log('  ' + l));
  process.exit(pass === results.length ? 0 : 1);
})();
