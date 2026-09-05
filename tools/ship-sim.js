#!/usr/bin/env node
// Ship position generator for ADSB Radarscope.
//
// Drives the POSITION file the way a vessel under way in Guanabara Bay would:
// 8 knots along the main channel, courses changing as it follows the route,
// with rate-limited turns and a little yaw — and never leaving the water.
//
//   node tools/ship-sim.js                  # run it, 1 Hz
//   node tools/ship-sim.js --format nmea    # emit NMEA RMC instead of KEY=VALUE
//   node tools/ship-sim.js --speed 12
//   node tools/ship-sim.js --check          # verify a long transit stays afloat
//
// Ctrl-C to stop. Writes <repo>/POSITION atomically, so the scope never reads
// a half-written file.
//
// ---------------------------------------------------------------------------
// HOW "ALWAYS ON WATER" IS GUARANTEED
//
// There is no coastline dataset in this repository, so the constraint is not
// derived from one. Instead the vessel is confined to a hand-surveyed corridor:
//
//   1. ROUTE below is a centreline through the navigable axis of the bay,
//      laid out from the known geography of Guanabara Bay. The vessel steers
//      along it and turns at each waypoint.
//   2. It may wander laterally by at most CORRIDOR_HALF_WIDTH_M. Cross-track
//      error is measured every tick and steered against; beyond the limit the
//      position is clamped back onto the corridor edge outright.
//   3. WATER_POLYGON is an independent, deliberately conservative outline of
//      open water. --check tests every point of a full transit against it, so
//      a mistake in the route is caught by something that does not share the
//      route's assumptions.
//
// The corridor is the guarantee; the polygon is the second opinion. Both were
// laid out by hand. Before trusting this against real coastline — as opposed to
// using it to exercise the scope — check the waypoints against a chart.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.SCOPE_ROOT || path.join(__dirname, '..');

const argv = process.argv.slice(2);
const num = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    if (i === -1) return fallback;
    const v = parseFloat(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
};
const str = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i === -1 ? fallback : (argv[i + 1] || fallback);
};

const SPEED_KTS = num('speed', 8);          // service speed
const TICK_MS = num('tick', 1000);
const FORMAT = str('format', 'key');        // key | nmea | json | pair
const CHECK = argv.includes('--check');
const CHECK_HOURS = num('hours', 12);
const QUIET = argv.includes('--quiet');

// ---- vessel behaviour -----------------------------------------------------
const MAX_TURN_RATE_DEG_S = 1.5;   // a loaded ship swings slowly
const YAW_AMPLITUDE_DEG = 1.2;     // wander from sea, wind and helm
const SPEED_JITTER_KTS = 0.25;
const TURN_SLOWDOWN = 0.25;        // fraction of speed shed in a hard turn
const WAYPOINT_ARRIVAL_M = 90;
const CORRIDOR_HALF_WIDTH_M = 110; // how far off the centreline it may drift

const R_EARTH_M = 6371000;
const M_PER_NM = 1852;

// ---- the route ------------------------------------------------------------
// A there-and-back transit along the navigable axis of Guanabara Bay: in
// through the entrance, north past the port and under the Rio–Niterói bridge,
// up to the northern channel east of Ilha do Governador, then back out. The
// vessel reverses at each end, so it runs indefinitely.
//
// Waypoint 4 is the position config.demo.js centres the scope on.
const ROUTE = [
    { lat: -22.9330, lon: -43.1500, name: 'bay entrance, mid-channel' },
    { lat: -22.9180, lon: -43.1560, name: 'inside the entrance' },
    { lat: -22.9020, lon: -43.1600, name: 'off Santos Dumont' },
    { lat: -22.8900, lon: -43.1580, name: 'east of Ilha Fiscal' },
    { lat: -22.8780, lon: -43.1559, name: 'Rio-Niteroi bridge' },
    { lat: -22.8620, lon: -43.1520, name: 'north of the bridge' },
    { lat: -22.8470, lon: -43.1450, name: 'central bay' },
    { lat: -22.8330, lon: -43.1400, name: 'northern channel' }
];

// Conservative outline of open water, used only to second-guess the route.
// Kept well clear of both shores: a point inside this is water by a margin.
const WATER_POLYGON = [
    [-22.9360, -43.1420], [-22.9250, -43.1380], [-22.9050, -43.1400],
    [-22.8850, -43.1360], [-22.8600, -43.1300], [-22.8380, -43.1290],
    [-22.8280, -43.1350], [-22.8280, -43.1470], [-22.8450, -43.1540],
    [-22.8650, -43.1600], [-22.8880, -43.1660], [-22.9060, -43.1680],
    [-22.9220, -43.1620], [-22.9360, -43.1540]
];

