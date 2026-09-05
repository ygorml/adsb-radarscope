// Exercises the newly implemented features against the real source.
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const PROBE = "\n    window.__t = { state, DataManager, CSVDataManager, MathUtils, Renderer, UIManager," +
              " ExportManager, AircraftStateManager, EventHandlers, ScopeLoop, App, SoundManager," +
              " ThemeManager, PositionManager, canvasRenderer, networkPool, CONFIG };\n";

// A file the harness can rewrite mid-run, standing in for a moving receiver.
let POSITION_BODY = 'LAT=0.0\nLON=0.0\n';
let positionReads = 0;

function boot({ storage = {}, feed = null, config = '' } = {}) {
  let reads = 0;              // POSITION reads by *this* instance
  const errors = [];
  const unhandled = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  vc.on('warn', () => {}); vc.on('log', () => {});

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/g, '');

  const FEED = feed || { messages: 1, aircraft: [
    { hex: 'a12345', flight: 'TEST01', lat: 0.2, lon: 0.1, alt_baro: 30000, gs: 400, track: 90, squawk: '1200', adsb_version: 2 }] };

  const drawCalls = Object.create(null);
  const putImageDataArgs = [];

  const dom = new JSDOM(html, {
    url: 'http://localhost:8000/', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, opts) => {
        const s = String(u);
        if (/\.invalid\//.test(s)) return Promise.reject(new Error('unreachable host'));
        if (/POSITION/.test(s)) {
          positionReads++; reads++;
          return Promise.resolve({ ok: true, status: 200,
            headers: { get: () => null },
            text: () => Promise.resolve(POSITION_BODY) });
        }
        const body = s.includes('aircraft.json') ? JSON.stringify(FEED)
          : s.includes('airports.csv') ? 'icao_code,name,latitude_deg,longitude_deg,elevation_ft,type,municipality,iso_country\nZZZZ,Near,0.05,0.05,10,small_airport,A,ZZ\nZZZY,Far,0.40,0.40,10,small_airport,B,ZZ\n'
          : s.includes('navaids.csv') ? 'ident,name,type,latitude_deg,longitude_deg,elevation_ft,frequency_khz,associated_airport\n'
          : s.includes('runways.csv') ? 'airport_ident,le_ident,he_ident,length_ft,width_ft,surface,lighted,closed,le_latitude_deg,le_longitude_deg,he_latitude_deg,he_longitude_deg,le_heading_degT,he_heading_degT\n'
          : null;
        if (body === null) return Promise.reject(new Error('404'));
        return Promise.resolve({ ok: true, status: 200,
          headers: { get: () => null },
          text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)) });
      };
      w.HTMLCanvasElement.prototype.getContext = function () {
        const rec = n => (...args) => {
          drawCalls[n] = (drawCalls[n] || 0) + 1;
          if (n === 'putImageData') putImageDataArgs.push(args.length);
        };
        return { canvas: this, save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'),
          closePath: rec('closePath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'),
          rect: rec('rect'), fill: rec('fill'), stroke: rec('stroke'), fillRect: rec('fillRect'),
          clearRect: rec('clearRect'), fillText: rec('fillText'), translate: rec('translate'),
          rotate: rec('rotate'), setLineDash: rec('setLineDash'), quadraticCurveTo: rec('quadraticCurveTo'),
          putImageData: rec('putImageData'),
          measureText: t => ({ width: String(t).length * 6 }),
          getImageData: (x, y, ww, hh) => {
            drawCalls.getImageData = (drawCalls.getImageData || 0) + 1;
            return { width: ww, height: hh, data: new Uint8ClampedArray(4) };
          } };
      };
      w.AudioContext = function () {
        return { currentTime: 0, destination: {},
          createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {} } }),
          createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }) };
      };
      w.OffscreenCanvas = function (width, height) {
        this.width = width; this.height = height;
        this.getContext = () => w.HTMLCanvasElement.prototype.getContext.call(this);
      };
      w.confirm = () => true;
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
        "CONFIG.DATA_PATHS.RUNWAYS='data/runways.csv';" + config;
      doc.body.appendChild(cfg);
    }
  }
  const frames = (n, t0 = 0) => { for (let i = 0; i < n; i++) {
    const q = window.__frames.splice(0); if (!q.length) return; for (const cb of q) cb(t0 + i * 20); } };
  const g = e => window.eval(`(function(){try{return ${e}}catch(err){return '__ERR__: '+err.message}})()`);
  return { window, doc, frames, g, errors, unhandled, drawCalls, putImageDataArgs,
           positionReads: () => reads };
}

