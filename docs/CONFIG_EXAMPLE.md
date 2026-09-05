# Configuration Guide

Every setting lives in `config.js`, which is loaded as a plain script before
`app.js` and exposes three globals: `CONFIG`, `UI_THEMES`, `SCOPE_THEMES` and
`SCOPE_THEME_COLORS`.

## Contents

- [Minimum viable configuration](#minimum-viable-configuration)
- [Settings that the UI can override](#settings-that-the-ui-can-override)
- [Home position](#home-position)
- [Data sources](#data-sources)
- [Moving receiver (POSITION file)](#moving-receiver-position-file)
- [Reference data (airports, navaids, runways)](#reference-data-airports-navaids-runways)
- [Sweep and timing](#sweep-and-timing)
- [Trails](#trails)
- [Display](#display)
- [Range limits](#range-limits)
- [Emergency codes](#emergency-codes)
- [Airport and navaid layer](#airport-and-navaid-layer)
- [Performance tuning](#performance-tuning)
- [Themes](#themes)
- [Tuning recipes](#tuning-recipes)

---

## Minimum viable configuration

Three values must be changed before the scope shows anything:

```javascript
const CONFIG = {
    DEFAULT_HOME_LAT: 40.712776,      // your receiver's latitude
    DEFAULT_HOME_LON: -74.005974,     // your receiver's longitude
    DEFAULT_TAR1090_URL: 'http://192.168.1.100/tar1090/data/aircraft.json',
    // ...
};
```

If the receiver moves, leave the coordinates as a sensible starting point and
see [Moving receiver](#moving-receiver-position-file) instead — a `POSITION`
file then takes over.

> **Historical note.** Releases up to `1.0.16` shipped
> `DEFAULT_HOME_LAT: 00.0000`. A leading `0` followed by more digits is a
> legacy octal literal, so that was not valid JavaScript: the browser refused
> to parse the whole file and the page loaded blank. Fixed in `0.0.1`.

## Local overrides, and the demo configuration

`index.html` loads `config.local.js` after `config.js`, if it exists. That file
mutates `CONFIG` in place, so you can change settings for one machine without
touching the tracked configuration. It is gitignored; absent, the 404 is
harmless.

`config.demo.js` is a ready-made one — a receiver in Guanabara Bay under way at
3 knots on course 180, reading the CSVs from `data/`:

```bash
cp config.demo.js config.local.js
node tools/demo-feed.js &      # aircraft
node tools/ship-sim.js &       # the receiver, 8 kt through the bay
python3 -m http.server 8000
```

Delete `config.local.js` to go back to `config.js` alone.

## Settings that the UI can override

Three groups behave differently, and the difference matters when a change
appears to have no effect:

| Group | Where it is read | Overridden by the settings panel? |
|---|---|---|
| `DEFAULT_HOME_LAT` / `LON`, `DEFAULT_RANGE_NM`, `DEFAULT_TAR1090_URL`, trail settings, layer toggles | Once, at startup | **Yes** — once the user saves, `localStorage` wins on every later load |
| `MIN_RANGE_NM`, `MAX_RANGE_NM`, `RANGE_STEP_NM`, all timing, `PERFORMANCE.*`, `AIRPORT_DISPLAY.*`, `EMERGENCY_SQUAWKS` | Every run | No — `config.js` is the only source |
| `DATA_PATHS` | At startup | No |

If an edit to a `DEFAULT_*` value seems ignored, stored settings are shadowing
it. Press **Clear Storage** in the settings panel: it discards all three keys
and reloads from `config.js`.

The Display and Performance settings are a special case. They live on `CONFIG`,
not in `state`, so the settings panel writes them back onto `CONFIG` at runtime
and stores them under `display` and `performance` in `adsbScope_settings`. An
edit to `config.js` for one of those is likewise shadowed once saved.

## Home position

```javascript
DEFAULT_HOME_LAT: 40.712776,   // decimal degrees, north positive
DEFAULT_HOME_LON: -74.005974,  // decimal degrees, east positive
DEFAULT_RANGE_NM: 50,          // range of the outer ring at startup
```

This is the centre of the scope and the origin for every distance and bearing
calculation. It should be the receiver's antenna, not the nearest airport.

## Data sources

```javascript
DEFAULT_TAR1090_URL: 'http://192.168.1.100/tar1090/data/aircraft.json',
FETCH_INTERVAL_MS: 1000,        // how often each source is polled
FETCH_TIMEOUT_MS: 5000,         // per-request abort timeout
MAX_RETRY_ATTEMPTS: 3,          // attempts before a source is marked failed
INITIAL_RETRY_DELAY_MS: 1000,   // first backoff; doubles each attempt
```

Common endpoints:

| Receiver | URL |
|---|---|
| tar1090, local | `http://localhost/tar1090/data/aircraft.json` |
| tar1090, network | `http://192.168.1.100/tar1090/data/aircraft.json` |
| PiAware, local | `http://localhost:8080/data/aircraft.json` |
| PiAware, network | `http://192.168.1.100:8080/data/aircraft.json` |
| dump1090-fa | `http://192.168.1.100/skyaware/data/aircraft.json` |

A URL is accepted only if it parses, uses `http:`/`https:`, and contains
`aircraft.json`, a `/data/` segment, or ends in `.json`.

> **A data source must be an absolute URL.** Unlike `DATA_PATHS`, which are
> fetched directly and accept a relative path, `DEFAULT_TAR1090_URL` runs
> through `URLValidator.isValidDataSourceUrl` — and `new URL('data/x.json')`
> throws, so a relative path is silently rejected and nothing is ever fetched.
> To serve a feed from beside the page without hard-coding a port, resolve it
> at runtime the way `config.demo.js` does:
>
> ```javascript
> CONFIG.DEFAULT_TAR1090_URL = new URL('data/aircraft.json', window.location.href).href;
> ```

**Additional sources** are added at runtime from the settings panel, not from
`config.js`. They are polled in parallel and merged, first sighting of each
ICAO hex winning.

**Partial failure is tolerated.** As long as one source answers, the scope keeps
updating and the status bar reads `CONN: Partial (n failed)`. Each failing feed
raises one warning per outage — not one per poll — naming the feed that actually
failed. A source that comes back is picked up on the next poll.

**Cross-origin sources** must send `Access-Control-Allow-Origin`. Same-LAN
tar1090 and PiAware installs normally do.

**Retry timing.** With the defaults, a dead source is retried after 1 s, then
2 s, then 4 s before that poll is reported as failed — about 7 s. The budget is
per poll, so the next cycle tries again from scratch.

## Moving receiver (POSITION file)

For a receiver that moves — aboard a ship, a vehicle, an aircraft — the scope
centre can follow a file on disk instead of a fixed coordinate.

```javascript
RECEIVER_TYPE: 'static',      // 'static' | 'car' | 'ship' — the master switch
SHOW_RECEIVER_MARKER: true,   // marker at the scope centre

POSITION_FILE: {
    PATH: 'POSITION',         // relative to the page, or absolute
    POLL_INTERVAL_MS: 2000,   // how often the file is read
    MIN_MOVE_NM: 0.005,       // ~9 m; below this the scope is not re-projected
    STALE_AFTER_MS: 30000     // age at which a fix is flagged as stale
},
```

`RECEIVER_TYPE` decides everything. `'static'` is a fixed installation: the
centre is the home position and `POSITION` is never read. `'car'` and `'ship'`
are mobile: the centre follows the file, and the two differ only in the marker
drawn at the centre.

It is deliberately one switch rather than a type plus a separate "track from a
file" toggle — two settings that have to agree is how you end up with a static
receiver polling a file, or a ship that never moves.

Everything here is also editable in **Settings → Receiver**. While a mobile type
is selected, the Home Position fields are read-only — the file wins.

### How the file is watched

A browser cannot watch the filesystem, so the file is polled over HTTP with
`If-Modified-Since` / `If-None-Match`. An unchanged file costs one `304` per
poll and nothing is re-parsed or re-rendered. Servers that ignore conditional
requests still work: the body is compared against the last one read.

Write the file atomically — to a temporary name, then rename — so the scope
never reads a half-written file.

```bash
while :; do
    gpspipe -w -n 5 | grep -m1 RMC > POSITION.tmp && mv POSITION.tmp POSITION
    sleep 1
done
```

### Accepted formats

Four shapes, tried in order. Blank lines and `#` comments are ignored
throughout. Course is degrees true and speed is knots; both are optional.

**NMEA 0183** — any talker ID, `GGA` or `RMC`. The last valid sentence wins, so
appending to a log works. A `GGA` with fix quality `0`, or an `RMC` with status
`V`, is correctly treated as no fix.

```
$GPRMC,123519,A,2357.648,S,04620.016,W,12.4,45.0,230925,,,A*6A
```

**JSON** — also accepts `latitude`/`longitude` and `cog`/`sog`.

```json
{"lat": -23.9608, "lon": -46.3336, "heading": 45, "speed": 12.4}
```

**`KEY=VALUE` lines**

```
LAT=-23.9608
LON=-46.3336
HEADING=045
SPEED=12.4
```

**Bare pair** — comma- or whitespace-separated, optionally with course and speed.

```
-23.9608, -46.3336
-23.9608 -46.3336 45 12.4
```

Every parsed fix is range-checked before it is used, so a truncated or
half-written file is rejected rather than moving the scope somewhere fictional.

### `MIN_MOVE_NM`, and why it matters

The home position is updated on every fix, but the scope is only **re-projected**
once the receiver has moved past `MIN_MOVE_NM`. Re-projection clears the
distance cache and rebuilds the static layer — the range rings, compass rose,
airports, navaids and runways — which is real work.

GPS on a moored vessel jitters by a few metres continuously. Without the
threshold that would rebuild the static layer several times a second forever.
The default of `0.005` nm (~9 m) sits below that noise.

Raise it for a fast vessel where you would rather redraw less often; drop it to
`0` on a slow-moving platform where you want every metre reflected.

### What moves with the receiver

Everything. The application stores geographic coordinates throughout and
projects them relative to the home position each frame, so aircraft positions,
their trails, and the airport, navaid and runway layers all re-project correctly
around the new centre. Trails drawn before the ship moved stay geographically
true — they do not smear.

### Status and staleness

The status bar replaces `POS:` with `UNDERWAY:` plus course and speed. If no
fix has arrived for `STALE_AFTER_MS`, it appends `(STALE)` and the receiver
marker dims and turns the theme's emergency colour, so a dead GPS feed is
visible on the scope itself rather than only in the status bar.

Three consecutive read failures raise one warning; the poller keeps trying.

## Reference data (airports, navaids, runways)

```javascript
DATA_PATHS: {
    AIRPORTS: 'data/airports.csv',
    NAVAIDS:  'data/navaids.csv',
    RUNWAYS:  'data/runways.csv'
},
```

These are the [OurAirports](https://ourairports.com/data/) CSV exports,
included under `data/`. Relative paths resolve against the page, so
`data/airports.csv` is correct for a local copy.

The three files load in parallel and independently: if one 404s, that layer is
simply unavailable and a warning appears — the other two still work.

Filtering applied at load and at draw time:

- Airports need a position and a **four-character ICAO code**, so local codes
  without one are excluded.
- Runways need both thresholds georeferenced, and are dropped below
  `AIRPORT_DISPLAY.MIN_RUNWAY_LENGTH_FT`.
- At most `AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY` airports and navaids are
  drawn, whatever the range.

## Sweep and timing

```javascript
SWEEP_DURATION_S: 3.8,             // seconds per revolution
AIRCRAFT_TIMEOUT_FACTOR: 3,        // drop after SWEEP_DURATION_S × this
UI_UPDATE_INTERVAL_MS: 700,        // side-panel refresh period
CANVAS_RENDER_THROTTLE_MS: 16,     // ~60 fps
MEMORY_CLEANUP_INTERVAL_MS: 30000, // trail/aircraft reclamation period
```

`SWEEP_DURATION_S` is the setting with the widest reach. Targets are repainted
**only as the sweep passes over them**, which is what makes the display behave
like a radar rather than a live map — and it also means a position can be up
to one revolution stale on screen. It additionally sets the aircraft timeout
(3.8 × 3 ≈ 11.4 s of silence) and the symbol fade, since alpha decays over one
sweep period.

Setting it to `0.0` paints every fetch immediately. That removes the radar
behaviour, and is not recommended.

`CANVAS_RENDER_THROTTLE_MS` is a floor on the frame interval, not a target:
16 ms allows up to ~60 fps, 32 ms caps it at ~30 fps.

## Trails

```javascript
MAX_TRAIL_LENGTH: 100,        // stored positions per aircraft
TRAIL_FADE_TIME_MINUTES: 5,   // age at which a segment is fully faded
TRAIL_GRADIENT_SEGMENTS: 40,
SMOOTHING_FACTOR: 0.3,
```

`TRAIL_GRADIENT_SEGMENTS` caps how many segments are actually stroked: a
100-point trail resampled to 40 segments looks the same and costs less than
half as much. Set it to `0` to draw every point.

`SMOOTHING_FACTOR` damps position jitter — see
[Display](#display) — and is applied before points are appended to the trail,
so the symbol always sits on the head of its own trail.

Trails are stored as latitude/longitude, never as pixels, and re-projected
each frame. Zooming or resizing therefore redraws history correctly instead of
stretching it — at the cost of one projection per point per frame, which is
why `MAX_TRAIL_LENGTH` is the first thing to reduce on a slow machine.

Worst case is `MAX_TRAIL_LENGTH × aircraft in range` projections per frame:
100 points across 50 aircraft is 5 000. The points come from a recycled object
pool, so this costs CPU rather than garbage-collection pauses.

Trail length and fade time are also editable in the settings panel, which then
overrides these values.

## Display

```javascript
CANVAS_PADDING: 40,         // margin outside the outer ring, px
AIRCRAFT_SYMBOL_SIZE: 3,    // half-height of a target symbol, px
HEADING_LINE_LENGTH: 10,
VECTOR_MINUTES: 2,          // how far ahead speed vectors project
CLICK_RADIUS_PX: 15,        // click tolerance when selecting a target
```

`CANVAS_PADDING` must leave room for the compass labels, which are drawn 25 px
outside the ring — below about 30 it starts clipping them.

`VECTOR_MINUTES` is dead reckoning along a great circle from the current track
and ground speed; it takes no account of flight plans or turns.

`HEADING_LINE_LENGTH` is the short stub drawn ahead of an airborne symbol. It
is a fixed pixel length, unlike the speed vector, so it stays readable at any
range; set it to `0` to turn it off.

`SMOOTHING_FACTOR` (listed under Trails in `config.js`) is the weight kept from
the previous position when a new report arrives: `0` snaps straight to each
report, `0.3` damps the quantisation jitter that is visible on a 5 nm scope,
and values near `1` lag badly. A jump larger than 2 nm is treated as a genuine
reposition and snaps, so an aircraft re-acquired after a gap does not glide
across the scope.

## Range limits

```javascript
MIN_RANGE_NM: 5,
MAX_RANGE_NM: 500,
RANGE_STEP_NM: 5,
```

Bounds for the scroll wheel and the `+`/`-` keys. These have no UI equivalent.

## Emergency codes

```javascript
EMERGENCY_SQUAWKS: ['7500', '7600', '7700'],
ALERT_DURATION_MS: 6000,
```

| Code | Meaning |
|---|---|
| 7500 | Unlawful interference (hijack) |
| 7600 | Radio communication failure |
| 7700 | General emergency |

A matching target flashes in the theme's emergency colour, raises a banner for
`ALERT_DURATION_MS`, and — when sound is enabled — plays a two-tone chirp.
Banners are de-duplicated per aircraft, so one target produces one banner
however many messages arrive.

Audio needs a user gesture: the `AudioContext` is created on the first click
anywhere in the page, so an alert arriving before that is silent.

## Airport and navaid layer

```javascript
AIRPORT_DISPLAY: {
    SYMBOL_SIZE: 6,             // airport circle radius, px
    NAVAID_SYMBOL_SIZE: 4,      // navaid symbol radius, px
    LABEL_FONT_SIZE: 10,
    RUNWAY_LINE_WIDTH: 2,
    MAX_AIRPORTS_DISPLAY: 50,   // cap on airports *and* navaids drawn
    MIN_RUNWAY_LENGTH_FT: 3000  // shorter runways are never loaded
},
```

VOR and VORTAC navaids draw as hexagons; everything else draws as a circle.

`MIN_RUNWAY_LENGTH_FT` is applied while parsing the CSV, so raising it after
load has no effect until the page is reloaded.

## Performance tuning

```javascript
PERFORMANCE: {
    // Canvas
    USE_OFFSCREEN_CANVAS: true,
    CACHE_STATIC_ELEMENTS: true,
    DIRTY_REGION_TRACKING: true,
    MAX_PARTICLES_PER_FRAME: 1000,

    // Memory
    OBJECT_POOL_SIZE: 100,
    WEAK_REFERENCE_CLEANUP: true,
    AGGRESSIVE_TRAIL_CLEANUP: true,

    // Network
    REQUEST_POOLING: true,
    BATCH_NETWORK_REQUESTS: true,
    RESPONSE_COMPRESSION: true,

    // DOM
    BATCH_DOM_UPDATES: true,
    USE_DOCUMENT_FRAGMENT: true,
    DEBOUNCE_RESIZE_MS: 100,

    // State
    IMMUTABLE_STATE_UPDATES: true,
    PROXY_STATE_DETECTION: true,
    LOCALSTORAGE_DEBOUNCE_MS: 500
}
```

All default to on, and all are wired to real behaviour. They are diagnostic
switches: turn one off to isolate a problem, not to gain speed.

| Switch | What it does |
|---|---|
| `USE_OFFSCREEN_CANVAS` | Rasterises the static layer on an `OffscreenCanvas`, so it never touches the visible canvas. Falls back to a scratch `<canvas>` where unsupported. |
| `CACHE_STATIC_ELEMENTS` | Keeps that raster as a bitmap instead of redrawing it each frame. |
| `DIRTY_REGION_TRACKING` | Restores only the rectangles the previous frame painted over, instead of blitting the whole scope face. |
| `MAX_PARTICLES_PER_FRAME` | Ceiling on aircraft processed per frame. |
| `OBJECT_POOL_SIZE` | Trail points pre-allocated. |
| `WEAK_REFERENCE_CLEANUP` | Memoises each trail's screen projection in a `WeakMap` keyed by the aircraft, so it is reclaimed with the aircraft. |
| `AGGRESSIVE_TRAIL_CLEANUP` | Requests a GC pass after trail cleanup where the browser exposes one. |
| `REQUEST_POOLING` | One in-flight promise per URL. |
| `BATCH_NETWORK_REQUESTS` | Queues requests behind a concurrency ceiling of 5. |
| `BATCH_DOM_UPDATES` | Coalesces panel repaints into one animation frame. |
| `USE_DOCUMENT_FRAGMENT` | Builds table rows off-document. |
| `DEBOUNCE_RESIZE_MS` | Debounces window resize. |
| `IMMUTABLE_STATE_UPDATES` | Deep-clones objects assigned into state. |
| `PROXY_STATE_DETECTION` | Routes state writes through the change-detecting `Proxy`. With it off the store is a plain object: writes are cheaper, but subscribers never fire. |
| `LOCALSTORAGE_DEBOUNCE_MS` | Debounces `localStorage` writes. |

`RESPONSE_COMPRESSION` was removed in `0.0.2`. `Accept-Encoding` is a forbidden
header name in `fetch`: the browser negotiates transfer encoding itself, so the
setting could never have had an effect.

The two that matter most:

- **`CACHE_STATIC_ELEMENTS`** rasterises the rings, compass rose, airports,
  navaids and runways once and blits the bitmap each frame. The cache key
  covers canvas geometry, range, layer toggles and theme, so it rebuilds only
  when one of those changes. Turning it off means redrawing every runway line
  60 times a second — the single largest cost on the static layer.
- **`REQUEST_POOLING`** shares one in-flight promise per URL. Without it, a
  source slower than `FETCH_INTERVAL_MS` accumulates a new request every
  second while the previous ones are still open.
- **`DIRTY_REGION_TRACKING`** is the second-largest saving. Rather than blitting
  the whole cached scope face every frame, it restores only the bands that the
  previous frame's sweep, symbols, trails and labels touched. It falls back to a
  full restore automatically when those regions cover more than 55% of the
  canvas, where many small blits cost more than one big one.

`IMMUTABLE_STATE_UPDATES` deep-clones objects assigned into state, via
`JSON.parse(JSON.stringify(...))`. It prevents aliasing bugs at the cost of a
clone per write, and it silently drops `Set` values — relevant if you extend
the state object.

## Themes

Three arrays drive theming.

```javascript
// interface chrome — key matches [data-ui-theme="..."] in styles.css
UI_THEMES = [{ key: 'default-dark', name: 'Default Dark', group: 'Dark' }, ...]

// scope palettes, in dropdown order
SCOPE_THEMES = [{ name: 'Classic Green CRT', key: 'classic-green' }, ...]

// colour roles per scope theme
SCOPE_THEME_COLORS = { 'classic-green': { background: '#001200', ... }, ... }
```

To add a scope theme, append to `SCOPE_THEMES` and add a matching entry to
`SCOPE_THEME_COLORS`:

```javascript
{ name: 'My Theme', key: 'my-theme' }
```

```javascript
'my-theme': {
    background: '#001200',  // scope face
    grid:       '#003300',  // rings, crosshairs, compass ticks
    sweep:      '#00FF00',  // rotating sweep line
    aircraft:   '#00FF00',  // default target colour
    selected:   '#CCFFCC',  // selected target
    emergency:  '#FF6666',  // 7500 / 7600 / 7700
    ground:     '#00B300',  // traffic on the ground
    text:       '#C8FFC8',  // labels and data blocks
    mlat:       '#FFFF00',  // multilaterated targets
    adsb:       '#00FF00',  // ADS-B targets
    other:      '#00AAAA'   // unknown provenance
}
```

**Append rather than reorder.** The stored theme choice is the array index,
so inserting an entry silently changes what existing users see.

All eleven roles are required. A missing one renders as magenta `#FF00FF`,
which is deliberately loud so the gap is obvious on screen.

Aircraft symbols are drawn +60 per RGB channel brighter than their trail, so
a palette whose target colours are already near white loses that separation.

A UI theme additionally needs a `[data-ui-theme="my-theme"]` block in
`styles.css` defining the CSS custom properties.

## Tuning recipes

**Low-powered machine (Raspberry Pi, old laptop):**

```javascript
CANVAS_RENDER_THROTTLE_MS: 32,   // cap at ~30 fps
UI_UPDATE_INTERVAL_MS: 1000,
MAX_TRAIL_LENGTH: 25,
AIRPORT_DISPLAY: { MAX_AIRPORTS_DISPLAY: 20, MIN_RUNWAY_LENGTH_FT: 5000 }
```

Also turn off runways in the UI — they are the heaviest static layer — and
prefer a simple theme.

**Busy airspace (100+ aircraft in range):**

```javascript
MAX_TRAIL_LENGTH: 30,
PERFORMANCE: { MAX_PARTICLES_PER_FRAME: 200 }
```

Label placement is the bottleneck here, not the symbols: each label tries up
to twelve positions against every label already drawn.

**Slow or remote feed:**

```javascript
FETCH_INTERVAL_MS: 2000,
FETCH_TIMEOUT_MS: 10000,
SWEEP_DURATION_S: 6,             // keep targets alive between updates
AIRCRAFT_TIMEOUT_FACTOR: 4,
```

**Moving receiver on a fast vessel:**

```javascript
POSITION_FILE: {
    ENABLED: true,
    POLL_INTERVAL_MS: 1000,
    MIN_MOVE_NM: 0.05        // ~90 m; re-project less often at speed
}
```

**Wall display, no interaction:**

```javascript
DEFAULT_RANGE_NM: 150,
MAX_TRAIL_LENGTH: 200,
TRAIL_FADE_TIME_MINUTES: 15,
MEMORY_CLEANUP_INTERVAL_MS: 15000   // reclaim more often on a long uptime
```
