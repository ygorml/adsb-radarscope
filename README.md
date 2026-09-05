# ADSB Radarscope v0.0.2

A real-time web-based aircraft tracking application that visualizes ADS-B (Automatic Dependent Surveillance-Broadcast) data on a radar-like display.

<p align="center">
  <img width="49%" src="./assets/dark-scope.webp">
  <img width="49%" src="./assets/light-scope.webp">
</p>
<p align="center">
  <img width="49%" src="./assets/settings.webp">
  <img width="49%" src="./assets/real-time.webp">
</p>

![License](https://img.shields.io/badge/license-GPLv3-blue.svg)
![Version](https://img.shields.io/badge/version-0.0.2-orange.svg)
![Status](https://img.shields.io/badge/status-alpha-orange.svg)

## Features

### Real-Time Aircraft Tracking
- Live aircraft position updates from tar1090, FlightAware PiAware, or compatible data sources
- Multiple simultaneous data sources, merged, with per-source failure reporting
- Rotating radar sweep effect with customizable themes
- Aircraft trails that fade with age
- Vector prediction showing future positions
- Heading line on every airborne target
- Clickable aircraft for detailed information

### Moving Receiver
- Track the scope centre from a `POSITION` file, for a receiver aboard a ship or vehicle
- The file is polled and the scope re-renders whenever it changes
- Accepts NMEA 0183 (`GGA`/`RMC`), JSON, `KEY=VALUE` or a bare `lat, lon` pair
- Course and speed over ground shown in the status bar
- Own-ship marker at the scope centre, oriented to course
- Aircraft, trails, airports, navaids and runways all re-project around the new position

### Advanced Visualization
- **51 Scope Themes**: Classic CRT green, amber, military, aviation-inspired, and more
- **35 UI Themes**: Dark and light color schemes
- **Airport & Navaid Display**: Shows nearby airports, navigation aids, and runway layouts
- **Emergency Detection**: Visual and audio alerts for emergency squawk codes
- **Customizable Range**: Zoom from 5nm to 500nm

### Data Views
- **Radar Scope**: Traditional radar display with rotating sweep
- **Aircraft Details Panel**: Comprehensive telemetry for selected aircraft

### Performance Optimized
- Canvas-based rendering, with the static layer cached as a bitmap
- Object pooling for trail points
- Coalesced DOM updates and de-duplicated network requests
- Desktop-first responsive design
- Handles 50+ aircraft simultaneously

## Quick Start

### Prerequisites
- Web browser (Chrome, Firefox, Edge, or Safari)
- ADS-B data source (tar1090, FlightAware PiAware, dump1090, or compatible)
- HTTP server for local hosting

### Installation

#### Option 1: Download Release Archive

1. **Download and Extract**
   ```bash
   # Extract the release archive to your desired location
   unzip adsb-radarscope-v0.0.2.zip
   cd adsb-radarscope
   ```

2. **Configure Your Settings**
   - Open `config.js` in a text editor
   - Update `DEFAULT_HOME_LAT` and `DEFAULT_HOME_LON` with your coordinates
   - Update `DEFAULT_TAR1090_URL` with your data source URL
   - See `CONFIG_EXAMPLE.md` for detailed configuration options

3. **Start a Web Server**

   **Option A: Python**
   ```bash
   python -m http.server 8000
   ```
   This starts a Python HTTP server on port 8000. Python comes pre-installed on most systems.

   **Option B: Node.js**
   ```bash
   npx http-server -p 8000
   ```
   This uses Node.js to start an HTTP server. Requires Node.js to be installed.

   **Option C: PHP**
   ```bash
   php -S localhost:8000
   ```
   This uses PHP's built-in web server. Requires PHP to be installed.

4. **Open in Browser**
   Navigate to `http://localhost:8000`

   **Verification**: You should see the radar scope interface with a rotating sweep. If you see aircraft, your setup is working correctly. If not, see the Troubleshooting section below.

#### Option 2: Clone from GitHub

1. **Clone the Repository**
   ```bash
   git clone https://github.com/dustsignal/adsb-scope.git
   cd adsb-scope
   ```

2. **Configure Your Settings**
   - Open `config.js` in a text editor
   - Update `DEFAULT_HOME_LAT` and `DEFAULT_HOME_LON` with your coordinates
   - Update `DEFAULT_TAR1090_URL` with your data source URL
   - See `CONFIG_EXAMPLE.md` for detailed configuration options

3. **Start a Web Server**
   Choose one of the server options above (Python, Node.js, or PHP)

4. **Open in Browser**
   Navigate to `http://localhost:8000`

## Configuration

### Required Settings

Edit `config.js` and set these values:

```javascript
// Your radar center location
DEFAULT_HOME_LAT: 12.345678,
DEFAULT_HOME_LON: -87.654321,

// Your ADS-B data source
DEFAULT_TAR1090_URL: 'http://192.168.1.100/tar1090/data/aircraft.json',
```

### Data Source Setup

#### tar1090 (Local)
```javascript
DEFAULT_TAR1090_URL: 'http://localhost/tar1090/data/aircraft.json'
```

#### tar1090 (Network)
```javascript
DEFAULT_TAR1090_URL: 'http://192.168.1.100/tar1090/data/aircraft.json'
// Replace 192.168.1.100 with your tar1090 server IP address
```

#### FlightAware PiAware (Local)
```javascript
DEFAULT_TAR1090_URL: 'http://localhost:8080/data/aircraft.json'
// or
DEFAULT_TAR1090_URL: 'http://piaware.local:8080/data/aircraft.json'
```

#### FlightAware PiAware (Network)
```javascript
DEFAULT_TAR1090_URL: 'http://192.168.1.100:8080/data/aircraft.json'
// Replace 192.168.1.100 with your PiAware IP address
// Note: PiAware typically runs on port 8080
```

#### Remote Source (Requires CORS)
```javascript
DEFAULT_TAR1090_URL: 'https://your-server.com/tar1090/data/aircraft.json'
// Note: Remote sources must have CORS headers configured
```

### Optional Settings

See `CONFIG_EXAMPLE.md` for comprehensive configuration documentation including:
- Performance tuning
- Trail customization
- Display settings
- Theme selection
- Range limits
- Alert configuration

## Usage

### Radar Scope View

**Mouse Controls:**
- **Click aircraft**: Select and view details
- **Click airport symbol**: Show airport details
- **Click a range ring**: Zoom to that ring's range
- **Scroll wheel**: Zoom in/out

**Keyboard Shortcuts:**
- `H` or `?`: Show help
- `Space`: Pause/Resume updates
- `+/-`: Zoom in/out
- `R`: Reset view (default range, no selection, filter cleared)
- `M`: Cycle filter — all / military / civilian
- `V`: Toggle vectors
- `T`: Toggle trails
- `A`: Toggle airports
- `N`: Toggle navaids
- `W`: Toggle runways
- `D`: Toggle extended labels (altitude, speed, heading, squawk)
- `S`: Open settings
- `I`: Toggle debug overlay (FPS, memory, tracked count)
- `Escape`: Close the open modal

Shortcuts are suppressed while you are typing in a settings field.

**Toggle Controls:**
- Vectors: Show predicted future positions
- Trails: Display aircraft movement history
- Airports: Show nearby airports
- Navaids: Display navigation aids
- Runways: Show runway layouts


### Settings Panel

The settings panel (`S`) has nine sections:
- **Home Position** — latitude and longitude (read-only while a POSITION file drives it)
- **Moving Receiver** — POSITION file path, poll interval, movement threshold, own-ship marker
- **Display** — extended labels, symbol size, heading line length, vector look-ahead
- **Theme** — interface and scope themes (also on the top bar)
- **Performance** — sweep duration, frame interval, panel refresh, airport cap, position smoothing
- **Trail Settings** — max trail points, fade time, width
- **Data Sources** — add, rename, enable and remove feeds
- **Sound Alerts** — enable the emergency tone
- **Airport Display** — airports, navaids, runways, minimum runway length

**Clear Storage** discards every saved setting and reloads using the
`config.js` defaults. Saved settings otherwise shadow `config.js` on each load.

![Settings Panel](./assets/settings.webp)

## File Structure

```
adsb-radarscope/
├── index.html           # Markup, panels and modals
├── app.js               # Application logic (single IIFE)
├── config.js            # Configuration settings and theme definitions
├── styles.css           # Theme custom properties and component styles
├── data/                # OurAirports reference CSVs
│   ├── airports.csv
│   ├── navaids.csv
│   └── runways.csv
├── POSITION             # Receiver position, for a moving install
├── config.demo.js       # Ready-to-run test configuration
├── tools/               # demo-feed.js (aircraft), ship-sim.js (receiver position)
├── assets/              # Screenshots used by this file
├── test/                # jsdom test harness (not needed to run the app)
├── README.md            # This file
├── CONFIG_EXAMPLE.md    # Configuration reference and tuning recipes
├── ARCHITECTURE.md      # How the code is organised, for modifying it
├── INSTALL.txt          # Installation guide
└── LICENSE              # License file
```

## Documentation

| Document | Covers |
|---|---|
| [INSTALL.txt](INSTALL.txt) | Setup, first run, troubleshooting |
| [CONFIG_EXAMPLE.md](CONFIG_EXAMPLE.md) | Every `config.js` setting, adding themes, tuning recipes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module layout, the frame cycle, extension points |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Audit record: defects found, and how each was fixed |
| [test/README.md](test/README.md) | Running the test harness, and how it works |

`app.js` and `config.js` carry JSDoc throughout, so an editor with JavaScript
language support will surface parameter and return types inline.

## Looking at it without a receiver

`config.demo.js` is a complete test configuration: a receiver in Guanabara Bay,
Rio de Janeiro, under way at **3 knots on course 180°**, reading the airport and
navaid CSVs that ship in `data/`. Santos Dumont is 2 nm away and Galeão 7 nm, so
the airport and runway layers have something to draw.

```bash
cp config.demo.js config.local.js     # index.html applies it over config.js
node tools/demo-feed.js &             # 8 aircraft, 1 Hz
node tools/ship-sim.js &              # the receiver, under way at 8 kt
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Delete `config.local.js` to go back to your
own settings — it is gitignored, so it never lands in a commit.

The two generators are separate because they write different files, and two
processes writing `POSITION` would fight over it.

**`tools/demo-feed.js`** writes a synthetic tar1090-style feed: airliners, a
military flight, ground movement, an mlat target and one squawking 7700, so the
emergency alert, the provenance colours and the trails are all exercised.

**`tools/ship-sim.js`** drives `POSITION` the way a vessel under way in
Guanabara Bay would — 8 knots along the main channel, courses changing as it
follows the route, rate-limited turns and a little yaw, reversing at each end so
it runs indefinitely.

```bash
node tools/ship-sim.js --check            # verify a 12 h transit stays afloat
node tools/ship-sim.js --format nmea      # emit NMEA RMC instead of KEY=VALUE
node tools/ship-sim.js --speed 12
```

Staying on the water is not derived from a coastline dataset — there isn't one
in this repository. The vessel is held inside a hand-surveyed corridor along the
navigable axis of the bay, and `--check` tests every position of a long transit
against an independent water polygon that does not share the route's
assumptions. It is good enough to exercise the scope; check the waypoints
against a chart before trusting it for anything else.

## Testing

The application has no dependencies. The test harness does — it boots the real
files in [jsdom](https://github.com/jsdom/jsdom) and asserts on what actually
happens.

```bash
cd test
npm install
npm test        # 4 suites, ~70 s
```

91 checks across boot and render, the moving receiver, every configuration
switch, and regression guards for each defect in
[KNOWN_ISSUES.md](KNOWN_ISSUES.md). See [test/README.md](test/README.md).

Nothing under `test/` ships with a release. The harness is the only part of the
repository with dependencies, so it carries its own `package.json` and
`.gitignore`; `test/package-lock.json` is committed on purpose, because these
suites assert on real behaviour and an unpinned jsdom could move a result
without the application changing.

## Themes

New Top Bar
![Topbar](./assets/topbar.webp)

### Scope Themes (51)
- **CRT Classic**: Green, Amber, Arctic Blue
- **Military**: USAF Tactical, Navy Strike, Army Green, RAF Grey
- **Aviation**: Pan Am Blue, TWA Red, Eastern Silver, Braniff Orange
- **Modern**: Cyberpunk, Plasma Burn, Digital Rain, Aurora Borealis
- **Light**: Daylight, CAD, Paper Map, Medical

### UI Themes (35)
- **Dark**: Default, Slate, Abyss, Forest, Crimson, Royal
- **Light**: Default, Stone, Mint, Sky, Lavender, Paper
- **Specialty**: CRT styles, Arctic, Night Vision, Cyberpunk

## Emergency Codes

The application automatically detects and highlights emergency squawk codes:

- **7500**: Hijacking/Unlawful Interference
- **7600**: Radio Communication Failure
- **7700**: General Emergency

Enable sound alerts in Settings to receive audio notifications.

## Performance Tips

### For Lower-End Systems:
- Reduce `MAX_TRAIL_LENGTH` to 25-30
- Increase `CANVAS_RENDER_THROTTLE_MS` to 32ms
- Reduce `MAX_AIRPORTS_DISPLAY` to 20-30
- Disable runway display
- Use simpler scope themes (Classic Green, Amber)

### For High-End Systems:
- Keep all default settings
- Enable all display options
- Use complex themes
- Increase `MAX_TRAIL_LENGTH` to 100+

## Troubleshooting

### No Aircraft Appearing

1. **Verify Data Source URL**
   - Open `config.js` and check `DEFAULT_TAR1090_URL` is correct
   - For PiAware, ensure you're using port 8080
   - For tar1090, typically no port or port 80

2. **Test Data Source Directly**
   - Open the data URL in your browser (e.g., `http://192.168.1.10:8080/data/aircraft.json`)
   - You should see JSON data with aircraft information
   - If you get an error, the data source is not accessible

3. **Check Browser Console**
   - Press F12 to open developer tools
   - Look for red error messages in the Console tab
   - Common errors: "Failed to fetch", "CORS error", "404 Not Found"

4. **Verify ADS-B Receiver**
   - Ensure your ADS-B receiver is running
   - Check that it's receiving data from aircraft
   - Try accessing the receiver's web interface

### Performance Issues

1. **Reduce Visual Complexity**
   - Lower trail length and display options in Settings
   - Disable airports and runways if not needed
   - Try simpler themes (Classic Green instead of Aurora Borealis)

2. **Adjust Render Settings**
   - In `config.js`, increase `CANVAS_RENDER_THROTTLE_MS` to 32ms
   - Reduce `MAX_TRAIL_LENGTH` to 25-30
   - Increase `UI_UPDATE_INTERVAL_MS` to 1000ms

3. **Browser Optimization**
   - Close other browser tabs
   - Disable unnecessary browser extensions
   - Update to latest browser version
   - Enable hardware acceleration in browser settings

### Settings Not Saving

1. **Check localStorage**
   - Ensure browser allows localStorage (check privacy settings)
   - Try accessing site without private/incognito mode

2. **Clear and Reconfigure**
   - There is no in-app reset button. Delete the stored keys from DevTools
     (F12) → Application → Local Storage: `adsbScope_settings`,
     `adsbScope_uiState`, `adsbScope_uiTheme`
   - Or run in the console:
     `['adsbScope_settings','adsbScope_uiState','adsbScope_uiTheme'].forEach(k=>localStorage.removeItem(k))`
   - Reload the page to fall back to the `config.js` defaults

3. **Browser Extensions**
   - Disable privacy extensions temporarily
   - Some extensions block localStorage access

### CORS Errors

If using a remote data source, ensure it sends appropriate CORS headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
```

For PiAware or tar1090 on same network, CORS should not be an issue.

## Browser Compatibility

**Fully Supported:**
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

**Minimum Requirements:**
- ES6 JavaScript support
- Canvas API
- LocalStorage API
- Fetch API

## Technical Details

### Architecture
- Vanilla JavaScript (no frameworks)
- HTML5 Canvas for rendering
- CSS3 with Tailwind utility classes
- LocalStorage for settings persistence

### Data Format
Compatible with tar1090/dump1090/PiAware JSON format:
```json
{
  "aircraft": [{
    "hex": "a12345",
    "flight": "UAL123",
    "lat": 12.345678,
    "lon": -87.54321,
    "alt_baro": 35000,
    "gs": 450,
    "track": 270,
    "squawk": "1200"
  }]
}
```

### Performance Features
- Object pooling for trail points
- Static scope layer rasterised once, on an OffscreenCanvas where available
- Dirty-region tracking: each frame restores only what the previous one painted
- Trail projections memoised in a `WeakMap`, freed with the aircraft
- Memoised great-circle distances
- Coalesced DOM updates via `requestAnimationFrame` and `DocumentFragment`
- Request pooling: one in-flight promise per URL
- Periodic reclamation of stale aircraft and expired trail points
- Debounced `localStorage` writes and window resize

Every switch under `CONFIG.PERFORMANCE` is wired to real behaviour in this
release; see [CONFIG_EXAMPLE.md](CONFIG_EXAMPLE.md#performance-tuning) for what
each one does and when turning it off is diagnostic.

## License

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

## Support

- **Issues**: Report bugs via GitHub Issues
- **Discussions**: Feature requests and questions via GitHub Discussions
- **Documentation**: See CONFIG_EXAMPLE.md for detailed configuration

## Changelog

### v0.0.2 (Current)

**Moving receiver.** The scope centre can now follow a `POSITION` file, for a
receiver aboard a ship or vehicle. The file is polled with conditional requests
and the scope re-projects when it changes; NMEA 0183, JSON, `KEY=VALUE` and
bare `lat, lon` are all accepted. Sub-threshold GPS jitter is ignored rather
than rebuilding the scope, and a stale fix is flagged on the status bar and the
own-ship marker.

**Advertised features implemented.** Everything the original README promised
but the source did not do:

- Click a range ring to zoom to it
- `Clear Storage` button in the settings panel
- `D` toggles extended aircraft labels; `R` resets the view; `W` toggles
  runways; `?` opens help; `I` moved the debug overlay off `D`
- Settings panel gained Display, Theme and Performance sections
- `USE_OFFSCREEN_CANVAS`, `DIRTY_REGION_TRACKING`, `WEAK_REFERENCE_CLEANUP`,
  `BATCH_NETWORK_REQUESTS`, `PROXY_STATE_DETECTION`, `TRAIL_GRADIENT_SEGMENTS`,
  `SMOOTHING_FACTOR` and `HEADING_LINE_LENGTH` now do what they say
- `RESPONSE_COMPRESSION` removed: a browser negotiates transfer encoding
  itself and the setting could never have had an effect

**Defects fixed** (all twelve from the v0.0.1 audit; see
[KNOWN_ISSUES.md](KNOWN_ISSUES.md)):

- One unreachable data source no longer stops all polling; `CONN: Partial`
  works and warnings name the correct feed
- Failed requests no longer raise spurious error banners
- Runway visibility is no longer stored inverted
- Shortcuts no longer fire while typing in the settings form
- FPS readout no longer double-counts
- The emergency tone plays once per emergency, not once per second
- Airport and navaid caps now select the nearest, not the first in file order

### v0.0.1

Version reset. The upstream project stopped shipping source; the last
published source corresponds to what upstream labelled `0.9.2` — a testing
build that was subsequently released as `1.0.x` without source. This fork
restarts versioning at `0.0.1` to reflect the actual maturity of the code
that is available.

- Renumbered from `0.9.2.0837110925` to `0.0.1`
- Fixed `config.js` failing to parse: the `00.0000` home-position placeholder
  is a legacy octal literal, so the browser rejected the whole file
- Full JSDoc coverage across `app.js` and `config.js`
- Added `CONFIG_EXAMPLE.md`, `ARCHITECTURE.md` and `INSTALL.txt`
  (referenced by earlier releases but never shipped)
- Corrected the keyboard-shortcut list, theme counts and settings-panel
  description to match the source
- See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for defects found while auditing

Inherited from upstream `0.9.2`:
- 51 scope themes and 35 UI themes
- Real-time aircraft tracking with trails and vectors
- Airport and navaid display with runway layouts
- Emergency detection with visual and audible alerts
- Keyboard shortcuts and a settings panel
- LocalStorage settings persistence

---

**Enjoy tracking aircraft!**