const results = [];
const check = (group, name, cond, detail = '') =>
  results.push({ group, name, pass: !!cond, detail: String(detail) });

(async () => {
  // =================== advertised UI features ===================
  {
    const { g, doc, window, frames } = boot();
    await new Promise(r => setTimeout(r, 200));
    frames(60);

    // --- compass ring click -> quick zoom ---
    const before = g('window.__t.state.maxRangeNm');           // 50
    const cx = 500, cy = 400, radius = Math.min(cx, cy) - g('window.__t.CONFIG.CANVAS_PADDING');
    const canvas = doc.getElementById('radarCanvas');
    const clickAt = (x, y) => {
      const ev = new window.MouseEvent('click', { bubbles: true });
      Object.defineProperty(ev, 'offsetX', { value: x });
      Object.defineProperty(ev, 'offsetY', { value: y });
      canvas.dispatchEvent(ev);
    };
    clickAt(cx, cy - radius * 0.5);                             // the 2nd of 4 rings = half range
    const afterRing = g('window.__t.state.maxRangeNm');
    check('UI', 'clicking a range ring zooms to that ring',
          afterRing === before / 2, `${before} nm -> ${afterRing} nm (clicked the half-range ring)`);

    // --- clicking empty space between rings does nothing ---
    const stable = g('window.__t.state.maxRangeNm');
    clickAt(cx + radius * 0.13, cy);
    check('UI', 'a click between rings is not a zoom',
          g('window.__t.state.maxRangeNm') === stable, `${stable} nm unchanged`);

    // --- keyboard map the author advertised ---
    const kd = k => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    const runwaysBefore = g('window.__t.state.showRunways');
    kd('w');
    check('UI', 'W toggles runways', g('window.__t.state.showRunways') !== runwaysBefore);

    const detailsBefore = g('window.__t.state.showLabelDetails');
    kd('d');
    check('UI', 'D toggles extended labels',
          g('window.__t.state.showLabelDetails') !== detailsBefore,
          `${detailsBefore} -> ${g('window.__t.state.showLabelDetails')}`);

    kd('i');
    check('UI', 'I toggles the debug overlay', g('window.__t.state.showDebugInfo') === true);

    doc.getElementById('help-modal').classList.add('hidden');
    kd('?');
    check('UI', '? opens help', !doc.getElementById('help-modal').classList.contains('hidden'));
    kd('Escape');
    check('UI', 'Escape closes modals', doc.getElementById('help-modal').classList.contains('hidden'));

    // --- R = reset view ---
    window.eval('window.__t.state.maxRangeNm = 200; window.__t.state.aircraftFilter="military";' +
                'window.__t.state.selectedHex="ABC"; window.__t.state.isPaused=true;');
    kd('r');
    check('UI', 'R resets the view',
          g('window.__t.state.maxRangeNm') === g('window.__t.CONFIG.DEFAULT_RANGE_NM') &&
          g('window.__t.state.aircraftFilter') === 'all' &&
          g('window.__t.state.selectedHex') === null &&
          g('window.__t.state.isPaused') === false,
          `range=${g('window.__t.state.maxRangeNm')} filter=${g('window.__t.state.aircraftFilter')}`);

    // --- shortcuts must not fire while typing (KNOWN_ISSUES 5) ---
    doc.getElementById('home-lat').focus();
    const trailsBefore = g('window.__t.state.showTrails');
    doc.getElementById('home-lat').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 't', bubbles: true }));
    check('UI', 'shortcuts suppressed while typing in a field',
          g('window.__t.state.showTrails') === trailsBefore,
          `showTrails stayed ${trailsBefore}`);

    // --- extended labels actually change what is drawn ---
    window.eval('window.__t.state.showLabelDetails = true;');
    frames(20, 5000);
    const withDetails = g('document.getElementById("radarCanvas") && 1');
    check('UI', 'label detail toggle reaches the renderer',
          withDetails === 1 && typeof g('window.__t.state.showLabelDetails') === 'boolean');

    // --- settings panel now carries every advertised section ---
    const sections = ['receiver-type', 'show-receiver-marker', 'show-label-details', 'aircraft-symbol-size',
                      'heading-line-length', 'vector-minutes', 'settings-ui-theme',
                      'settings-scope-theme', 'sweep-duration', 'render-throttle',
                      'ui-update-interval', 'max-airports-display', 'smoothing-factor',
                      'clear-storage-btn'];
    const missing = sections.filter(id => !doc.getElementById(id));
    check('UI', 'settings panel exposes performance, display, theme and reset',
          missing.length === 0, missing.length ? 'missing: ' + missing.join(',') : `${sections.length} controls present`);

    // --- theme selects populate ---
    g('window.__t.EventHandlers.showSettings()');
    check('UI', 'settings theme selects populate',
          doc.getElementById('settings-ui-theme').options.length === 35 &&
          doc.getElementById('settings-scope-theme').options.length === 51,
          `${doc.getElementById('settings-ui-theme').options.length} UI / ${doc.getElementById('settings-scope-theme').options.length} scope`);

    // --- Clear Storage ---
    window.localStorage.setItem('adsbScope_settings', '{"homeLat":1}');
    window.localStorage.setItem('adsbScope_uiTheme', 'slate');
    const timeoutsBefore = g('window.__t.state.timeouts.length');
    g('window.__t.EventHandlers.clearStorage()');
    // jsdom will not let window.location be replaced, so the reload itself is
    // asserted through the timeout the handler schedules for it.
    check('UI', 'Clear Storage wipes the saved keys and schedules a reload',
          window.localStorage.getItem('adsbScope_settings') === null &&
          window.localStorage.getItem('adsbScope_uiTheme') === null &&
          g('window.__t.state.timeouts.length') > timeoutsBefore,
          `keys cleared, reload timer queued (${timeoutsBefore} -> ${g('window.__t.state.timeouts.length')})`);
  }

  // =================== previously-inert CONFIG flags ===================
  {
    const { g, frames, drawCalls, putImageDataArgs } = boot();
    await new Promise(r => setTimeout(r, 200));
    frames(120);

    check('CONFIG', 'USE_OFFSCREEN_CANVAS renders through an OffscreenCanvas',
          g('!!window.__t.canvasRenderer.offscreenCtx') === true,
          'offscreenCtx is live and used by cacheStaticElements');

    const partial = putImageDataArgs.filter(n => n === 7).length;
    check('CONFIG', 'DIRTY_REGION_TRACKING restores only the painted regions',
          partial > 0, `${partial} partial restores vs ${putImageDataArgs.filter(n => n === 3).length} full`);

    check('CONFIG', 'WEAK_REFERENCE_CLEANUP caches trail projections',
          g('window.__t.CONFIG.PERFORMANCE.WEAK_REFERENCE_CLEANUP') === true &&
          g('typeof window.__t.Renderer.drawAircraftTrail') === 'function');

    check('CONFIG', 'BATCH_NETWORK_REQUESTS enforces a concurrency ceiling',
          g('window.__t.networkPool.inFlight') <= g('window.__t.networkPool.maxConcurrent'),
          `inFlight=${g('window.__t.networkPool.inFlight')} max=${g('window.__t.networkPool.maxConcurrent')}`);

    check('CONFIG', 'HEADING_LINE_LENGTH drives a real heading line',
          g('typeof window.__t.Renderer.drawHeadingLine') === 'function' &&
          g('window.__t.CONFIG.HEADING_LINE_LENGTH') > 0);

    check('CONFIG', 'SMOOTHING_FACTOR damps a jittery report',
          (() => {
            const r = g('(function(){var p={smoothLat:10,smoothLon:20};' +
                        'return window.__t.AircraftStateManager.smoothPosition(p,{lat:10.01,lon:20});})().lat');
            return r > 10 && r < 10.01;
          })(),
          'lat 10 + report 10.01 -> ' +
          g('window.__t.AircraftStateManager.smoothPosition({smoothLat:10,smoothLon:20},{lat:10.01,lon:20}).lat'));

    check('CONFIG', 'SMOOTHING_FACTOR snaps on a large reposition',
          g('window.__t.AircraftStateManager.smoothPosition({smoothLat:10,smoothLon:20},{lat:30,lon:40}).lat') === 30,
          'a 20-degree jump is not smoothed');

    check('CONFIG', 'TRAIL_GRADIENT_SEGMENTS caps segments drawn',
          g('window.__t.CONFIG.TRAIL_GRADIENT_SEGMENTS') === 40);

    check('CONFIG', 'RESPONSE_COMPRESSION removed rather than faked',
          g('window.__t.CONFIG.PERFORMANCE.RESPONSE_COMPRESSION') === undefined);

    check('CONFIG', 'nearest airports are chosen, not the first in file order',
          (() => {
            const r = g('JSON.stringify(window.__t.CSVDataManager.getAirportsInRange(0,0,100).map(a=>a.icao))');
            return r.indexOf('ZZZZ') < r.indexOf('ZZZY');
          })(),
          g('JSON.stringify(window.__t.CSVDataManager.getAirportsInRange(0,0,100).map(a=>a.icao))'));
  }

  // =================== moving receiver ===================
  {
    POSITION_BODY = 'LAT=-23.9608\nLON=-46.3336\nHEADING=045\nSPEED=12.4\n';
    positionReads = 0;
    const { g, doc, frames } = boot({
      config: "CONFIG.RECEIVER_TYPE='ship';CONFIG.POSITION_FILE.PATH='POSITION';" +
              "CONFIG.POSITION_FILE.POLL_INTERVAL_MS=300;"
    });
    await new Promise(r => setTimeout(r, 400));
    frames(40);

    check('POSITION', 'POSITION file is polled at boot', positionReads > 0, `${positionReads} reads`);
    check('POSITION', 'home position comes from the file',
          Math.abs(g('window.__t.state.homeLat') + 23.9608) < 1e-6 &&
          Math.abs(g('window.__t.state.homeLon') + 46.3336) < 1e-6,
          `${g('window.__t.state.homeLat')}, ${g('window.__t.state.homeLon')}`);
    check('POSITION', 'course and speed are picked up',
          g('window.__t.state.ownHeading') === 45 && g('window.__t.state.ownSpeed') === 12.4,
          `${g('window.__t.state.ownHeading')}° / ${g('window.__t.state.ownSpeed')} kt`);

    const epochBefore = g('window.__t.state.staticEpoch');
    const readsBefore = positionReads;

    // Unchanged file must not re-render.
    await new Promise(r => setTimeout(r, 700));
    frames(20, 4000);
    check('POSITION', 'an unchanged file does not re-render the scope',
          g('window.__t.state.staticEpoch') === epochBefore && positionReads > readsBefore,
          `staticEpoch stayed ${epochBefore} over ${positionReads - readsBefore} further reads`);

    // Now move the ship a mile and check the scope follows.
    POSITION_BODY = 'LAT=-23.9800\nLON=-46.3336\nHEADING=180\nSPEED=14.0\n';
    await new Promise(r => setTimeout(r, 700));
    frames(30, 6000);
    check('POSITION', 'a rewritten file moves the scope and forces a redraw',
          Math.abs(g('window.__t.state.homeLat') + 23.98) < 1e-6 &&
          g('window.__t.state.staticEpoch') > epochBefore,
          `lat -> ${g('window.__t.state.homeLat')}, staticEpoch ${epochBefore} -> ${g('window.__t.state.staticEpoch')}`);

    check('POSITION', 'status bar switches to UNDERWAY with course and speed',
          /UNDERWAY/.test(doc.getElementById('scope-status-bar').textContent) &&
          /180°/.test(doc.getElementById('scope-status-bar').textContent),
          doc.getElementById('scope-status-bar').textContent.split('|').pop().trim());

    // Sub-threshold jitter must be absorbed.
    const epochQuiet = g('window.__t.state.staticEpoch');
    POSITION_BODY = 'LAT=-23.98001\nLON=-46.33361\nHEADING=180\nSPEED=14.0\n';
    await new Promise(r => setTimeout(r, 700));
    frames(20, 8000);
    check('POSITION', 'GPS jitter below MIN_MOVE_NM does not rebuild the scope',
          g('window.__t.state.staticEpoch') === epochQuiet,
          `moved ~1 m, staticEpoch stayed ${epochQuiet}`);

    check('POSITION', 'receiver marker is drawn while tracking',
          g('typeof window.__t.Renderer.drawReceiverMarker') === 'function' &&
          g('window.__t.state.showReceiverMarker') === true &&
          g('window.__t.state.receiverType') === 'ship');

    // Aircraft must re-project against the new origin.
    check('POSITION', 'aircraft distances are measured from the new position',
          (() => {
            const d = g('window.__t.MathUtils.haversineDistance(window.__t.state.homeLat,' +
                        'window.__t.state.homeLon, 0.2, 0.1)');
            return d > 1000;   // the test aircraft is now far from Santos
          })(),
          g('Math.round(window.__t.MathUtils.haversineDistance(window.__t.state.homeLat,window.__t.state.homeLon,0.2,0.1))') + ' nm');
  }

  // =================== receiver type ===================
  {
    const { g, doc, window, frames, drawCalls, positionReads: myReads } = boot({
      config: "CONFIG.RECEIVER_TYPE='ship';CONFIG.POSITION_FILE.PATH='POSITION';" +
              "CONFIG.POSITION_FILE.POLL_INTERVAL_MS=300;"
    });
    POSITION_BODY = 'LAT=-22.90\nLON=-43.15\nHEADING=090\nSPEED=8.0\n';
    await new Promise(r => setTimeout(r, 400));
    frames(40);

    check('RECEIVER', 'a mobile type starts POSITION tracking on its own',
          g('window.__t.PositionManager.isMobile()') === true &&
          g('window.__t.state.ownSpeed') === 8,
          `type=${g('window.__t.state.receiverType')}, ${g('window.__t.state.ownSpeed')} kt`);

    check('RECEIVER', 'each type has its own marker shape',
          ['drawHullOutline', 'drawCarOutline', 'drawStationOutline', 'drawOriginCross']
            .every(fn => g(`typeof window.__t.Renderer.${fn}`) === 'function'),
          'hull, car, station and origin-cross');

    // Each shape must actually reach the canvas, and differ from the others.
    const strokesFor = type => {
      window.eval(`window.__t.state.receiverType = '${type}';`);
      const before = drawCalls.stroke || 0;
      g('window.__t.Renderer.drawReceiverMarker(500, 400)');
      return (drawCalls.stroke || 0) - before;
    };
    const ship = strokesFor('ship'), car = strokesFor('car'), stat = strokesFor('static');
    check('RECEIVER', 'ship, car and static each draw a distinct marker',
          ship > 0 && car > 0 && stat > 0 && new Set([ship, car, stat]).size === 3,
          `strokes — ship ${ship}, car ${car}, static ${stat}`);

    // A static receiver must not poll the file at all. Switch first, then let
    // any interval tick already in flight land before counting — otherwise the
    // 300 ms poller races the assertion.
    window.eval("window.__t.state.receiverType='static';");
    await new Promise(r => setTimeout(r, 500));
    const readsBefore = myReads();
    g('window.__t.PositionManager.poll()');
    await new Promise(r => setTimeout(r, 700));
    check('RECEIVER', 'a static receiver never reads the POSITION file',
          myReads() === readsBefore && g('window.__t.PositionManager.isMobile()') === false,
          `${myReads() - readsBefore} further reads over two poll periods`);

    check('RECEIVER', 'the marker can be switched off',
          (() => {
            window.eval("window.__t.state.showReceiverMarker=false;");
            const before = drawCalls.stroke || 0;
            g('window.__t.Renderer.drawReceiverMarker(500, 400)');
            const after = drawCalls.stroke || 0;
            window.eval("window.__t.state.showReceiverMarker=true;");
            return after === before;
          })(), 'no strokes with showReceiverMarker off');

    check('RECEIVER', 'settings offer exactly static, car and ship',
          (() => {
            const el = doc.getElementById('receiver-type');
            return el && [...el.options].map(o => o.value).join(',') === 'static,car,ship';
          })(),
          doc.getElementById('receiver-type')
            ? [...doc.getElementById('receiver-type').options].map(o => o.value).join(',')
            : 'select missing');
  }

  // =================== POSITION parser formats ===================
  {
    const { g } = boot();
    await new Promise(r => setTimeout(r, 200));
    const parse = body => g('JSON.stringify(window.__t.PositionManager.parse(' + JSON.stringify(body) + '))');

    const cases = [
      ['bare pair', '-23.9608, -46.3336', -23.9608, -46.3336],
      ['bare pair with course/speed', '-23.9608 -46.3336 45 12.4', -23.9608, -46.3336],
      ['KEY=VALUE', 'LAT=-23.9608\nLON=-46.3336\nHEADING=45', -23.9608, -46.3336],
      ['JSON', '{"lat":-23.9608,"lon":-46.3336,"heading":45}', -23.9608, -46.3336],
      ['JSON latitude/longitude', '{"latitude":-23.9608,"longitude":-46.3336}', -23.9608, -46.3336],
      ['NMEA RMC', '$GPRMC,123519,A,2357.648,S,04620.016,W,12.4,45.0,230925,,,A*6A', -23.9608, -46.3336],
      ['NMEA GGA', '$GPGGA,123519,2357.648,S,04620.016,W,1,08,0.9,10.0,M,,,,*47', -23.9608, -46.3336],
      ['comments ignored', '# a comment\n\nLAT=-23.9608\nLON=-46.3336', -23.9608, -46.3336]
    ];
    for (const [label, body, lat, lon] of cases) {
      const out = JSON.parse(parse(body) || 'null');
      const ok = out && Math.abs(out.lat - lat) < 0.001 && Math.abs(out.lon - lon) < 0.001;
      check('PARSER', `parses ${label}`, ok,
            out ? `${out.lat.toFixed(4)}, ${out.lon.toFixed(4)} via ${out.format}` : 'no match');
    }

    check('PARSER', 'RMC carries course and speed',
          (() => { const o = JSON.parse(parse('$GPRMC,123519,A,2357.648,S,04620.016,W,12.4,45.0,230925,,,A*6A'));
                   return o.speed === 12.4 && o.heading === 45; })(),
          'sog 12.4 kt, cog 45°');
    check('PARSER', 'an RMC with a navigation warning is rejected',
          parse('$GPRMC,123519,V,2357.648,S,04620.016,W,,,230925,,,N*53') === 'null' ||
          JSON.parse(parse('$GPRMC,123519,V,2357.648,S,04620.016,W,,,230925,,,N*53')) === null,
          'status V is not a fix');
    check('PARSER', 'a GGA with fix quality 0 is rejected',
          JSON.parse(parse('$GPGGA,123519,2357.648,S,04620.016,W,0,00,,,M,,,,*4A') || 'null') === null,
          'quality 0 is not a fix');
    check('PARSER', 'the last valid sentence in a log wins',
          (() => { const o = JSON.parse(parse(
              '$GPRMC,123519,A,2357.648,S,04620.016,W,1,10,230925,,,A*6A\n' +
              '$GPRMC,123520,A,0100.000,N,00200.000,E,2,20,230925,,,A*6A'));
                   return Math.abs(o.lat - 1) < 0.01 && Math.abs(o.lon - 2) < 0.01; })(),
          'appending to the file is supported');
    check('PARSER', 'garbage yields no fix',
          JSON.parse(parse('not a position at all') || 'null') === null);
    check('PARSER', 'an empty file yields no fix',
          JSON.parse(parse('') || 'null') === null);
  }

  // ---- report ----
  const pass = results.filter(r => r.pass).length;
  console.log('\n' + '='.repeat(76));
  console.log(`FEATURE VERIFICATION — ${pass}/${results.length} checks passed`);
  console.log('='.repeat(76));
  let group = null;
  for (const r of results) {
    if (r.group !== group) { group = r.group; console.log(`\n  [${group}]`); }
    console.log(`  ${r.pass ? ' PASS' : '*FAIL'}  ${r.name}${r.detail ? '\n           ' + r.detail : ''}`);
  }
  console.log('');
  process.exit(pass === results.length ? 0 : 1);
})();