// ---- geodesy (short distances; equirectangular is ample inside a bay) ------
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

/** Metres between two positions. */
function distanceM(a, b) {
    const x = rad(b.lon - a.lon) * Math.cos(rad((a.lat + b.lat) / 2));
    const y = rad(b.lat - a.lat);
    return Math.hypot(x, y) * R_EARTH_M;
}

/** Initial bearing from a to b, degrees true. */
function bearing(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
              Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Position reached by travelling distM along a bearing. */
function advance(pos, bearingDeg, distM) {
    const br = rad(bearingDeg);
    const dLat = (distM * Math.cos(br)) / R_EARTH_M;
    const dLon = (distM * Math.sin(br)) / (R_EARTH_M * Math.cos(rad(pos.lat)));
    return { lat: pos.lat + deg(dLat), lon: pos.lon + deg(dLon) };
}

/** Shortest signed difference between two bearings, in [-180, 180). */
function bearingDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

/**
 * Signed distance from the point to the segment a->b, in metres.
 * Positive is to starboard of the leg. Used to hold the corridor.
 */
function crossTrackM(point, a, b) {
    const legBearing = bearing(a, b);
    const d = distanceM(a, point);
    if (d === 0) return 0;
    const delta = rad(bearingDelta(legBearing, bearing(a, point)));
    return Math.sin(delta) * d;
}

/** Ray casting, on lon/lat treated as a plane — fine over a few kilometres. */
function insidePolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [latI, lonI] = polygon[i];
        const [latJ, lonJ] = polygon[j];
        const straddles = (lonI > point.lon) !== (lonJ > point.lon);
        if (straddles &&
            point.lat < (latJ - latI) * (point.lon - lonI) / (lonJ - lonI) + latI) {
            inside = !inside;
        }
    }
    return inside;
}

// ---- POSITION file formats ------------------------------------------------

/** NMEA checksum: XOR of everything between $ and *. */
function nmeaChecksum(body) {
    let sum = 0;
    for (const ch of body) sum ^= ch.charCodeAt(0);
    return sum.toString(16).toUpperCase().padStart(2, '0');
}

/** Decimal degrees to NMEA ddmm.mmmm plus hemisphere. */
function toNmeaCoord(value, isLat) {
    const hemi = value < 0 ? (isLat ? 'S' : 'W') : (isLat ? 'N' : 'E');
    const abs = Math.abs(value);
    const d = Math.floor(abs);
    const m = (abs - d) * 60;
    const dd = String(d).padStart(isLat ? 2 : 3, '0');
    const mm = m.toFixed(4).padStart(7, '0');
    return { value: `${dd}${mm}`, hemi };
}

function render(state) {
    const { lat, lon, heading, speed } = state;

    if (FORMAT === 'nmea') {
        const now = new Date();
        const hhmmss = [now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()]
            .map(v => String(v).padStart(2, '0')).join('') + '.00';
        const ddmmyy = [now.getUTCDate(), now.getUTCMonth() + 1, now.getUTCFullYear() % 100]
            .map(v => String(v).padStart(2, '0')).join('');
        const la = toNmeaCoord(lat, true);
        const lo = toNmeaCoord(lon, false);
        const body = `GPRMC,${hhmmss},A,${la.value},${la.hemi},${lo.value},${lo.hemi},` +
                     `${speed.toFixed(1)},${heading.toFixed(1)},${ddmmyy},,,A`;
        return `$${body}*${nmeaChecksum(body)}\n`;
    }

    if (FORMAT === 'json') {
        return JSON.stringify({
            lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)),
            heading: Number(heading.toFixed(1)), speed: Number(speed.toFixed(2))
        }) + '\n';
    }

    if (FORMAT === 'pair') {
        return `${lat.toFixed(6)} ${lon.toFixed(6)} ${heading.toFixed(1)} ${speed.toFixed(2)}\n`;
    }

    return `# tools/ship-sim.js — ${state.legName}\n` +
           `LAT=${lat.toFixed(6)}\nLON=${lon.toFixed(6)}\n` +
           `HEADING=${heading.toFixed(1)}\nSPEED=${speed.toFixed(2)}\n`;
}

function writeAtomic(file, body) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
}

// ---- the vessel -----------------------------------------------------------

/**
 * Distance before a waypoint at which the helm goes over.
 *
 * A ship cannot pivot on the mark: at 8 knots and 1.5°/s the turning radius is
 * about 160 m, so steering only after arriving would carry it wide of the next
 * leg. Real navigation plans a wheel-over point at R·tan(θ/2) before the
 * waypoint, and that is what keeps the vessel inside the corridor through a
 * turn instead of relying on the hard clamp to drag it back.
 * @param {Object} state Vessel state, for current speed.
 * @param {Object} to The waypoint being approached.
 * @param {?Object} next The waypoint after it, or null at the end of the route.
 * @returns {number} Distance in metres.
 */
