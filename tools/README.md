# Tools

Two generators for looking at the scope without a receiver or a GPS. Neither is
needed to run the application, and neither ships with a release.

They are separate on purpose: `demo-feed.js` writes `data/aircraft.json` and
`ship-sim.js` writes `POSITION`. Two processes writing the same file would fight
over it, so each owns one.

Run either or both, alongside a web server, with the demo configuration active:

```bash
cp config.demo.js config.local.js
node tools/demo-feed.js &
node tools/ship-sim.js &
python3 -m http.server 8000
```

Both write atomically — to a temporary name, then rename — so the scope never
reads a half-written file. Ctrl-C to stop.

---

## demo-feed.js — synthetic aircraft

Writes a tar1090-style `data/aircraft.json` once a second: eight aircraft
around the centre, chosen to exercise the parts of the scope that are otherwise
hard to see.

| Target | Exercises |
|---|---|
| Four airliners at altitude | Trails, vectors, ADS-B colour |
| `RCH271` | The military ICAO range, so the `M` filter has something to find |
| `AZU4501` | An mlat target, drawn in the mlat colour |
| `PS-ABC` | Ground movement — a square symbol, no altitude |
| `MAYDAY1` | Squawk 7700: the emergency banner, the alert tone, the flashing symbol |

```bash
node tools/demo-feed.js                       # defaults to Guanabara Bay
node tools/demo-feed.js --lat -23.96 --lon -46.33
```

| Flag | Default | Meaning |
|---|---|---|
| `--lat` | `-22.878029` | Centre latitude the traffic is arranged around |
| `--lon` | `-43.155934` | Centre longitude |

## ship-sim.js — a vessel under way

Rewrites `POSITION` each second, driving the moving-receiver mode. Eight knots
along the main channel of Guanabara Bay, courses changing as it follows the
route, turns rate-limited to 1.5°/s with wheel-over anticipation, a little yaw,
and speed shed in the turns. It reverses at each end of the route, so it runs
indefinitely.

```bash
node tools/ship-sim.js                    # 8 kt, KEY=VALUE, 1 Hz
node tools/ship-sim.js --format nmea      # emit NMEA RMC with a valid checksum
node tools/ship-sim.js --speed 12
node tools/ship-sim.js --check            # verify a long transit stays afloat
```

| Flag | Default | Meaning |
|---|---|---|
| `--speed` | `8` | Service speed in knots |
| `--format` | `key` | `key`, `nmea`, `json` or `pair` — all four formats `PositionManager` accepts |
| `--tick` | `1000` | Milliseconds between writes |
| `--check` | off | Run a transit as fast as the CPU allows and verify it, instead of writing the file |
| `--hours` | `12` | Hours of transit `--check` simulates |
| `--quiet` | off | Suppress the periodic position log |

`--format` is the quick way to exercise every branch of the POSITION parser
against a live scope rather than only in the test suite.

### How "always on water" is guaranteed

There is no coastline dataset in this repository, so the constraint is not
derived from one. Three layers stand in for it:

1. **The route** is a centreline through the navigable axis of the bay, laid
   out by hand from its known geography.
2. **A corridor** of ±110 m around that centreline. Cross-track error is
   measured every tick and steered against; past the limit the position is
   clamped back onto the corridor edge. That clamp is what makes this a
   guarantee rather than a hope.
3. **A water polygon**, deliberately conservative and independent of the route.
   `--check` tests every position of a full transit against it, so a mistake in
   the route is caught by something that does not share the route's
   assumptions.

```
SHIP TRACK CHECK — 12 h at 8 kt (~96 nm)
 PASS  every position inside the water polygon
 PASS  cross-track error within the corridor
 PASS  course varies
```

The clamps that do occur are at the two ends of the route, where the vessel
reverses through 180° — a turn any ship takes wide. Good enough to exercise the
scope; check the waypoints against a chart before trusting it for anything more.

### Importable

`ship-sim.js` exports its route, geometry and `step()` when required rather than
run, so its behaviour can be measured or tested without the CLI:

```javascript
const sim = require('./tools/ship-sim.js');
const state = sim.initialState();
for (let t = 0; t < 600; t++) sim.step(state, 1);   // ten minutes under way
```

---

See [../docs/CONFIG_EXAMPLE.md](../docs/CONFIG_EXAMPLE.md#moving-receiver-position-file)
for the POSITION file formats and the settings that govern tracking, and
[../test/README.md](../test/README.md) for the suites that verify all of it.
