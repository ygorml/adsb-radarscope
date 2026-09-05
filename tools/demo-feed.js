#!/usr/bin/env node
// Writes a synthetic tar1090-style aircraft.json once a second, so the scope
// can be looked at without a receiver.
//
//   node tools/demo-feed.js
//   node tools/demo-feed.js --lat -23.96 --lon -46.33
//
// This tool owns the aircraft only. The receiver's own position is driven by
// tools/ship-sim.js — run both to see traffic around a moving vessel. Keeping
// them separate matters: two processes writing POSITION would fight over it.
//
// Ctrl-C to stop. Writes <repo>/data/aircraft.json atomically, so the scope
// never reads a half-written file.

const fs = require('fs');
const path = require('path');

const ROOT = process.env.SCOPE_ROOT || path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    if (i === -1) return fallback;
    const v = parseFloat(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
};

// Guanabara Bay, Rio de Janeiro — 2 nm from Santos Dumont, 7 nm from Galeão,
// so the airport and runway layers have something to draw.
const HOME_LAT = arg('lat', -22.878028696269414);
const HOME_LON = arg('lon', -43.15593411053736);

const NM_PER_DEG = 60;

/** A spread of traffic: airliners, a military flight, ground movement, an emergency. */
const FLEET = [
    { hex: 'a1b2c3', flight: 'UAL482',  bearing:  20, dist: 34, alt: 37000, gs: 470, track: 205, squawk: '1200', adsb_version: 2 },
    { hex: 'a4d5e6', flight: 'DAL119',  bearing:  75, dist: 18, alt: 12500, gs: 290, track: 260, squawk: '3421', adsb_version: 2 },
    { hex: 'c01f2e', flight: 'AZU4501', bearing: 140, dist: 41, alt: 28000, gs: 430, track:  10, squawk: '4102', mlat: ['lat', 'lon'] },
    { hex: 'e48a11', flight: 'TAM3310', bearing: 205, dist: 26, alt:  8200, gs: 240, track:  35, squawk: '2571', adsb_version: 2 },
    { hex: 'ae1f04', flight: 'RCH271',  bearing: 265, dist: 45, alt: 24000, gs: 390, track:  95, squawk: '5100', adsb_version: 2 },
    { hex: 'a77b90', flight: 'GLO1245', bearing: 310, dist: 12, alt:  4300, gs: 190, track: 140, squawk: '1347', adsb_version: 2 },
    { hex: 'b0d1c2', flight: 'PS-ABC',  bearing:  95, dist:  3, alt:     0, gs:  14, track:  70, squawk: '2000', gnd: true },
    { hex: 'c0ffee', flight: 'MAYDAY1', bearing: 175, dist: 22, alt:  6000, gs: 210, track: 355, squawk: '7700', adsb_version: 2 }
];

/** Moves a lat/lon along a bearing by a distance in nautical miles. */
function offset(lat, lon, bearingDeg, distNm) {
    const rad = bearingDeg * Math.PI / 180;
    const dLat = (distNm * Math.cos(rad)) / NM_PER_DEG;
    const dLon = (distNm * Math.sin(rad)) / (NM_PER_DEG * Math.cos(lat * Math.PI / 180));
    return { lat: lat + dLat, lon: lon + dLon };
}

/** Writes atomically: the scope must never see a truncated file. */
function writeAtomic(file, body) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
}

let tick = 0;

function step() {
    tick++;

    const centreLat = HOME_LAT;
    const centreLon = HOME_LON;

    const aircraft = FLEET.map(a => {
        // Each aircraft flies its own track; the fleet also drifts around the
        // centre so the scope is never static.
        const travelled = (a.gs / 3600) * tick;
        const from = offset(centreLat, centreLon, a.bearing, a.dist);
        const now = a.gnd ? from : offset(from.lat, from.lon, a.track, travelled % 30);

        return {
            hex: a.hex,
            flight: a.flight.padEnd(8),
            lat: Number(now.lat.toFixed(5)),
            lon: Number(now.lon.toFixed(5)),
            alt_baro: a.gnd ? undefined : a.alt + Math.round(Math.sin(tick / 25) * 400),
            gs: a.gs,
            track: (a.track + Math.sin(tick / 40) * 6) % 360,
            squawk: a.squawk,
            ...(a.gnd ? { gnd: true } : {}),
            ...(a.mlat ? { mlat: a.mlat } : {}),
            ...(a.adsb_version !== undefined ? { adsb_version: a.adsb_version } : {})
        };
    });

    writeAtomic(path.join(ROOT, 'data', 'aircraft.json'),
        JSON.stringify({ now: Date.now() / 1000, messages: 100000 + tick * 37, aircraft }, null, 1));
}

step();
const timer = setInterval(step, 1000);

console.log(`feed    -> ${path.join(ROOT, 'data', 'aircraft.json')}`);
console.log(`centre  -> ${HOME_LAT}, ${HOME_LON}`);
console.log('ship    -> run tools/ship-sim.js alongside this to move the receiver');
console.log(`${FLEET.length} aircraft, 1 Hz. Ctrl-C to stop.`);

process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\nstopped');
    process.exit(0);
});