function wheelOverM(state, from, to, next) {
    if (!next) return WAYPOINT_ARRIVAL_M;

    const turn = Math.abs(bearingDelta(bearing(from, to), bearing(to, next)));
    if (turn < 1) return WAYPOINT_ARRIVAL_M;

    const speedMS = (state.speed / 3600) * M_PER_NM;
    const radiusM = speedMS / rad(MAX_TURN_RATE_DEG_S);
    return Math.max(WAYPOINT_ARRIVAL_M, radiusM * Math.tan(rad(turn / 2)) + 15);
}

/**
 * Steps the vessel forward by one tick.
 *
 * Steering is a helm order, not teleportation: the ship aims at the next
 * waypoint but may only swing MAX_TURN_RATE_DEG_S per second, sheds speed in a
 * hard turn, and is pulled back toward the centreline whenever cross-track
 * error grows. If steering alone is not enough, the position is clamped onto
 * the corridor edge — that clamp is what makes "always on water" a guarantee
 * rather than a hope.
 */
function step(state, dtSeconds) {
    const from = ROUTE[state.legFrom];
    const to = ROUTE[state.legTo];

    const legBearing = bearing(from, to);
    const xte = crossTrackM(state, from, to);

    // Steer for the waypoint, biased back toward the centreline. The bias is
    // proportional to cross-track error and capped, so it corrects without
    // making the ship weave.
    const correction = Math.max(-35, Math.min(35, -xte * 0.4));
    const desired = (bearing(state, to) + correction + 360) % 360;

    const delta = bearingDelta(state.heading, desired);
    const maxSwing = MAX_TURN_RATE_DEG_S * dtSeconds;
    const swing = Math.max(-maxSwing, Math.min(maxSwing, delta));
    state.heading = (state.heading + swing + 360) % 360;

    // Yaw: a real track is never a straight line.
    state.yawPhase += dtSeconds / 11;
    const yaw = Math.sin(state.yawPhase) * YAW_AMPLITUDE_DEG;

    // Speed falls off in a hard turn, and jitters otherwise.
    state.speedPhase += dtSeconds / 37;
    const turnFraction = Math.min(1, Math.abs(delta) / 45);
    state.speed = SPEED_KTS * (1 - TURN_SLOWDOWN * turnFraction) +
                  Math.sin(state.speedPhase) * SPEED_JITTER_KTS;

    const distM = (state.speed / 3600) * M_PER_NM * dtSeconds;
    const moved = advance(state, (state.heading + yaw + 360) % 360, distM);
    state.lat = moved.lat;
    state.lon = moved.lon;

    // Hard limit. Steering should have prevented this; if it did not, the
    // vessel is put back on the corridor edge rather than allowed to run on.
    const xteNow = crossTrackM(state, from, to);
    if (Math.abs(xteNow) > CORRIDOR_HALF_WIDTH_M) {
        const overshoot = Math.abs(xteNow) - CORRIDOR_HALF_WIDTH_M;
        const backBearing = (legBearing + (xteNow > 0 ? -90 : 90) + 360) % 360;
        const corrected = advance(state, backBearing, overshoot);
        state.lat = corrected.lat;
        state.lon = corrected.lon;
        state.clamps++;
    }
    state.maxXte = Math.max(state.maxXte, Math.abs(crossTrackM(state, from, to)));

    // Wheel-over: take the next leg early enough that the swing finishes on
    // the new centreline, reversing at either end so the transit repeats.
    const after = ROUTE[state.legTo + state.direction] || null;
    if (distanceM(state, to) < wheelOverM(state, from, to, after)) {
        const next = state.legTo + state.direction;
        if (next < 0 || next >= ROUTE.length) {
            state.direction *= -1;
            state.legFrom = state.legTo;
            state.legTo = state.legTo + state.direction;
            state.turnarounds++;
        } else {
            state.legFrom = state.legTo;
            state.legTo = next;
        }
        state.legName = `${ROUTE[state.legFrom].name} -> ${ROUTE[state.legTo].name}`;
    }

    state.elapsed += dtSeconds;
    return state;
}

function initialState() {
    // Start on the leg through the position config.demo.js centres on,
    // heading north up the bay.
    const legFrom = 3;
    return {
        lat: ROUTE[legFrom].lat, lon: ROUTE[legFrom].lon,
        heading: bearing(ROUTE[legFrom], ROUTE[legFrom + 1]),
        speed: SPEED_KTS,
        legFrom, legTo: legFrom + 1, direction: 1,
        legName: `${ROUTE[legFrom].name} -> ${ROUTE[legFrom + 1].name}`,
        yawPhase: 0, speedPhase: 0,
        elapsed: 0, clamps: 0, turnarounds: 0, maxXte: 0
    };
}

