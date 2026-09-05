// Regression suite for the two critical data-fetch defects (KNOWN_ISSUES 2 and
// 3): a dead source used to stop all polling, and every failed request used to
// raise a spurious error banner through an unhandled rejection.
//
// These take ~30 s: each poll walks the real 1 s / 2 s / 4 s retry backoff.
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const unhandled = [];
process.on('unhandledRejection', () => unhandled.push(1));

const PROBE = "\n    window.__t = { state, DataManager, MathUtils, Renderer, UIManager," +
              " EventHandlers, ScopeLoop, App, PositionManager, CONFIG };\n";

const FEED = { messages: 1, aircraft: [
  { hex: 'a12345', flight: 'TEST01', lat: 0.2, lon: 0.1, alt_baro: 30000,
    gs: 400, track: 90, squawk: '1200', adsb_version: 2 }] };

const CSV_HEADERS = {
  airports: 'icao_code,name,latitude_deg,longitude_deg,elevation_ft,type,municipality,iso_country\n',
  navaids: 'ident,name,type,latitude_deg,longitude_deg,elevation_ft,frequency_khz,associated_airport\n',
  runways: 'airport_ident,le_ident,he_ident,length_ft,width_ft,surface,lighted,closed,' +
           'le_latitude_deg,le_longitude_deg,he_latitude_deg,he_longitude_deg,le_heading_degT,he_heading_degT\n'
};

/**
 * Boots the application with a given set of data sources. Only localhost:8000
 * is reachable; every other host rejects, which is how a dead feed is
 * simulated.
 */
function boot(sources) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {}); vc.on('error', () => {});
  vc.on('warn', () => {}); vc.on('log', () => {});

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/g, '');

  const dom = new JSDOM(html, {
    url: 'http://localhost:8000/', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = u => {
        const s = String(u);
        if (/^https?:\/\//.test(s) && !s.startsWith('http://localhost:8000/')) {
          return Promise.reject(new Error('unreachable host'));
        }
        const body = s.includes('aircraft.json') ? JSON.stringify(FEED)
          : s.includes('airports.csv') ? CSV_HEADERS.airports
          : s.includes('navaids.csv') ? CSV_HEADERS.navaids
          : s.includes('runways.csv') ? CSV_HEADERS.runways
          : null;
        if (body === null) return Promise.reject(new Error('404'));
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null },
          text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)) });
      };
      w.HTMLCanvasElement.prototype.getContext = function () {
        const n = () => () => {};
        return { canvas: this, save: n(), restore: n(), beginPath: n(), closePath: n(),
          moveTo: n(), lineTo: n(), arc: n(), rect: n(), fill: n(), stroke: n(),
          fillRect: n(), clearRect: n(), fillText: n(), translate: n(), rotate: n(),
          setLineDash: n(), quadraticCurveTo: n(), putImageData: n(),
          measureText: t => ({ width: String(t).length * 6 }),
          getImageData: (x, y, w2, h2) => ({ width: w2, height: h2, data: new Uint8ClampedArray(4) }) };
      };
      w.AudioContext = function () {
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
  window.localStorage.setItem('adsbScope_settings',
    JSON.stringify({ homeLat: 0, homeLon: 0, dataSources: sources }));

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
        "CONFIG.DATA_PATHS.AIRPORTS='data/airports.csv';" +
        "CONFIG.DATA_PATHS.NAVAIDS='data/navaids.csv';" +
        "CONFIG.DATA_PATHS.RUNWAYS='data/runways.csv';";
      doc.body.appendChild(cfg);
    }
  }

  // Warning banners self-remove after 7 s, well before these suites finish
  // waiting out the retry backoff, so record them as they appear.
  const warnings = [];
  const observer = new window.MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.textContent) warnings.push(node.textContent.replace(/\s+/g, ' ').trim());
      }
    }
  });
  observer.observe(doc.getElementById('error-display'), { childList: true });

  const g = e => window.eval(`(function(){try{return ${e}}catch(err){return '__ERR__: '+err.message}})()`);
  return { window, doc, g, warnings };
}

const GOOD = { url: 'http://localhost:8000/data/aircraft.json', name: 'GOOD', enabled: true };
const BAD_A = { url: 'http://a.invalid/aircraft.json', name: 'BROKEN-A', enabled: true };
const BAD_B = { url: 'http://b.invalid/aircraft.json', name: 'BROKEN-B', enabled: true };

const results = [];
const check = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail) });
const settle = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------------- one good source, one permanently dead ----------------
  {
    unhandled.length = 0;
    const { g, warnings } = boot([GOOD, BAD_A]);
    await settle(200);

    // Three polls, each walking the full retry backoff. The old code wrote the
    // dead source off after the first one and then took the healthy feed down.
    for (let i = 0; i < 3; i++) { g('window.__t.DataManager.fetchData()'); await settle(9000); }

    check('a dead source still rejects after its retries are spent',
          String(await g("window.__t.DataManager.fetchFromSource(" +
            "{url:'http://a.invalid/aircraft.json',name:'BROKEN-A',enabled:true})" +
            ".then(v=>'RESOLVED '+String(v), e=>'REJECTED')")) === 'REJECTED',
          'it used to resolve undefined, which the merge then dereferenced');

    check('the healthy source keeps updating alongside it',
          g('Object.keys(window.__t.state.aircraftData).length') === 1 &&
          g('window.__t.state.connectionStatus') === 'Partial (1 failed)',
          `status=${g('window.__t.state.connectionStatus')} ` +
          `tracked=${g('Object.keys(window.__t.state.aircraftData).length')}`);

    const sourceWarnings = warnings.filter(w => /^Data source/.test(w));
    check('the warning names the source that actually failed',
          sourceWarnings.some(w => /BROKEN-A/.test(w)) &&
          !sourceWarnings.some(w => /"GOOD"/.test(w)),
          JSON.stringify(sourceWarnings[0] || '(none seen)'));

    check('each outage is reported once, not once per poll',
          sourceWarnings.filter(w => /BROKEN-A/.test(w)).length === 1,
          `${sourceWarnings.length} source warning(s) across 3 polls plus the background interval`);

    check('no unhandled rejections escape the request pool',
          unhandled.length === 0, `${unhandled.length} (was 7 before the fix)`);
  }

  // ---------------- every source dead ----------------
  {
    unhandled.length = 0;
    const { g, warnings } = boot([BAD_A, BAD_B]);
    await settle(200);
    g('window.__t.DataManager.fetchData()');
    await settle(9000);

    check('all sources failing reports an outright error',
          g('window.__t.state.connectionStatus') === 'Error - All sources failed',
          g('window.__t.state.connectionStatus'));

    const seen = warnings.filter(w => /^Data source/.test(w)).join(' | ');
    check('every failed source is named',
          /BROKEN-A/.test(seen) && /BROKEN-B/.test(seen),
          JSON.stringify(seen.slice(0, 110)));

    check('still no unhandled rejections with two dead sources',
          unhandled.length === 0, `${unhandled.length} (was 14 before the fix)`);
  }

  const pass = results.filter(r => r.pass).length;
  console.log('\n' + '='.repeat(72));
  console.log(`MULTI-SOURCE RESILIENCE — ${pass}/${results.length} checks passed`);
  console.log('='.repeat(72));
  for (const r of results) {
    console.log(`${r.pass ? ' PASS' : '*FAIL'}  ${r.name}${r.detail ? '\n         ' + r.detail : ''}`);
  }
  console.log('');
  process.exit(pass === results.length ? 0 : 1);
})();
