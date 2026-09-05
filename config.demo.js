// ADSB Radarscope — test / demonstration configuration
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// -----------------------------------------------------------------------
// This file is an OVERRIDE. It is loaded after config.js and mutates CONFIG
// in place, so config.js keeps your real deployment settings untouched.
//
// To use it:
//
//     cp config.demo.js config.local.js
//
// index.html loads config.local.js if it is present. That filename is
// gitignored, so a local experiment never lands in a commit. Delete it to go
// back to config.js alone.
//
// What it sets up: a receiver in Guanabara Bay, Rio de Janeiro, under way at
// 3 knots on a course of 180°, reading the reference data shipped in data/.
// Santos Dumont is 2 nm away and Galeão 7 nm, so the airport, navaid and
// runway layers all have something to draw.
// -----------------------------------------------------------------------

(function () {
    'use strict';

    if (typeof CONFIG === 'undefined') {
        console.error('config.local.js loaded before config.js — check the script order in index.html');
        return;
    }

    // ---- Where the scope is centred ------------------------------------
    // Guanabara Bay, off Ilha do Governador. Used until the POSITION file
    // below supplies its first fix, and whenever tracking is switched off.
    CONFIG.DEFAULT_HOME_LAT = -22.878028696269414;
    CONFIG.DEFAULT_HOME_LON = -43.15593411053736;
    CONFIG.DEFAULT_RANGE_NM = 40;        // wide enough to hold all four airports

    // ---- Read the files that ship with the repository -------------------
    // The stock config.js points these at the receiver, which is right for a
    // real install but wrong here: the CSVs are local, served beside the page.
    CONFIG.DATA_PATHS = {
        AIRPORTS: 'data/airports.csv',
        NAVAIDS:  'data/navaids.csv',
        RUNWAYS:  'data/runways.csv'
    };

    // Aircraft feed. tools/demo-feed.js writes this file once a second; point
    // it at a real receiver instead when you have one.
    //
    // Note the asymmetry with DATA_PATHS above: those are fetched directly and
    // accept a relative path, but a data source runs through
    // URLValidator.isValidDataSourceUrl, which requires an absolute http(s)
    // URL. Resolving against location.href satisfies that without hard-coding
    // a host or port, so this works on whatever port you serve from.
    CONFIG.DEFAULT_TAR1090_URL = new URL('data/aircraft.json', window.location.href).href;

    // Guanabara Bay is dense with small strips. 3000 ft keeps the runway layer
    // to the fields that are actually legible at this range.
    CONFIG.AIRPORT_DISPLAY.MIN_RUNWAY_LENGTH_FT = 3000;

    // ---- Moving receiver -------------------------------------------------
    // A ship, so the scope reads POSITION and draws a hull at the centre.
    // POSITION ships holding this same position at SPEED=3, HEADING=180;
    // run tools/ship-sim.js to get under way at 8 knots.
    CONFIG.RECEIVER_TYPE = 'ship';
    CONFIG.POSITION_FILE.PATH = 'POSITION';
    CONFIG.POSITION_FILE.POLL_INTERVAL_MS = 1000;

    // At 3 knots the receiver covers about 1.5 m per second, well under the
    // 9 m default threshold — so with the stock value the scope would only
    // re-project every few seconds. Lowered here so the movement is visible.
    CONFIG.POSITION_FILE.MIN_MOVE_NM = 0.0005;   // ~0.9 m
    CONFIG.SHOW_RECEIVER_MARKER = true;

    // ---- Visibility over correctness, for a demonstration ---------------
    CONFIG.SWEEP_DURATION_S = 3.0;       // a little brisker than the 3.8 default
    CONFIG.TRAIL_FADE_TIME_MINUTES = 8;  // keep history around long enough to see
    CONFIG.HEADING_LINE_LENGTH = 12;

    console.log('config.local.js: demo configuration active — Guanabara Bay, ' +
                'ship receiver tracking POSITION, reading data/ locally');
})();