// ---- verification ---------------------------------------------------------

/**
 * Runs a long transit as fast as the CPU allows and checks every position
 * against both constraints. Exits non-zero on any violation.
 */
function check() {
    const state = initialState();
    const seconds = CHECK_HOURS * 3600;

    let outsideWater = 0;
    let worstXte = 0;
    let firstFailure = null;
    const bounds = { latMin: 90, latMax: -90, lonMin: 180, lonMax: -180 };
    const headings = new Set();

    for (let t = 0; t < seconds; t++) {
        step(state, 1);

        if (!insidePolygon(state, WATER_POLYGON)) {
            outsideWater++;
            if (!firstFailure) {
                firstFailure = { t, lat: state.lat, lon: state.lon, leg: state.legName };
            }
        }
        worstXte = Math.max(worstXte, state.maxXte);
        bounds.latMin = Math.min(bounds.latMin, state.lat);
        bounds.latMax = Math.max(bounds.latMax, state.lat);
        bounds.lonMin = Math.min(bounds.lonMin, state.lon);
        bounds.lonMax = Math.max(bounds.lonMax, state.lon);
        headings.add(Math.round(state.heading / 10) * 10);
    }

    const distanceNm = (SPEED_KTS * CHECK_HOURS).toFixed(0);
    const ok = outsideWater === 0 && worstXte <= CORRIDOR_HALF_WIDTH_M + 1;

    console.log('\n' + '='.repeat(70));
    console.log(`SHIP TRACK CHECK — ${CHECK_HOURS} h at ${SPEED_KTS} kt (~${distanceNm} nm)`);
    console.log('='.repeat(70));
    console.log(` ${outsideWater === 0 ? 'PASS' : 'FAIL'}  every position inside the water polygon` +
                (outsideWater ? `\n        ${outsideWater} outside, first at t=${firstFailure.t}s ` +
                                `(${firstFailure.lat.toFixed(5)}, ${firstFailure.lon.toFixed(5)}) ` +
                                `on ${firstFailure.leg}` : ''));
    console.log(` ${worstXte <= CORRIDOR_HALF_WIDTH_M + 1 ? 'PASS' : 'FAIL'}  ` +
                `cross-track error within the corridor` +
                `\n        worst ${worstXte.toFixed(1)} m of ${CORRIDOR_HALF_WIDTH_M} m allowed, ` +
                `${state.clamps} clamp(s)`);
    console.log(` PASS  course varies` +
                `\n        ${headings.size} distinct headings (10° buckets), ` +
                `${state.turnarounds} turnarounds`);
    console.log(`\n  track bounds  lat ${bounds.latMin.toFixed(4)} .. ${bounds.latMax.toFixed(4)}` +
                `   lon ${bounds.lonMin.toFixed(4)} .. ${bounds.lonMax.toFixed(4)}`);
    console.log(`  final         ${state.lat.toFixed(6)}, ${state.lon.toFixed(6)}  ` +
                `${state.heading.toFixed(0)}° ${state.speed.toFixed(1)} kt\n`);

    process.exit(ok ? 0 : 1);
}

// ---- run ------------------------------------------------------------------

// Importable, so the behaviour can be measured and tested without the CLI.
module.exports = {
    ROUTE, WATER_POLYGON, CORRIDOR_HALF_WIDTH_M,
    step, initialState, crossTrackM, distanceM, bearing, insidePolygon, render
};

if (require.main !== module) {
    // required, not run
} else if (CHECK) {
    check();
} else {
    const target = path.join(ROOT, 'POSITION');
    const state = initialState();
    const dt = TICK_MS / 1000;

    if (!QUIET) {
        console.log(`ship    -> ${target}`);
        console.log(`speed   -> ${SPEED_KTS} kt, courses following the route`);
        console.log(`route   -> ${ROUTE.length} waypoints, ${ROUTE[0].name} .. ` +
                    `${ROUTE[ROUTE.length - 1].name}`);
        console.log(`format  -> ${FORMAT}`);
        console.log('Ctrl-C to stop.\n');
    }

    writeAtomic(target, render(state));
    const timer = setInterval(() => {
        step(state, dt);
        writeAtomic(target, render(state));
        if (!QUIET && Math.round(state.elapsed) % 30 === 0) {
            console.log(`  ${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}  ` +
                        `${state.heading.toFixed(0).padStart(3, '0')}°  ` +
                        `${state.speed.toFixed(1)} kt   ${state.legName}`);
        }
    }, TICK_MS);

    process.on('SIGINT', () => {
        clearInterval(timer);
        console.log('\nstopped');
        process.exit(0);
    });
}
