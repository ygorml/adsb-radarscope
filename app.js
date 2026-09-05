// ADSB Radarscope
// Author: dustsignal
// Version: 0.0.2
// GitHub: https://github.com/dustsignal/adsb-scope
// Speical thanks to: wire99 & Josh M.

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
/**
 * @file Main application for ADSB Radarscope: a canvas radar display fed by
 * tar1090 / dump1090 / PiAware aircraft feeds.
 *
 * The whole application lives in one IIFE and is organised as a set of
 * single-instance namespaces:
 *
 * - {@link StateManager} / {@link state} — observable application state
 * - {@link DataManager} — polls the feeds, merges and validates messages
 * - {@link CSVDataManager} — loads airports, navaids and runways
 * - {@link PositionManager} — tracks a moving receiver from a POSITION file
 * - {@link AircraftStateManager} — promotes targets as the sweep passes
 * - {@link CanvasRenderer} / {@link Renderer} — static and dynamic layers
 * - {@link UIManager} — panels, tables, popups and alerts
 * - {@link EventHandlers} — input handling and settings persistence
 * - {@link ScopeLoop} — the requestAnimationFrame driver
 * - {@link App} — startup and teardown
 *
 * Data flows one way each cycle: fetch → validate → sweep-gated promotion
 * → render → throttled UI refresh.
 *
 * Every position the application stores is geographic, never a screen pixel.
 * That is what lets the scope centre move: with a POSITION file configured the
 * receiver can be aboard a ship, and aircraft, trails, airports, navaids and
 * runways all re-project correctly around the new origin.
 *
 * @author dustsignal
 * @see {@link https://github.com/dustsignal/adsb-scope}
 * @license GPL-3.0-or-later
 */

/**
 * One aircraft as reported by a tar1090-compatible feed. Every field
 * except `hex` may be absent depending on what the aircraft transmits.
 * @typedef {Object} AircraftMessage
 * @property {string} hex ICAO 24-bit address, hexadecimal.
 * @property {string} [flight] Callsign, space-padded at the source.
 * @property {number} lat Latitude in decimal degrees.
 * @property {number} lon Longitude in decimal degrees.
 * @property {number} [alt_baro] Barometric altitude in feet.
 * @property {number} [gs] Ground speed in knots.
 * @property {number} [track] Track over ground in degrees true.
 * @property {string} [squawk] Mode A code, four octal digits.
 * @property {boolean} [gnd] True when the aircraft reports being on ground.
 * @property {Array} [mlat] Fields derived by multilateration; a non-empty
 *   array marks the target as mlat rather than ADS-B.
 * @property {number} [adsb_version] ADS-B version, present on ADS-B targets.
 * @property {string} [dataSource] Name of the feed it arrived on, added on
 *   merge by {@link DataManager.mergeAircraftData}.
 */

/**
 * An airport from the OurAirports `airports.csv`.
 * @typedef {Object} Airport
 * @property {string} icao Four-character ICAO identifier.
 * @property {string} name Airport name.
 * @property {number} lat Latitude in decimal degrees.
 * @property {number} lon Longitude in decimal degrees.
 * @property {number} elevation Field elevation in feet.
 * @property {string} type OurAirports size class.
 * @property {string} municipality Nearest town or city.
 * @property {string} iso_country ISO 3166-1 alpha-2 country code.
 */

/**
 * A navigation aid from the OurAirports `navaids.csv`.
 * @typedef {Object} Navaid
 * @property {string} ident Navaid identifier.
 * @property {string} name Navaid name.
 * @property {string} type `VOR`, `VORTAC`, `NDB`, `DME` and similar.
 * @property {number} lat Latitude in decimal degrees.
 * @property {number} lon Longitude in decimal degrees.
 * @property {number} elevation Elevation in feet.
 * @property {number} frequency Frequency in kHz.
 * @property {string} associated_airport ICAO of the airport it serves.
 */

/**
 * A runway from the OurAirports `runways.csv`, as a line between its two
 * thresholds.
 * @typedef {Object} Runway
 * @property {string} airport_ident ICAO of the owning airport.
 * @property {string} id Runway pair, e.g. `09/27`.
 * @property {number} length Length in feet.
 * @property {number} width Width in feet.
 * @property {string} surface Surface code.
 * @property {boolean} lighted Whether the runway is lit.
 * @property {boolean} closed Whether the runway is closed.
 * @property {number} lat1 Low-end threshold latitude.
 * @property {number} lon1 Low-end threshold longitude.
 * @property {number} lat2 High-end threshold latitude.
 * @property {number} lon2 High-end threshold longitude.
 * @property {number} le_heading Low-end heading, degrees true.
 * @property {number} he_heading High-end heading, degrees true.
 */

/**
 * One fix read from the POSITION file.
 * @typedef {Object} OwnPositionFix
 * @property {number} lat Latitude in decimal degrees.
 * @property {number} lon Longitude in decimal degrees.
 * @property {?number} heading Course over ground in degrees true, when the
 *   source provides it.
 * @property {?number} speed Speed over ground in knots, when the source
 *   provides it.
 * @property {string} format Which parser matched, for the status readout.
 */

/**
 * A position projected onto the canvas.
 * @typedef {Object} ScreenPosition
 * @property {number} x Canvas X in pixels.
 * @property {number} y Canvas Y in pixels.
 * @property {number} dist Distance from home in nautical miles.
 */

/**
 * One pooled point of an aircraft trail, stored geographically.
 * @typedef {Object} TrailPoint
 * @property {number} lat Latitude in decimal degrees.
 * @property {number} lon Longitude in decimal degrees.
 * @property {number} timestamp Epoch milliseconds when it was recorded.
 * @property {number} x Scratch field reserved by the pool.
 * @property {number} y Scratch field reserved by the pool.
 */

/**
 * Expose the scope theme palettes to Tailwind, when the Play CDN build is
 * present, so utility classes can reference theme colours.
 */
if (window.tailwind) {
    tailwind.config = {
        theme: {
            extend: {
                colors: SCOPE_THEME_COLORS
            }
        }
    };
}

// Application wrapped in IIFE with performance optimizations
(function() {
    'use strict';

    /**
     * Observable state container.
     *
     * Wraps a plain object in a Proxy so that assigning to any top-level
     * property notifies the callbacks subscribed to it. Only the top level is
     * observed — mutating a nested object in place fires nothing.
     * @class
     */
    class StateManager {
        /**
         * @param {Object} initialState Initial state shape.
         */
        constructor(initialState) {
            this.listeners = new Map();
            this.state = this.createProxy(initialState);
        }

        /**
         * Wraps an object in a Proxy whose setter notifies subscribers on change.
         *
         * With {@link CONFIG.PERFORMANCE.IMMUTABLE_STATE_UPDATES} on, object values
         * are deep-cloned on assignment so callers cannot mutate stored state
         * behind the store's back — at the cost of a clone per write.
         * @param {Object} obj Plain object to make reactive.
         * @returns {Proxy<Object>} The observable state object.
         */
        createProxy(obj) {
            const self = this;
            // With change detection off the store is a plain object: writes are
            // cheaper, but subscribers never fire.
            if (!CONFIG.PERFORMANCE.PROXY_STATE_DETECTION) return obj;
            return new Proxy(obj, {
                set(target, property, value) {
                    const oldValue = target[property];
                    if (CONFIG.PERFORMANCE.IMMUTABLE_STATE_UPDATES && 
                        typeof value === 'object' && value !== null) {
                        value = JSON.parse(JSON.stringify(value));
                    }
                    target[property] = value;
                    
                    if (oldValue !== value) {
                        self.notifyListeners(property, value, oldValue);
                    }
                    return true;
                }
            });
        }

        /**
         * Registers a callback fired whenever a property changes.
         * @param {string} property Property to watch.
         * @param {function(*, *): void} callback Receives `(newValue, oldValue)`.
         * @returns {void}
         */
        subscribe(property, callback) {
            if (!this.listeners.has(property)) {
                this.listeners.set(property, new Set());
            }
            this.listeners.get(property).add(callback);
        }

        /**
         * Invokes every callback registered for a property.
         * @param {string} property Property that changed.
         * @param {*} newValue Value after the write.
         * @param {*} oldValue Value before the write.
         * @returns {void}
         */
        notifyListeners(property, newValue, oldValue) {
            const callbacks = this.listeners.get(property);
            if (callbacks) {
                callbacks.forEach(callback => callback(newValue, oldValue));
            }
        }
    }

    /**
     * A fixed-size pool of reusable objects.
     *
     * Recycling short-lived objects (trail points, above all) keeps the
     * allocation rate low enough that garbage-collection pauses do not show up
     * as stutter in the sweep.
     * @class
     */
    class ObjectPool {
        /**
         * @param {function(): Object} createFn Factory for new instances.
         * @param {?function(Object): void} resetFn Clears an object before reuse.
         * @param {number} [initialSize=CONFIG.PERFORMANCE.OBJECT_POOL_SIZE] How
         *   many objects to pre-allocate.
         */
        constructor(createFn, resetFn, initialSize = CONFIG.PERFORMANCE.OBJECT_POOL_SIZE) {
            this.createFn = createFn;
            this.resetFn = resetFn;
            this.pool = [];
            
            for (let i = 0; i < initialSize; i++) {
                this.pool.push(this.createFn());
            }
        }

        /**
         * Takes an object from the pool, creating a new one if it is empty.
         * @returns {Object} A reset, ready-to-use object.
         */
        acquire() {
            return this.pool.length > 0 ? this.pool.pop() : this.createFn();
        }

        /**
         * Resets an object and returns it to the pool.
         * @param {Object} obj Object to recycle.
         * @returns {void}
         */
        release(obj) {
            if (this.resetFn) this.resetFn(obj);
            this.pool.push(obj);
        }
    }

    /**
     * Pool of trail points. Aircraft trails churn thousands of small objects a
     * minute, so they are recycled instead of allocated.
     * @type {ObjectPool}
     */
    const trailPointPool = new ObjectPool(
        () => ({ x: 0, y: 0, lat: 0, lon: 0, timestamp: 0 }),
        (obj) => { obj.x = obj.y = obj.lat = obj.lon = obj.timestamp = 0; }
    );

    /**
     * The single application state store.
     *
     * `aircraftData` is the raw feed; `displayedAircraft` is the subset the
     * sweep has painted, each entry carrying its screen position, geographic
     * trail and fade alpha. The rest is session statistics, layer toggles,
     * user settings and the handles ({@link state.eventListeners},
     * `intervals`, `timeouts`) that make a clean teardown possible.
     * @type {StateManager}
     */
    const stateManager = new StateManager({
        aircraftData: {},
        displayedAircraft: {},
        sessionStats: {
            uniqueAircraft: new Set(),
            maxConcurrent: 0,
            startTime: Date.now(),
            messagesReceived: 0,
            sourceDistribution: { adsb: 0, mlat: 0, other: 0 }
        },
        selectedHex: null,
        connectionStatus: "Connecting...",
        isPaused: false,
        showDebugInfo: false,
        showLabelDetails: true,
        sweepAngle: 0,
        prevSweepAngle: 0,
        staticEpoch: 0,
        maxRangeNm: CONFIG.DEFAULT_RANGE_NM,
        scopeThemeIndex: 0,
        uiTheme: 'default-dark',
        aircraftFilter: 'all',
        activeAlerts: new Set(),
        reportedSourceFailures: new Set(),
        lastUiUpdateTime: 0,
        showVectors: false,
        showTrails: true,
        showAirports: false,
        showNavaids: false,
        showRunways: true,
        soundEnabled: false,
        homeLat: CONFIG.DEFAULT_HOME_LAT,
        homeLon: CONFIG.DEFAULT_HOME_LON,
        positionFileEnabled: CONFIG.POSITION_FILE.ENABLED,
        positionFilePath: CONFIG.POSITION_FILE.PATH,
        positionPollIntervalMs: CONFIG.POSITION_FILE.POLL_INTERVAL_MS,
        positionMinMoveNm: CONFIG.POSITION_FILE.MIN_MOVE_NM,
        showOwnShip: CONFIG.POSITION_FILE.SHOW_OWN_SHIP,
        ownHeading: null,
        ownSpeed: null,
        ownPositionUpdatedAt: 0,
        ownPositionFormat: null,
        positionFileStatus: { kind: 'disabled', message: '', at: 0 },
        dataSources: [{ url: CONFIG.DEFAULT_TAR1090_URL, name: 'Default', enabled: true }],
        retryAttempts: {},
        popupAircraft: null,
        popupUpdateInterval: null,
        airports: [],
        navaids: [],
        runways: [],
        dataLoaded: false,
        lastRangeNm: CONFIG.DEFAULT_RANGE_NM,
        minRunwayLength: CONFIG.AIRPORT_DISPLAY.MIN_RUNWAY_LENGTH_FT,
        aircraftSectionExpanded: true,
        metricsSectionExpanded: true,
        maxTrailLength: CONFIG.MAX_TRAIL_LENGTH,
        trailFadeTimeMinutes: CONFIG.TRAIL_FADE_TIME_MINUTES,
        trailWidth: 2,
        lastDataUpdate: 0,
        renderRequested: false,
        lastRenderTime: 0,
        frameCount: 0,
        fps: 0,
        lastFpsUpdateTime: 0,
        eventListeners: [],
        intervals: [],
        timeouts: []
    });

    /**
     * The reactive application state. Writing to a property here notifies any
     * subscriber registered on it.
     * @type {Object}
     */
    const state = stateManager.state;

    /**
     * Side-table for per-aircraft metadata that must not keep an aircraft
     * object alive once it is dropped from state.
     * @type {WeakMap<Object, Object>}
     */
    const aircraftReferences = new WeakMap();

    /**
     * Cached references to every DOM node the app touches, resolved once at
     * load. Entries may be `null` if the markup changed, so callers use
     * optional chaining.
     * @type {Object<string, ?Element>}
     */
    const elements = {
        canvas: document.getElementById('radarCanvas'),
        canvasContainer: document.getElementById('canvas-container'),
        versionDisplay: document.getElementById('version-display'),
        aircraftListBody: document.getElementById('aircraft-list-body'),
        metricsPanel: document.getElementById('metrics-panel'),
        shortcutBar: document.getElementById('shortcut-bar'),
        scopeStatusBar: document.getElementById('scope-status-bar'),
        pausedText: document.getElementById('pausedText'),
        aircraftPopup: document.getElementById('aircraft-popup'),
        airportPopup: document.getElementById('airport-popup'),
        alertContainer: document.getElementById('alert-container'),
        uiThemeButton: document.getElementById('ui-theme-button'),
        uiThemeMenu: document.getElementById('ui-theme-menu'),
        scopeThemeButton: document.getElementById('scope-theme-button'),
        scopeThemeMenu: document.getElementById('scope-theme-menu'),
        hideUiButton: document.getElementById('hide-ui-button'),
        rightPanel: document.getElementById('right-panel'),
        rightResizer: document.getElementById('right-resizer'),
        helpModal: document.getElementById('help-modal'),
        closeHelpButton: document.getElementById('close-help-button'),
        vectorsButton: document.getElementById('vectors-button'),
        trailsButton: document.getElementById('trails-button'),
        airportsButton: document.getElementById('airports-button'),
        navaidsButton: document.getElementById('navaids-button'),
        runwaysButton: document.getElementById('runways-button'),
        settingsButton: document.getElementById('settings-button'),
        exportButton: document.getElementById('export-button'),
        settingsModal: document.getElementById('settings-modal'),
        mobileMenuButton: document.getElementById('mobile-menu-button'),
        mobileMenu: document.getElementById('mobile-menu'),
        mobileOverlay: document.getElementById('mobile-overlay'),
        loadingIndicator: document.getElementById('loading-indicator'),
        aircraftHeader: document.getElementById('aircraft-header'),
        aircraftToggle: document.getElementById('aircraft-toggle'),
        aircraftSection: document.getElementById('aircraft-section'),
        metricsHeader: document.getElementById('metrics-header'),
        metricsToggle: document.getElementById('metrics-toggle'),
        metricsSection: document.getElementById('metrics-section'),
        ctx: null
    };

    /**
     * Acquire the 2D context up front; without it the scope cannot render and
     * {@link CanvasRenderer} is never constructed.
     */
    if (elements.canvas) {
        elements.ctx = elements.canvas.getContext('2d');
        if (!elements.ctx) {
            ErrorBoundary.handleError(new Error('Canvas 2D context not supported'), 'Canvas');
        }
    }

    /**
     * Renders the static layer of the scope — background, range rings, compass
     * rose, airports, navaids and runways — and caches it as a bitmap.
     *
     * These elements only change when the range, layer toggles, theme, canvas
     * size or home position change, so caching them keeps the per-frame cost to
     * the moving parts: sweep, aircraft and trails.
     *
     * It also owns the dirty-region bookkeeping that lets a frame restore only
     * the parts of that bitmap the previous frame painted over.
     * @class
     */
    class CanvasRenderer {
        /**
         * Fraction of the canvas above which partial restore stops paying for
         * itself and a single full-canvas restore is used instead.
         * @type {number}
         */
        static DIRTY_AREA_LIMIT = 0.55;

        /**
         * @param {CanvasRenderingContext2D} ctx Context of the visible canvas.
         */
        constructor(ctx) {
            this.ctx = ctx;
            this.offscreenCanvas = null;
            this.offscreenCtx = null;
            this.staticElementsCache = null;
            this.dirtyRegions = [];
            this.lastStaticRender = 0;
            
            if (CONFIG.PERFORMANCE.USE_OFFSCREEN_CANVAS && 'OffscreenCanvas' in window) {
                this.initOffscreenCanvas();
            }
        }

        /**
         * Creates the offscreen canvas at the current canvas size. Falls back
         * silently to on-screen rendering where OffscreenCanvas is unavailable.
         * @returns {void}
         */
        initOffscreenCanvas() {
            try {
                this.offscreenCanvas = new OffscreenCanvas(
                    elements.canvas.width || 800, 
                    elements.canvas.height || 600
                );
                this.offscreenCtx = this.offscreenCanvas.getContext('2d');
            } catch (e) {
                console.warn('OffscreenCanvas not supported, using fallback');
            }
        }

        /**
         * Records a rectangle painted this frame, so the next one knows what to
         * erase. Clipped to the canvas and padded slightly to cover antialiasing.
         * No-op when {@link CONFIG.PERFORMANCE.DIRTY_REGION_TRACKING} is off.
         * @param {number} x Left edge.
         * @param {number} y Top edge.
         * @param {number} width Width in pixels.
         * @param {number} height Height in pixels.
         * @returns {void}
         */
        markDirty(x, y, width, height) {
            if (!CONFIG.PERFORMANCE.DIRTY_REGION_TRACKING) return;
            if (!(width > 0) || !(height > 0)) return;

            const pad = 2;                       // cover antialiasing spill
            const w = elements.canvas ? elements.canvas.width : 0;
            const h = elements.canvas ? elements.canvas.height : 0;
            const x0 = Math.max(0, Math.floor(x - pad));
            const y0 = Math.max(0, Math.floor(y - pad));
            const x1 = Math.min(w, Math.ceil(x + width + pad));
            const y1 = Math.min(h, Math.ceil(y + height + pad));

            if (x1 <= x0 || y1 <= y0) return;
            this.dirtyRegions.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        }

        /**
         * Merges the regions painted last frame into a small set of rectangles
         * that can be restored individually.
         *
         * Returns `null` when partial restore is not worth it — no regions,
         * tracking disabled, or a combined area above
         * {@link CanvasRenderer.DIRTY_AREA_LIMIT} of the canvas, where one full
         * `putImageData` is cheaper than many small ones.
         * @returns {?Array<{x: number, y: number, width: number, height: number}>}
         */
        collectDirtyRegions() {
            if (!CONFIG.PERFORMANCE.DIRTY_REGION_TRACKING) return null;
            if (this.dirtyRegions.length === 0) return null;

            // Bucket into horizontal bands, then union each band. Cheap, and a
            // good fit for targets scattered across the scope.
            const bandHeight = 64;
            const bands = new Map();

            for (const r of this.dirtyRegions) {
                const band = Math.floor(r.y / bandHeight);
                const existing = bands.get(band);
                if (!existing) {
                    bands.set(band, { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
                } else {
                    existing.x0 = Math.min(existing.x0, r.x);
                    existing.y0 = Math.min(existing.y0, r.y);
                    existing.x1 = Math.max(existing.x1, r.x + r.width);
                    existing.y1 = Math.max(existing.y1, r.y + r.height);
                }
            }

            const merged = [];
            let area = 0;
            for (const b of bands.values()) {
                const rect = { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 };
                area += rect.width * rect.height;
                merged.push(rect);
            }

            const canvasArea = (elements.canvas.width || 1) * (elements.canvas.height || 1);
            if (area >= canvasArea * CanvasRenderer.DIRTY_AREA_LIMIT) return null;

            return merged;
        }

        /**
         * Drops all tracked dirty regions, at the end of each frame's restore.
         * @returns {void}
         */
        clearDirtyRegions() {
            this.dirtyRegions = [];
        }

        /**
         * Returns the cached bitmap of the static layer, re-rendering it only when
         * something it depends on changed.
         *
         * The cache key covers geometry, range, layer toggles, theme and
         * `state.staticEpoch` — which {@link PositionManager} bumps when a moving
         * receiver has actually travelled far enough to matter — so the rings,
         * compass rose, airports, navaids and runways are rasterised once and
         * blitted every frame instead of being redrawn.
         *
         * Rasterisation happens on the offscreen canvas where the browser
         * provides one, so it never touches the visible canvas.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {(ImageData|undefined)} The cached bitmap, or `undefined` when
         *   static caching is disabled in {@link CONFIG}.
         */
        cacheStaticElements(cx, cy, radius) {
            if (!CONFIG.PERFORMANCE.CACHE_STATIC_ELEMENTS) return;

            // staticEpoch changes only when the receiver has moved far enough to
            // matter; without it a moving home position would either serve a
            // stale bitmap or rebuild it on every GPS jitter.
            const cacheKey = `${cx}-${cy}-${radius}-${state.maxRangeNm}-${state.showAirports}-${state.showNavaids}-${state.showRunways}-${state.scopeThemeIndex}-${state.staticEpoch}`;
            const now = Date.now();
            
            if (this.staticElementsCache && this.staticElementsCache.key === cacheKey) {
                return this.staticElementsCache.imageData;
            }

            // Render into the offscreen canvas when the browser has one, so the
            // rasterisation never touches the visible canvas; otherwise fall
            // back to a scratch <canvas>.
            const width = elements.canvas.width;
            const height = elements.canvas.height;
            let tempCtx = null;

            if (this.offscreenCanvas && this.offscreenCtx) {
                if (this.offscreenCanvas.width !== width || this.offscreenCanvas.height !== height) {
                    this.offscreenCanvas.width = width;
                    this.offscreenCanvas.height = height;
                }
                this.offscreenCtx.clearRect(0, 0, width, height);
                tempCtx = this.offscreenCtx;
            } else {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = height;
                tempCtx = tempCanvas.getContext('2d');
            }

            // Draw static elements
            this.drawStaticScope(tempCtx, cx, cy, radius);
            
            const imageData = tempCtx.getImageData(0, 0, width, height);
            this.staticElementsCache = { key: cacheKey, imageData };
            this.lastStaticRender = now;
            
            return imageData;
        }

        /**
         * Paints the whole static layer in draw order: background, runways,
         * airports and navaids, the four range rings with their labels, and the
         * crosshairs and compass rose.
         * @param {CanvasRenderingContext2D} ctx Target context — the visible canvas
         *   or an offscreen one being cached.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawStaticScope(ctx, cx, cy, radius) {
            // Background
            ctx.fillStyle = ThemeManager.getScopeThemeColor('background');
            ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            
            // Airports, navaids, and runways (static)
            if (state.showAirports || state.showNavaids || state.showRunways) {
            // Get airport data if we need to show airports OR runways
            const airports = (state.showAirports || state.showRunways) 
                ? CSVDataManager.getAirportsInRange(state.homeLat, state.homeLon, state.maxRangeNm) 
                : [];

            // Draw runways for each airport if enabled
            if (state.showRunways && airports.length > 0) {
                for (const airport of airports) {
                    this.drawRunwaysForAirport(ctx, airport.icao, cx, cy, radius);
                }
            }

            // Draw airport symbols and navaids if enabled
            if (state.showAirports || state.showNavaids) {
                // We pass the already-fetched airport data to this function
                this.drawAirportsAndNavaids(ctx, cx, cy, radius, airports);
            }
            }
            
            // Grid
            ctx.strokeStyle = ThemeManager.getScopeThemeColor('grid');
            ctx.lineWidth = 1.2;
            
            // Range rings
            for (let i = 1; i <= 4; i++) {
                const ringRadius = radius * (i / 4);
                const rangeNm = state.maxRangeNm * (i / 4);
                
                ctx.beginPath();
                ctx.arc(cx, cy, ringRadius, 0, 2 * Math.PI);
                ctx.stroke();
                
                // Range labels
                this.drawRangeLabel(ctx, cx, cy, ringRadius, rangeNm, i);
            }
            
            // Crosshairs and tick marks
            this.drawCrosshairsAndTicks(ctx, cx, cy, radius);
        }

        /**
         * Labels one range ring with its distance in nautical miles.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} ringRadius Radius of this ring in pixels.
         * @param {number} rangeNm Distance the ring represents.
         * @param {number} index 1-based ring number, outermost is 4.
         * @returns {void}
         */
        drawRangeLabel(ctx, cx, cy, ringRadius, rangeNm, index) {
            ctx.save();
            ctx.fillStyle = ThemeManager.getScopeThemeColor('text');
            ctx.globalAlpha = 0.9;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.font = 'bold 10px monospace';
            
            const labelX = cx + 5;
            const labelY = cy + ringRadius + 4;
            
            ctx.fillText(`${rangeNm}nm`, labelX, labelY);
            ctx.restore();
        }

        /**
         * Draws the centre crosshairs and the compass rose: ticks every 10°,
         * lengthened at 30° and 90°, with numeric labels on the non-cardinal
         * marks.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawCrosshairsAndTicks(ctx, cx, cy, radius) {
            // Crosshairs
            ctx.strokeStyle = ThemeManager.getScopeThemeColor('grid');
            ctx.beginPath();
            ctx.moveTo(cx - radius, cy);
            ctx.lineTo(cx + radius, cy);
            ctx.moveTo(cx, cy - radius);
            ctx.lineTo(cx, cy + radius);
            ctx.stroke();
            
            // Tick marks
            ctx.font = '8px monospace';
            ctx.fillStyle = ThemeManager.getScopeThemeColor('text');
            
            for (let i = 0; i < 360; i += 10) {
                const angleRad = MathUtils.toRad(i + 270);
                const tickLength = (i % 90 === 0) ? 12 : ((i % 30 === 0) ? 8 : 4);
                const endR = radius + tickLength;
                
                ctx.beginPath();
                ctx.moveTo(cx + radius * Math.cos(angleRad), cy + radius * Math.sin(angleRad));
                ctx.lineTo(cx + endR * Math.cos(angleRad), cy + endR * Math.sin(angleRad));
                ctx.stroke();
                
                // Add a numeric label for every 10 degrees, except for the cardinal points.
                if (i % 90 !== 0) {
                    this.drawTickLabel(ctx, cx, cy, radius, i, angleRad);
                }
            }
            
            // Cardinal directions
            this.drawCardinalDirections(ctx, cx, cy, radius);
        }

        /**
         * Draws one bearing label outside the compass rose, rotated to sit
         * radially.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @param {number} angle Bearing in degrees, used as the label text.
         * @param {number} angleRad Same bearing in canvas radians.
         * @returns {void}
         */
        drawTickLabel(ctx, cx, cy, radius, angle, angleRad) {
            const textRadius = radius + 20;
            const textX = cx + textRadius * Math.cos(angleRad);
            const textY = cy + textRadius * Math.sin(angleRad);
            
            ctx.save();
            ctx.translate(textX, textY);
            ctx.rotate(angleRad + Math.PI/2);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(angle.toString(), 0, 0);
            ctx.restore();
        }

        /**
         * Draws the N/E/S/W cardinal markers just outside the outer ring.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawCardinalDirections(ctx, cx, cy, radius) {
            const textRadius = radius + 25;
            ctx.font = `${Math.max(10, radius * 0.035)}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = ThemeManager.getScopeThemeColor('text');
            
            ctx.fillText("N", cx, cy - textRadius);
            ctx.fillText("E", cx + textRadius, cy);
            ctx.fillText("S", cx, cy + textRadius);
            ctx.fillText("W", cx - textRadius, cy);
        }

        /**
         * Draws the airport and navaid layers.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @param {?Array<Airport>} [airports=null] Airports already looked up by
         *   the caller; when `null` they are fetched here.
         * @returns {void}
         */
        drawAirportsAndNavaids(ctx, cx, cy, radius, airports = null) {
            // If airport data isn't passed in, fetch it now.
            const airportData = airports !== null ? airports : (state.showAirports ? 
                CSVDataManager.getAirportsInRange(state.homeLat, state.homeLon, state.maxRangeNm) : []);

            const navaids = state.showNavaids ? 
                CSVDataManager.getNavaidsInRange(state.homeLat, state.homeLon, state.maxRangeNm) : [];
            
            // Draw airports
            if (state.showAirports && airportData.length > 0) {
                this.drawAirports(ctx, airportData, cx, cy, radius);
            }
            
            // Draw navaids
            if (state.showNavaids && navaids.length > 0) {
                this.drawNavaids(ctx, navaids, cx, cy, radius);
            }
        }

        /**
         * Draws airport symbols with their ICAO labels, plus their runways when
         * that layer is enabled.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {Array<Airport>} airports Airports to draw.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawAirports(ctx, airports, cx, cy, radius) {
            ctx.save();
            ctx.strokeStyle = '#8888FF';
            ctx.fillStyle = '#8888FF';
            ctx.lineWidth = 2;
            
            for (const airport of airports) {
                const pos = MathUtils.latLonToScreen(airport.lat, airport.lon, state.maxRangeNm, cx, cy, radius);
                if (!pos) continue;
                
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, CONFIG.AIRPORT_DISPLAY.SYMBOL_SIZE, 0, 2 * Math.PI);
                ctx.stroke();
                
                ctx.font = `${CONFIG.AIRPORT_DISPLAY.LABEL_FONT_SIZE}px monospace`;
                ctx.textAlign = 'center';
                ctx.fillText(airport.icao, pos.x, pos.y - 12);
                
                if (state.showRunways) {
                    this.drawRunwaysForAirport(ctx, airport.icao, cx, cy, radius);
                }
            }
            ctx.restore();
        }

        /**
         * Draws navaid symbols with their identifiers: a hexagon for VOR and
         * VORTAC, a circle for everything else.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {Array<Navaid>} navaids Navaids to draw.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawNavaids(ctx, navaids, cx, cy, radius) {
            ctx.save();
            ctx.strokeStyle = '#FFAA88';
            ctx.fillStyle = '#FFAA88';
            ctx.lineWidth = 1;
            
            for (const navaid of navaids) {
                const pos = MathUtils.latLonToScreen(navaid.lat, navaid.lon, state.maxRangeNm, cx, cy, radius);
                if (!pos) continue;
                
                ctx.beginPath();
                if (navaid.type === 'VOR' || navaid.type === 'VORTAC') {
                    // Draw hexagon for VOR
                    for (let i = 0; i < 6; i++) {
                        const angle = (i * Math.PI) / 3;
                        const x = pos.x + CONFIG.AIRPORT_DISPLAY.NAVAID_SYMBOL_SIZE * Math.cos(angle);
                        const y = pos.y + CONFIG.AIRPORT_DISPLAY.NAVAID_SYMBOL_SIZE * Math.sin(angle);
                        if (i === 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    ctx.closePath();
                } else {
                    ctx.arc(pos.x, pos.y, CONFIG.AIRPORT_DISPLAY.NAVAID_SYMBOL_SIZE, 0, 2 * Math.PI);
                }
                ctx.stroke();
                
                ctx.font = '9px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(navaid.ident, pos.x, pos.y - 10);
            }
            ctx.restore();
        }

        /**
         * Draws every runway of one airport as a line between its two thresholds.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {string} icao Airport ICAO identifier.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawRunwaysForAirport(ctx, icao, cx, cy, radius) {
            const runways = CSVDataManager.getRunwaysForAirport(icao);
            
            ctx.save();
            ctx.strokeStyle = '#6666AA';
            ctx.lineWidth = CONFIG.AIRPORT_DISPLAY.RUNWAY_LINE_WIDTH;
            
            for (const runway of runways) {
                const pos1 = MathUtils.latLonToScreen(runway.lat1, runway.lon1, state.maxRangeNm, cx, cy, radius);
                const pos2 = MathUtils.latLonToScreen(runway.lat2, runway.lon2, state.maxRangeNm, cx, cy, radius);
                
                if (pos1 && pos2) {
                    ctx.beginPath();
                    ctx.moveTo(pos1.x, pos1.y);
                    ctx.lineTo(pos2.x, pos2.y);
                    ctx.stroke();
                }
            }
            ctx.restore();
        }
    }

    /**
     * Static-layer renderer, or `null` when no 2D context could be obtained.
     * @type {?CanvasRenderer}
     */
    let canvasRenderer = null;
    if (elements.ctx) {
        canvasRenderer = new CanvasRenderer(elements.ctx);
    }

    /**
     * Web Audio context for alert tones. Created lazily on the first user
     * click, because browsers block one constructed without a gesture.
     * @type {?AudioContext}
     */
    let audioContext = null;

    /**
     * Central error handling. Every subsystem funnels failures here so a fault
     * in one layer degrades that layer instead of stopping the scope.
     * @namespace ErrorBoundary
     */
    const ErrorBoundary = {
        /**
         * Logs an error, surfaces it to the user and reports it to analytics when
         * a `gtag` collector is present.
         * @param {Error} error The failure.
         * @param {string} [context="Application"] Subsystem where it happened.
         * @returns {void}
         */
        handleError(error, context = 'Application') {
            console.error(`[${context}] Error:`, error);
            this.showError(`${context} Error: ${error.message}`);
            
            if (window.gtag) {
                window.gtag('event', 'exception', {
                    description: `${context}: ${error.message}`,
                    fatal: false
                });
            }
        },
        
        /**
         * Shows a dismissible error banner for 10 seconds.
         * @param {string} message Error text.
         * @returns {void}
         */
        showError(message) {
            const errorDisplay = document.getElementById('error-display');
            if (!errorDisplay) return;
            
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.innerHTML = `
                <div class="flex justify-between items-center">
                    <span>${message}</span>
                    <button onclick="this.parentElement.parentElement.remove()" class="ml-2 text-white hover:text-red-200">×</button>
                </div>
            `;
            errorDisplay.appendChild(errorDiv);
            
            setTimeout(() => {
                if (errorDiv.parentNode) {
                    errorDiv.remove();
                }
            }, 10000);
        },
        
        /**
         * Shows a dismissible warning banner for 7 seconds.
         * @param {string} message Warning text.
         * @returns {void}
         */
        showWarning(message) {
            const errorDisplay = document.getElementById('error-display');
            if (!errorDisplay) return;
            
            const warningDiv = document.createElement('div');
            warningDiv.className = 'warning-message';
            warningDiv.innerHTML = `
                <div class="flex justify-between items-center">
                    <span>${message}</span>
                    <button onclick="this.parentElement.parentElement.remove()" class="ml-2 text-white hover:text-orange-200">×</button>
                </div>
            `;
            errorDisplay.appendChild(warningDiv);
            
            setTimeout(() => {
                if (warningDiv.parentNode) {
                    warningDiv.remove();
                }
            }, 7000);
        }
    };

    /**
     * Periodic reclamation of stale aircraft and expired trail points. Without
     * it a long-running session accumulates history for aircraft that left
     * range hours ago.
     * @namespace MemoryManager
     */
    const MemoryManager = {
        /**
         * Expires trail points older than `trailFadeTimeMinutes` and aircraft not
         * heard from for `SWEEP_DURATION_S × AIRCRAFT_TIMEOUT_FACTOR` seconds,
         * returning their trail points to the pool rather than leaving them for
         * the collector.
         * @returns {void}
         */
        cleanup() {
            const now = Date.now();
            const cutoffTime = now - (state.trailFadeTimeMinutes * 60 * 1000);
            
            // Clean up old trail points using object pool
            Object.values(state.displayedAircraft).forEach(aircraft => {
                if (aircraft.geoTrail) {
                    const validPoints = [];
                    aircraft.geoTrail.forEach(point => {
                        if (!point.timestamp || point.timestamp > cutoffTime) {
                            validPoints.push(point);
                        } else {
                            trailPointPool.release(point);
                        }
                    });
                    aircraft.geoTrail = validPoints;
                }
            });
            
            // Clean up old aircraft
            const aircraftCutoff = now - (CONFIG.SWEEP_DURATION_S * CONFIG.AIRCRAFT_TIMEOUT_FACTOR * 1000);
            Object.keys(state.displayedAircraft).forEach(hex => {
                const aircraft = state.displayedAircraft[hex];
                if (aircraft.lastUpdateTime && (aircraft.lastUpdateTime * 1000) < aircraftCutoff) {
                    // Clean up trail points before deleting aircraft
                    if (aircraft.geoTrail) {
                        aircraft.geoTrail.forEach(point => trailPointPool.release(point));
                    }
                    delete state.displayedAircraft[hex];
                }
            });

            // Force garbage collection (if available)
            if (window.gc && CONFIG.PERFORMANCE.AGGRESSIVE_TRAIL_CLEANUP) {
                window.gc();
            }
        },
        
        /**
         * Starts the periodic cleanup on a
         * {@link CONFIG.MEMORY_CLEANUP_INTERVAL_MS} interval, registered for
         * teardown.
         * @returns {void}
         */
        scheduleCleanup() {
            const cleanupInterval = setInterval(() => this.cleanup(), CONFIG.MEMORY_CLEANUP_INTERVAL_MS);
            state.intervals.push(cleanupInterval);
        }
    };

    /**
     * Geodesic maths for the scope: distance, bearing, projection to screen
     * coordinates and dead reckoning. Distance results are memoised because
     * they dominate the per-frame cost.
     * @namespace MathUtils
     */
    const MathUtils = {
        /**
         * Memoised {@link MathUtils.haversineDistance} results, capped at 1000
         * entries.
         * @type {Map<string, number>}
         */
        _cache: new Map(),
        
        /**
         * Degrees to radians.
         * @param {number} deg Angle in degrees.
         * @returns {number} Angle in radians.
         */
        toRad: (deg) => deg * Math.PI / 180,

        /**
         * Radians to degrees.
         * @param {number} rad Angle in radians.
         * @returns {number} Angle in degrees.
         */
        toDeg: (rad) => rad * 180 / Math.PI,
        
        /**
         * Great-circle distance in nautical miles.
         *
         * Results are memoised on coordinates rounded to four decimals (~11 m),
         * because the same pairs are recomputed many times per frame while
         * filtering airports and navaids. The cache is capped at 1000 entries and
         * evicts oldest-first.
         * @param {number} lat1 Start latitude.
         * @param {number} lon1 Start longitude.
         * @param {number} lat2 End latitude.
         * @param {number} lon2 End longitude.
         * @returns {number} Distance in nautical miles.
         */
        haversineDistance(lat1, lon1, lat2, lon2) {
            const cacheKey = `${lat1.toFixed(4)}-${lon1.toFixed(4)}-${lat2.toFixed(4)}-${lon2.toFixed(4)}`;
            if (this._cache.has(cacheKey)) {
                return this._cache.get(cacheKey);
            }
            
            const R = 3440.065; // Nautical miles
            const dLat = this.toRad(lat2 - lat1);
            const dLon = this.toRad(lon2 - lon1);
            const a = Math.sin(dLat / 2) ** 2 + 
                     Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLon / 2) ** 2;
            const result = R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
            
            this._cache.set(cacheKey, result);
            if (this._cache.size > 1000) {
                const firstKey = this._cache.keys().next().value;
                this._cache.delete(firstKey);
            }
            
            return result;
        },
        
        /**
         * Initial great-circle bearing from one point to another.
         * @param {number} lat1 Start latitude.
         * @param {number} lon1 Start longitude.
         * @param {number} lat2 End latitude.
         * @param {number} lon2 End longitude.
         * @returns {number} Bearing in degrees true, normalised to 0–360.
         */
        bearing(lat1, lon1, lat2, lon2) {
            const lat1Rad = this.toRad(lat1);
            const lat2Rad = this.toRad(lat2);
            const dLon = this.toRad(lon2 - lon1);
            const y = Math.sin(dLon) * Math.cos(lat2Rad);
            const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - 
                     Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
            return (this.toDeg(Math.atan2(y, x)) + 360) % 360;
        },
        
        /**
         * Converts a geographic position to canvas coordinates, relative to the
         * configured home position. North is up, so the compass bearing is rotated
         * by −90° into canvas space.
         * @param {number} lat Target latitude.
         * @param {number} lon Target longitude.
         * @param {number} maxRange Scope range in nautical miles.
         * @param {number} centerX Canvas centre X.
         * @param {number} centerY Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {?ScreenPosition} Screen position and distance, or `null` when
         *   the target lies beyond `maxRange`.
         */
        latLonToScreen(lat, lon, maxRange, centerX, centerY, radius) {
            const distNm = this.haversineDistance(state.homeLat, state.homeLon, lat, lon);
            if (distNm > maxRange) return null;
            
            const brngDeg = this.bearing(state.homeLat, state.homeLon, lat, lon);
            const screenAngleRad = this.toRad(brngDeg - 90);
            const distPx = (distNm / maxRange) * radius;
            
            return {
                x: centerX + distPx * Math.cos(screenAngleRad),
                y: centerY + distPx * Math.sin(screenAngleRad),
                dist: distNm
            };
        },
        
        /**
         * Projects a stored geographic trail to screen space.
         *
         * Trails are kept as lat/lon and converted per frame rather than cached as
         * pixels, so a zoom or window resize re-projects history correctly instead
         * of stretching it. Points outside the current range are omitted.
         * @param {Array<TrailPoint>} geoTrail Stored trail points.
         * @param {number} maxRange Scope range in nautical miles.
         * @param {number} centerX Canvas centre X.
         * @param {number} centerY Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {Array<{x: number, y: number, timestamp: number}>} Screen trail.
         */
        geoTrailToScreen(geoTrail, maxRange, centerX, centerY, radius) {
            const screenTrail = [];
            for (let i = 0; i < geoTrail.length; i++) {
                const point = geoTrail[i];
                const screenPos = this.latLonToScreen(point.lat, point.lon, maxRange, centerX, centerY, radius);
                if (screenPos) {
                    screenTrail.push({
                        x: screenPos.x,
                        y: screenPos.y,
                        timestamp: point.timestamp
                    });
                }
            }
            return screenTrail;
        },
        
        /**
         * Dead-reckons a future position along a great circle, given a track and
         * ground speed. Used to draw speed vectors.
         * @param {number} lat Current latitude.
         * @param {number} lon Current longitude.
         * @param {number} track Track over ground, degrees true.
         * @param {number} speedKts Ground speed in knots.
         * @param {number} minutes Minutes to project ahead.
         * @returns {{lat: number, lon: number}} Projected position.
         */
        projectPosition(lat, lon, track, speedKts, minutes) {
            const distNm = (speedKts / 60) * minutes;
            const R = 3440.065;
            const d = distNm / R;
            const brng = this.toRad(track);
            const lat1 = this.toRad(lat);
            const lon1 = this.toRad(lon);
            
            const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + 
                        Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
            const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
                                          Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
            
            return {
                lat: this.toDeg(lat2),
                lon: this.toDeg(lon2)
            };
        }
    };

    /**
     * Positions tooltips so they follow the pointer and stay inside the
     * viewport, with tap-to-show behaviour on touch devices.
     * @namespace TooltipManager
     */
    const TooltipManager = {
        activeTooltip: null,
        mobileTimeout: null,
        
        /**
         * Starts tracking the pointer for tooltip placement, and adds touch
         * handling on touch-capable devices.
         * @returns {void}
         */
        init() {
            document.addEventListener('mousemove', (e) => {
                const activeTooltip = document.querySelector('.tooltip:hover .tooltip-text');
                if (activeTooltip) {
                    this.positionTooltip(activeTooltip, e);
                }
            });
            
            if ('ontouchstart' in window) {
                document.addEventListener('touchstart', this.handleMobileTouch.bind(this));
            }
        },
        
        /**
         * Positions a tooltip near the pointer, nudging it back inside the
         * viewport and flipping it below the cursor when there is no room above.
         * @param {HTMLElement} tooltip Tooltip element.
         * @param {(MouseEvent|Touch)} event Source of the coordinates.
         * @returns {void}
         */
        positionTooltip(tooltip, event) {
            const rect = tooltip.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            let x = event.clientX;
            let y = event.clientY - rect.height - 10;
            
            if (x + rect.width > viewportWidth) {
                x = viewportWidth - rect.width - 10;
            }
            if (x < 10) {
                x = 10;
            }
            if (y < 10) {
                y = event.clientY + 20;
            }
            
            tooltip.style.left = `${x}px`;
            tooltip.style.top = `${y}px`;
        },
        
        /**
         * Touch handler: shows the tooltip of the touched control, or dismisses
         * the current one when the touch lands elsewhere.
         * @param {TouchEvent} e
         * @returns {void}
         */
        handleMobileTouch(e) {
            const button = e.target.closest('.tooltip');
            if (button) {
                e.preventDefault();
                this.showMobileTooltip(button, e.touches[0]);
            } else {
                this.hideMobileTooltip();
            }
        },
        
        /**
         * Shows a tooltip for a touch target and schedules it to disappear after
         * 3 seconds.
         * @param {HTMLElement} button Element that owns the tooltip.
         * @param {Touch} touch Touch point used for positioning.
         * @returns {void}
         */
        showMobileTooltip(button, touch) {
            this.hideMobileTooltip();
            
            const tooltip = button.querySelector('.tooltip-text');
            if (tooltip) {
                tooltip.classList.add('mobile-show');
                this.positionTooltip(tooltip, touch);
                this.activeTooltip = tooltip;
                
                this.mobileTimeout = setTimeout(() => {
                    this.hideMobileTooltip();
                }, 3000);
            }
        },
        
        /**
         * Hides the active touch tooltip and clears its auto-dismiss timer.
         * @returns {void}
         */
        hideMobileTooltip() {
            if (this.activeTooltip) {
                this.activeTooltip.classList.remove('mobile-show');
                this.activeTooltip = null;
            }
            if (this.mobileTimeout) {
                clearTimeout(this.mobileTimeout);
                this.mobileTimeout = null;
            }
        }
    };

    /**
     * Web Audio alerts. Tones are synthesised on the fly, so the app ships no
     * audio assets.
     * @namespace SoundManager
     */
    const SoundManager = {
        /**
         * Plays the two-tone emergency chirp (880 Hz dropping to 440 Hz over
         * 500 ms). Silent unless the user enabled sound and the AudioContext has
         * been unlocked by a click.
         * @returns {void}
         */
        playEmergencyAlert() {
            if (!state.soundEnabled || !audioContext) return;
            
            try {
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                
                oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
                oscillator.frequency.setValueAtTime(440, audioContext.currentTime + 0.1);
                
                gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
                
                oscillator.start(audioContext.currentTime);
                oscillator.stop(audioContext.currentTime + 0.5);
            } catch (error) {
                ErrorBoundary.handleError(error, 'Sound');
            }
        }
    };

    /**
     * Applies and persists the UI theme, and resolves colour roles for the
     * active scope theme.
     * @namespace ThemeManager
     */
    const ThemeManager = {
        /**
         * Applies the current UI theme by setting `data-ui-theme` on the root
         * element (the CSS custom properties key off that attribute) and
         * persists the choice.
         * @returns {void}
         */
        applyUiTheme() {
            try {
                document.documentElement.setAttribute('data-ui-theme', state.uiTheme);
                if (CONFIG.PERFORMANCE.LOCALSTORAGE_DEBOUNCE_MS) {
                    this.debouncedSave();
                } else {
                    localStorage.setItem('adsbScope_uiTheme', state.uiTheme);
                }
            } catch (error) {
                ErrorBoundary.handleError(error, 'Theme');
            }
        },
        
        /**
         * Debounced writer for the `adsbScope_uiTheme` key.
         * @type {function(): void}
         */
        debouncedSave: (() => {
            let timeout;
            return () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    localStorage.setItem('adsbScope_uiTheme', state.uiTheme);
                }, CONFIG.PERFORMANCE.LOCALSTORAGE_DEBOUNCE_MS);
            };
        })(),
        
        /**
         * Looks up a colour role in the active scope theme.
         * @param {string} colorName Role: `background`, `grid`, `sweep`,
         *   `aircraft`, `selected`, `emergency`, `ground`, `text`, `mlat`,
         *   `adsb` or `other`.
         * @returns {string} Hex colour, or magenta `#FF00FF` when the role is
         *   missing — deliberately loud, so gaps are obvious on screen.
         */
        getScopeThemeColor(colorName) {
            const themeKey = SCOPE_THEMES[state.scopeThemeIndex]?.key || 'classic';
            const colorConfig = SCOPE_THEME_COLORS[themeKey] || {};
            return colorConfig[colorName] || '#FF00FF';
        }
    };

    /**
     * Validation and sanitisation of user-supplied data-source URLs.
     * @namespace URLValidator
     */
    const URLValidator = {
        /**
         * Parseable as a URL and served over HTTP(S).
         * @param {string} string Candidate URL.
         * @returns {boolean} True if valid.
         */
        isValidUrl(string) {
            try {
                const url = new URL(string);
                return url.protocol === 'http:' || url.protocol === 'https:';
            } catch {
                return false;
            }
        },
        
        /**
         * Checks that a URL is well-formed and looks like an aircraft feed —
         * `aircraft.json`, a `/data/` path, or any `.json` endpoint.
         * @param {string} url Candidate URL.
         * @returns {boolean} True if it is usable as a data source.
         */
        isValidDataSourceUrl(url) {
            if (!this.isValidUrl(url)) return false;
            
            if (url.includes('aircraft.json') || 
                url.includes('/data/') || 
                url.endsWith('.json')) {
                return true;
            }
            
            return false;
        },
        
        /**
         * Strips whitespace and angle brackets from a URL before it is echoed
         * back into the settings markup.
         * @param {string} url Raw user input.
         * @returns {string} Sanitised URL, or an empty string.
         */
        sanitizeUrl(url) {
            if (!url) return '';
            return url.trim().replace(/[<>]/g, '');
        }
    };

    /**
     * Loads and queries the static geographic reference data (airports,
     * navaids and runways) from the OurAirports CSV files under `data/`.
     * @namespace CSVDataManager
     */
    const CSVDataManager = {
        /**
         * Loads the airport, navaid and runway CSVs in parallel.
         *
         * Uses `allSettled`, so one missing file degrades a single layer instead
         * of leaving the map blank; each failure raises its own warning. The
         * static scope layer is invalidated once the data lands.
         * @returns {Promise<void>}
         */
        async loadAllData() {
            try {
                elements.loadingIndicator?.classList.remove('hidden');
                
                const [airports, navaids, runways] = await Promise.allSettled([
                    this.loadCSV(CONFIG.DATA_PATHS.AIRPORTS, this.parseAirports),
                    this.loadCSV(CONFIG.DATA_PATHS.NAVAIDS, this.parseNavaids),
                    this.loadCSV(CONFIG.DATA_PATHS.RUNWAYS, this.parseRunways)
                ]);
                
                state.airports = airports.status === 'fulfilled' ? airports.value : [];
                state.navaids = navaids.status === 'fulfilled' ? navaids.value : [];
                state.runways = runways.status === 'fulfilled' ? runways.value : [];
                state.dataLoaded = true;
                
                console.log(`Loaded ${state.airports.length} airports, ${state.navaids.length} navaids, ${state.runways.length} runways`);
                
                // Force a redraw of the static canvas layer now that the data is loaded
                Renderer.markForRedraw();
                
                if (airports.status === 'rejected') {
                    ErrorBoundary.showWarning('Airport data could not be loaded');
                }
                if (navaids.status === 'rejected') {
                    ErrorBoundary.showWarning('Navaid data could not be loaded');
                }
                if (runways.status === 'rejected') {
                    ErrorBoundary.showWarning('Runway data could not be loaded');
                }
            } catch (error) {
                ErrorBoundary.handleError(error, 'CSV Data Loading');
                state.airports = [];
                state.navaids = [];
                state.runways = [];
            } finally {
                elements.loadingIndicator?.classList.add('hidden');
            }
        },
        
        /**
         * Fetches one CSV file and hands it to a parser.
         * @param {string} path URL of the CSV.
         * @param {function(string): Array<Object>} parser Parser for this file.
         * @returns {Promise<Array<Object>>} Parsed records.
         * @throws {Error} If the response status is not OK.
         */
        async loadCSV(path, parser) {
            const response = await fetch(path);
            if (!response.ok) {
                throw new Error(`Failed to fetch ${path}: ${response.status}`);
            }
            const text = await response.text();
            return parser(text);
        },
        
        /**
         * Parses the OurAirports `airports.csv`, keeping only records with a
         * position and a four-character ICAO code.
         * @param {string} csvText Raw CSV.
         * @returns {Array<Airport>} Parsed airports.
         */
        parseAirports(csvText) {
            const lines = csvText.split('\n');
            const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
            const airports = [];
            
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const values = CSVDataManager.parseCSVLine(line);
                const airport = {};
                
                headers.forEach((header, index) => {
                    airport[header] = values[index] || '';
                });
                
                if (airport.latitude_deg && airport.longitude_deg && 
                    airport.icao_code && airport.icao_code.length === 4) {
                    airports.push({
                        icao: airport.icao_code,
                        name: airport.name,
                        lat: parseFloat(airport.latitude_deg),
                        lon: parseFloat(airport.longitude_deg),
                        elevation: parseFloat(airport.elevation_ft) || 0,
                        type: airport.type,
                        municipality: airport.municipality,
                        iso_country: airport.iso_country
                    });
                }
            }
            
            return airports;
        },
        
        /**
         * Parses the OurAirports `navaids.csv`, keeping records with a position
         * and an identifier.
         * @param {string} csvText Raw CSV.
         * @returns {Array<Navaid>} Parsed navaids.
         */
        parseNavaids(csvText) {
            const lines = csvText.split('\n');
            const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
            const navaids = [];
            
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const values = CSVDataManager.parseCSVLine(line);
                const navaid = {};
                
                headers.forEach((header, index) => {
                    navaid[header] = values[index] || '';
                });
                
                if (navaid.latitude_deg && navaid.longitude_deg && navaid.ident) {
                    navaids.push({
                        ident: navaid.ident,
                        name: navaid.name,
                        type: navaid.type,
                        lat: parseFloat(navaid.latitude_deg),
                        lon: parseFloat(navaid.longitude_deg),
                        elevation: parseFloat(navaid.elevation_ft) || 0,
                        frequency: parseFloat(navaid.frequency_khz) || 0,
                        associated_airport: navaid.associated_airport
                    });
                }
            }
            
            return navaids;
        },
        
        /**
         * Parses the OurAirports `runways.csv`. Both thresholds must be
         * georeferenced, and runways shorter than `state.minRunwayLength` are
         * dropped so the scope is not littered with grass strips.
         * @param {string} csvText Raw CSV.
         * @returns {Array<Runway>} Runways long enough to draw.
         */
        parseRunways(csvText) {
            const lines = csvText.split('\n');
            const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
            const runways = [];
            
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const values = CSVDataManager.parseCSVLine(line);
                const runway = {};
                
                headers.forEach((header, index) => {
                    runway[header] = values[index] || '';
                });
                
                if (runway.le_latitude_deg && runway.le_longitude_deg && 
                    runway.he_latitude_deg && runway.he_longitude_deg) {
                    const length = parseFloat(runway.length_ft) || 0;
                    
                    if (length >= state.minRunwayLength) {
                        runways.push({
                            airport_ident: runway.airport_ident,
                            id: `${runway.le_ident}/${runway.he_ident}`,
                            length: length,
                            width: parseFloat(runway.width_ft) || 0,
                            surface: runway.surface,
                            lighted: runway.lighted === '1',
                            closed: runway.closed === '1',
                            lat1: parseFloat(runway.le_latitude_deg),
                            lon1: parseFloat(runway.le_longitude_deg),
                            lat2: parseFloat(runway.he_latitude_deg),
                            lon2: parseFloat(runway.he_longitude_deg),
                            le_heading: parseFloat(runway.le_heading_degT) || 0,
                            he_heading: parseFloat(runway.he_heading_degT) || 0
                        });
                    }
                }
            }
            
            return runways;
        },
        
        /**
         * Splits a single CSV line, honouring double-quoted fields that contain
         * commas. Surrounding quotes are stripped from each value.
         * @param {string} line One raw CSV record.
         * @returns {Array<string>} Trimmed, unquoted field values.
         */
        parseCSVLine(line) {
            const values = [];
            let current = '';
            let inQuotes = false;
            
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === ',' && !inQuotes) {
                    values.push(current.trim().replace(/"/g, ''));
                    current = '';
                } else {
                    current += char;
                }
            }
            
            values.push(current.trim().replace(/"/g, ''));
            return values;
        },
        
        /**
         * Airports within a radius of a point, **nearest first**, capped at
         * {@link CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY} so a dense area
         * cannot flood the static layer. Sorting before the cap is what makes
         * the cap mean "the closest N" rather than "whichever N the CSV lists
         * first".
         * @param {number} lat Centre latitude.
         * @param {number} lon Centre longitude.
         * @param {number} rangeNm Radius in nautical miles.
         * @returns {Array<Airport>} Airports in range.
         */
        getAirportsInRange(lat, lon, rangeNm) {
            return state.airports
                .map(airport => ({
                    airport,
                    dist: MathUtils.haversineDistance(lat, lon, airport.lat, airport.lon)
                }))
                .filter(entry => entry.dist <= rangeNm)
                .sort((a, b) => a.dist - b.dist)
                .slice(0, CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY)
                .map(entry => entry.airport);
        },
        
        /**
         * Navaids within a radius of a point, nearest first, capped at
         * {@link CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY}.
         * @param {number} lat Centre latitude.
         * @param {number} lon Centre longitude.
         * @param {number} rangeNm Radius in nautical miles.
         * @returns {Array<Navaid>} Navaids in range.
         */
        getNavaidsInRange(lat, lon, rangeNm) {
            return state.navaids
                .map(navaid => ({
                    navaid,
                    dist: MathUtils.haversineDistance(lat, lon, navaid.lat, navaid.lon)
                }))
                .filter(entry => entry.dist <= rangeNm)
                .sort((a, b) => a.dist - b.dist)
                .slice(0, CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY)
                .map(entry => entry.navaid);
        },
        
        /**
         * All runways belonging to one airport.
         * @param {string} icao ICAO identifier.
         * @returns {Array<Runway>} Matching runways (possibly empty).
         */
        getRunwaysForAirport(icao) {
            return state.runways.filter(runway => runway.airport_ident === icao);
        }
    };

    /**
     * De-duplicates concurrent HTTP requests and enforces a hard timeout on
     * each one.
     * @class
     */
    class NetworkRequestPool {
        /**
         * @param {void}
         */
        constructor() {
            this.activeRequests = new Map();
            this.requestQueue = [];
            this.maxConcurrent = 5;
            this.inFlight = 0;
        }

        /**
         * Fetches a URL, sharing the in-flight promise when the same URL is
         * already being requested. Prevents a slow feed from stacking up
         * duplicate requests each polling tick.
         *
         * The bookkeeping `.finally()` is followed by a `.catch()`: it returns a
         * *derived* promise, and without that catch a failed request would
         * surface as an `unhandledrejection` and raise a spurious error banner.
         * @param {string} url Resource to fetch.
         * @param {RequestInit} [options={}] Extra fetch options.
         * @returns {Promise<Response>}
         */
        async fetch(url, options = {}) {
            // Check if similar request is already in progress
            if (CONFIG.PERFORMANCE.REQUEST_POOLING && this.activeRequests.has(url)) {
                return this.activeRequests.get(url);
            }

            const requestPromise = CONFIG.PERFORMANCE.BATCH_NETWORK_REQUESTS
                ? this.enqueue(url, options)
                : this.executeRequest(url, options);
            
            if (CONFIG.PERFORMANCE.REQUEST_POOLING) {
                this.activeRequests.set(url, requestPromise);
                // .finally() returns a *derived* promise; without this catch its
                // rejection is unhandled and reaches window.onunhandledrejection.
                requestPromise
                    .finally(() => { this.activeRequests.delete(url); })
                    .catch(() => {});
            }

            return requestPromise;
        }

        /**
         * Queues a request behind {@link NetworkRequestPool#maxConcurrent}
         * in-flight ones.
         *
         * Startup fires the three reference CSVs and every aircraft feed at
         * once; without a ceiling those compete with each other and with the
         * first frames of the render loop.
         * @param {string} url Resource to fetch.
         * @param {RequestInit} options Extra fetch options.
         * @returns {Promise<Response>} Settles once the request has run.
         */
        enqueue(url, options) {
            return new Promise((resolve, reject) => {
                this.requestQueue.push({ url, options, resolve, reject });
                this.drainQueue();
            });
        }

        /**
         * Starts queued requests while there is capacity, and re-drains as each
         * one settles.
         * @returns {void}
         */
        drainQueue() {
            while (this.inFlight < this.maxConcurrent && this.requestQueue.length > 0) {
                const job = this.requestQueue.shift();
                this.inFlight++;
                this.executeRequest(job.url, job.options)
                    .then(job.resolve, job.reject)
                    .finally(() => {
                        this.inFlight--;
                        this.drainQueue();
                    });
            }
        }

        /**
         * Performs the actual fetch with an {@link AbortController} that fires
         * after {@link CONFIG.FETCH_TIMEOUT_MS}, so a hung feed cannot stall the
         * polling cycle. Caching is disabled to keep positions live.
         * @param {string} url Resource to fetch.
         * @param {RequestInit} options Extra fetch options.
         * @returns {Promise<Response>}
         * @throws {Error} On network failure or timeout abort.
         */
        async executeRequest(url, options) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);

            try {
                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                    cache: 'no-cache'
                });
                clearTimeout(timeoutId);
                return response;
            } catch (error) {
                clearTimeout(timeoutId);
                throw error;
            }
        }
    }

    /** Shared request pool used by every outbound fetch. @type {NetworkRequestPool} */
    const networkPool = new NetworkRequestPool();


    /**
     * Tracks the home position from a `POSITION` file, so the scope can be
     * centred on a receiver that moves — a ship, a vehicle, an aircraft.
     *
     * A browser cannot watch the filesystem, so the file is polled over HTTP
     * with a conditional request. While the file is unchanged the server
     * answers `304 Not Modified` and nothing is re-parsed or re-rendered; when
     * it changes, the new fix is applied and the scope re-projects.
     *
     * Re-projection is gated on {@link CONFIG.POSITION_FILE.MIN_MOVE_NM}: GPS
     * noise on a moored vessel would otherwise rebuild the static layer several
     * times a second for movement of a few metres.
     *
     * Nothing else in the application needs to change as the receiver moves.
     * Aircraft positions, trails and the airport/navaid/runway layers are all
     * stored geographically and projected relative to `state.homeLat/homeLon`,
     * so moving the origin re-projects all of them correctly.
     * @namespace PositionManager
     */
    const PositionManager = {
        /** Handle of the polling interval, if running. @type {?number} */
        intervalId: null,
        /** `Last-Modified` of the last body actually parsed. @type {?string} */
        lastModified: null,
        /** `ETag` of the last body actually parsed. @type {?string} */
        etag: null,
        /** Raw text of the last body parsed, to skip identical re-reads. @type {?string} */
        lastBody: null,
        /** Consecutive read or parse failures. @type {number} */
        consecutiveFailures: 0,

        /**
         * Starts polling if the feature is enabled, replacing any existing
         * poller. Safe to call whenever the settings change.
         * @returns {void}
         */
        start() {
            this.stop();

            if (!state.positionFileEnabled) {
                this.setStatus('disabled', 'Disabled — using the configured home position.');
                return;
            }

            this.setStatus('waiting', `Waiting for ${state.positionFilePath}…`);
            this.poll();

            const interval = setInterval(() => this.poll(), state.positionPollIntervalMs);
            state.intervals.push(interval);
            this.intervalId = interval;
        },

        /**
         * Stops polling and forgets the cache validators, so a restart re-reads
         * the file from scratch.
         * @returns {void}
         */
        stop() {
            if (this.intervalId) {
                clearInterval(this.intervalId);
                const i = state.intervals.indexOf(this.intervalId);
                if (i !== -1) state.intervals.splice(i, 1);
                this.intervalId = null;
            }
            this.lastModified = null;
            this.etag = null;
            this.lastBody = null;
        },

        /**
         * Reads the file once and applies any new fix.
         *
         * Sends `If-Modified-Since`/`If-None-Match` so an unchanged file costs
         * a 304 rather than a re-parse. Servers that ignore those still work:
         * the body is compared against the last one read.
         * @returns {Promise<void>}
         */
        async poll() {
            if (!state.positionFileEnabled) return;

            try {
                const headers = {};
                if (this.lastModified) headers['If-Modified-Since'] = this.lastModified;
                if (this.etag) headers['If-None-Match'] = this.etag;

                const response = await fetch(state.positionFilePath, {
                    headers,
                    cache: 'no-cache'
                });

                if (response.status === 304) {
                    this.consecutiveFailures = 0;
                    return;
                }
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const body = await response.text();

                // Some servers ignore conditional requests; comparing bodies
                // keeps an unchanged file from re-rendering the scope.
                if (body === this.lastBody) {
                    this.consecutiveFailures = 0;
                    return;
                }

                const fix = this.parse(body);
                if (!fix) {
                    throw new Error('No position found in file');
                }

                this.lastBody = body;
                this.lastModified = response.headers?.get?.('Last-Modified') || null;
                this.etag = response.headers?.get?.('ETag') || null;
                this.consecutiveFailures = 0;

                this.applyFix(fix);
            } catch (error) {
                this.consecutiveFailures++;
                this.setStatus('error',
                    `${state.positionFilePath}: ${error.message} ` +
                    `(${this.consecutiveFailures} consecutive)`);

                // One warning per outage, not one per poll.
                if (this.consecutiveFailures === 3) {
                    ErrorBoundary.showWarning(
                        `POSITION file "${state.positionFilePath}" unreadable: ${error.message}`);
                }
            }
        },

        /**
         * Moves the scope to a new fix.
         *
         * The home position is always updated so the status bar stays truthful,
         * but the scope is only re-projected once the receiver has moved past
         * {@link CONFIG.POSITION_FILE.MIN_MOVE_NM} — below that the movement is
         * indistinguishable from GPS noise and rebuilding the static layer would
         * be wasted work.
         * @param {OwnPositionFix} fix Parsed fix.
         * @returns {void}
         */
        applyFix(fix) {
            const moved = MathUtils.haversineDistance(
                state.homeLat, state.homeLon, fix.lat, fix.lon);

            state.homeLat = fix.lat;
            state.homeLon = fix.lon;
            state.ownHeading = typeof fix.heading === 'number' ? fix.heading : null;
            state.ownSpeed = typeof fix.speed === 'number' ? fix.speed : null;
            state.ownPositionUpdatedAt = Date.now();
            state.ownPositionFormat = fix.format;

            const speedText = state.ownSpeed !== null ? `, ${state.ownSpeed.toFixed(1)} kt` : '';
            const headingText = state.ownHeading !== null ? `, ${Math.round(state.ownHeading)}°` : '';
            this.setStatus('ok',
                `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}${headingText}${speedText} ` +
                `(${fix.format})`);

            if (moved >= state.positionMinMoveNm) {
                // Distances are memoised against the old origin, and the static
                // layer was rasterised for it; both must go.
                MathUtils._cache.clear();
                state.staticEpoch++;
                Renderer.markForRedraw();
                UIManager.updateScopeStatus();
            }
        },

        /**
         * Parses a POSITION file.
         *
         * Four shapes are accepted, tried in order, so the file can be whatever
         * the position source already emits:
         *
         * 1. **NMEA 0183** — `$GPGGA` / `$GPRMC` (any talker ID), including
         *    course and speed over ground from RMC. The last valid sentence in
         *    the file wins, so appending to a log works.
         * 2. **JSON** — `{"lat": .., "lon": .., "heading": .., "speed": ..}`,
         *    also accepting `latitude`/`longitude`/`cog`/`sog`.
         * 3. **`KEY=VALUE` lines** — `LAT=`, `LON=`, `HEADING=`, `SPEED=`.
         * 4. **Bare pair** — `-23.9608, -46.3336` or whitespace-separated.
         *
         * Blank lines and `#` comments are ignored throughout.
         * @param {string} text Raw file contents.
         * @returns {?OwnPositionFix} The fix, or `null` if nothing parsed.
         */
        parse(text) {
            if (!text) return null;

            const cleaned = text
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'))
                .join('\n');

            if (!cleaned) return null;

            // NMEA is claimed exclusively. Otherwise a sentence this parser
            // rejects — a GGA with no fix, an RMC carrying a navigation
            // warning — would fall through to parseBarePair, which would read
            // the timestamp and a coordinate field as a lat/lon pair and send
            // the scope somewhere fictional.
            const fix = cleaned.startsWith('$')
                ? this.parseNMEA(cleaned)
                : (this.parseJSON(cleaned)
                    || this.parseKeyValue(cleaned)
                    || this.parseBarePair(cleaned));

            return this.validate(fix);
        },

        /**
         * Rejects a fix whose coordinates are not on Earth.
         *
         * A truncated or half-written file can parse into plausible-looking
         * numbers, so this is the last gate before the scope is moved.
         * @param {?OwnPositionFix} fix Candidate fix.
         * @returns {?OwnPositionFix} The fix, or `null` if out of range.
         */
        validate(fix) {
            if (!fix) return null;
            if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return null;
            if (Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return null;

            if (typeof fix.heading === 'number') {
                fix.heading = ((fix.heading % 360) + 360) % 360;
            }
            if (typeof fix.speed === 'number' && fix.speed < 0) {
                fix.speed = null;
            }
            return fix;
        },

        /**
         * Parses the last valid GGA or RMC sentence in the text.
         * @param {string} text Cleaned file contents.
         * @returns {?OwnPositionFix}
         */
        parseNMEA(text) {
            const sentences = text.split('\n').filter(l => l.startsWith('$'));
            if (sentences.length === 0) return null;

            for (let i = sentences.length - 1; i >= 0; i--) {
                const parts = sentences[i].split('*')[0].split(',');
                const type = parts[0].slice(3);   // drop the talker ID

                if (type === 'GGA') {
                    // $--GGA,time,lat,N/S,lon,E/W,quality,...
                    if (parts[6] === '0') continue;      // fix quality 0 = no fix
                    const lat = this.parseNMEACoord(parts[2], parts[3]);
                    const lon = this.parseNMEACoord(parts[4], parts[5]);
                    if (lat === null || lon === null) continue;
                    return { lat, lon, heading: null, speed: null, format: 'NMEA GGA' };
                }

                if (type === 'RMC') {
                    // $--RMC,time,status,lat,N/S,lon,E/W,sog,cog,...
                    if (parts[2] !== 'A') continue;      // V = navigation warning
                    const lat = this.parseNMEACoord(parts[3], parts[4]);
                    const lon = this.parseNMEACoord(parts[5], parts[6]);
                    if (lat === null || lon === null) continue;
                    const speed = parseFloat(parts[7]);
                    const heading = parseFloat(parts[8]);
                    return {
                        lat, lon,
                        heading: Number.isFinite(heading) ? heading : null,
                        speed: Number.isFinite(speed) ? speed : null,
                        format: 'NMEA RMC'
                    };
                }
            }

            return null;
        },

        /**
         * Converts an NMEA `ddmm.mmmm` / `dddmm.mmmm` field plus its hemisphere
         * into decimal degrees.
         * @param {string} value Coordinate field.
         * @param {string} hemisphere `N`, `S`, `E` or `W`.
         * @returns {?number} Decimal degrees, or `null` if unparseable.
         */
        parseNMEACoord(value, hemisphere) {
            if (!value || !hemisphere) return null;

            const dot = value.indexOf('.');
            if (dot < 3) return null;

            const degrees = parseInt(value.slice(0, dot - 2), 10);
            const minutes = parseFloat(value.slice(dot - 2));
            if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;

            const decimal = degrees + minutes / 60;
            const sign = (hemisphere === 'S' || hemisphere === 'W') ? -1 : 1;
            return decimal * sign;
        },

        /**
         * Parses a JSON object holding a position.
         * @param {string} text Cleaned file contents.
         * @returns {?OwnPositionFix}
         */
        parseJSON(text) {
            if (!text.startsWith('{') && !text.startsWith('[')) return null;

            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                return null;
            }

            const o = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
            if (!o || typeof o !== 'object') return null;

            const lat = this.firstNumber(o.lat, o.latitude, o.Lat, o.Latitude);
            const lon = this.firstNumber(o.lon, o.lng, o.longitude, o.Lon, o.Longitude);
            if (lat === null || lon === null) return null;

            return {
                lat, lon,
                heading: this.firstNumber(o.heading, o.cog, o.course, o.track),
                speed: this.firstNumber(o.speed, o.sog, o.speedKnots),
                format: 'JSON'
            };
        },

        /**
         * Parses `KEY=VALUE` lines.
         * @param {string} text Cleaned file contents.
         * @returns {?OwnPositionFix}
         */
        parseKeyValue(text) {
            if (!text.includes('=')) return null;

            const values = {};
            for (const line of text.split('\n')) {
                const eq = line.indexOf('=');
                if (eq === -1) continue;
                values[line.slice(0, eq).trim().toUpperCase()] =
                    parseFloat(line.slice(eq + 1).trim());
            }

            const lat = this.firstNumber(values.LAT, values.LATITUDE);
            const lon = this.firstNumber(values.LON, values.LNG, values.LONGITUDE);
            if (lat === null || lon === null) return null;

            return {
                lat, lon,
                heading: this.firstNumber(values.HEADING, values.COG, values.COURSE),
                speed: this.firstNumber(values.SPEED, values.SOG),
                format: 'KEY=VALUE'
            };
        },

        /**
         * Parses a bare `lat, lon` pair, optionally followed by heading and
         * speed.
         * @param {string} text Cleaned file contents.
         * @returns {?OwnPositionFix}
         */
        parseBarePair(text) {
            const firstLine = text.split('\n')[0];
            const numbers = firstLine.split(/[\s,;]+/)
                .map(v => parseFloat(v))
                .filter(v => Number.isFinite(v));

            if (numbers.length < 2) return null;

            return {
                lat: numbers[0],
                lon: numbers[1],
                heading: numbers.length > 2 ? numbers[2] : null,
                speed: numbers.length > 3 ? numbers[3] : null,
                format: 'lat/lon pair'
            };
        },

        /**
         * First argument that is a finite number, with latitude and longitude
         * range-checked by the caller.
         * @param {...*} values Candidates, in priority order.
         * @returns {?number}
         */
        firstNumber(...values) {
            for (const v of values) {
                const n = typeof v === 'string' ? parseFloat(v) : v;
                if (typeof n === 'number' && Number.isFinite(n)) return n;
            }
            return null;
        },

        /**
         * Records the current tracking state and mirrors it into the settings
         * panel when that is open.
         * @param {('disabled'|'waiting'|'ok'|'error')} kind Status class.
         * @param {string} message Human-readable detail.
         * @returns {void}
         */
        setStatus(kind, message) {
            state.positionFileStatus = { kind, message, at: Date.now() };

            const el = document.getElementById('position-file-status');
            if (el) {
                el.textContent = message;
                el.style.color = kind === 'error'
                    ? '#BF616A'
                    : (kind === 'ok' ? '#A3BE8C' : 'var(--color-text-muted)');
            }
        },

        /**
         * Whether the last fix is old enough to be untrustworthy.
         * @returns {boolean} True when tracking is on but the fix has gone stale.
         */
        isStale() {
            if (!state.positionFileEnabled || !state.ownPositionUpdatedAt) return false;
            return (Date.now() - state.ownPositionUpdatedAt) > CONFIG.POSITION_FILE.STALE_AFTER_MS;
        }
    };

    /**
     * Fetching, merging and validating aircraft feeds. Handles multiple
     * simultaneous sources, retry with backoff, and classification of each
     * target (mlat vs ADS-B, military vs civilian).
     * @namespace DataManager
     */
    const DataManager = {
        /**
         * Polls every enabled data source in parallel and merges the results.
         *
         * Partial failure is tolerated: as long as one source answers, the
         * scope keeps updating and the status bar reads
         * `Partial (n failed)`. Each result is paired with its own source
         * before filtering, so a warning always names the feed that actually
         * failed, and each outage is reported once rather than once per poll.
         * @returns {Promise<void>}
         */
        async fetchData() {
            try {
                const enabledSources = state.dataSources.filter(source => source.enabled);
                if (enabledSources.length === 0) {
                    throw new Error('No enabled data sources');
                }
                
                const fetchPromises = enabledSources.map(source => this.fetchFromSource(source));
                const results = await Promise.allSettled(fetchPromises);
                
                // Pair each result with its own source before filtering, so the
                // two lists cannot drift apart.
                const settled = results.map((r, i) => ({ ...r, source: enabledSources[i] }));

                const successfulData = settled
                    .filter(r => r.status === 'fulfilled' && r.value && typeof r.value === 'object')
                    .map(r => r.value);
                
                const failedSources = settled
                    .filter(r => r.status === 'rejected' || !r.value || typeof r.value !== 'object')
                    .map(r => ({ source: r.source, error: r.reason || new Error('Empty response') }));
                
                if (successfulData.length > 0) {
                    const mergedData = this.mergeAircraftData(successfulData);
                    this.processAircraftData(mergedData);
                    state.connectionStatus = failedSources.length > 0 ? 
                        `Partial (${failedSources.length} failed)` : "OK";
                    state.lastDataUpdate = Date.now();
                } else {
                    state.connectionStatus = "Error - All sources failed";
                }

                // Warn once per source per outage rather than once per poll.
                failedSources.forEach(failed => {
                    const key = failed.source.url;
                    if (!state.reportedSourceFailures.has(key)) {
                        state.reportedSourceFailures.add(key);
                        ErrorBoundary.showWarning(`Data source "${failed.source.name}" failed: ${failed.error.message}`);
                    }
                });
                successfulData.forEach(d => {
                    const src = enabledSources.find(e => e.name === d.source);
                    if (src) state.reportedSourceFailures.delete(src.url);
                });
            } catch (error) {
                ErrorBoundary.handleError(error, 'Data Fetch');
                state.connectionStatus = "Error";
            }
        },
        
        /**
         * Fetches one source, retrying up to {@link CONFIG.MAX_RETRY_ATTEMPTS}
         * times with exponential backoff from
         * {@link CONFIG.INITIAL_RETRY_DELAY_MS}.
         *
         * The retry budget is per call, not per session: `state.retryAttempts`
         * records how many attempts the last poll needed, but a source that
         * recovers is retried normally on the next poll rather than being
         * written off for the life of the page.
         * @param {{url: string, name: string, enabled: boolean}} source Feed to read.
         * @returns {Promise<Object>} Payload tagged with the source name.
         * @throws {Error} If the URL is invalid or every attempt fails.
         */
        async fetchFromSource(source) {
            if (!URLValidator.isValidDataSourceUrl(source.url)) {
                throw new Error(`Invalid URL: ${source.url}`);
            }
            
            const retryKey = source.url;
            let attempts = 0;
            let lastError = new Error(`No attempt was made for ${source.name}`);

            while (attempts < CONFIG.MAX_RETRY_ATTEMPTS) {
                try {
                    const response = await networkPool.fetch(source.url);

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    
                    const data = await response.json();
                    state.retryAttempts[retryKey] = 0;
                    return { ...data, source: source.name };
                } catch (error) {
                    attempts++;
                    lastError = error;
                    state.retryAttempts[retryKey] = attempts;
                    
                    if (attempts < CONFIG.MAX_RETRY_ATTEMPTS) {
                        const delay = CONFIG.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts - 1);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            // The budget is per call, so a source that comes back later recovers
            // on its next poll instead of being written off for the whole session.
            console.error(`Failed to fetch from ${source.name} after ${attempts} attempts:`, lastError);
            throw lastError;
        },
        
        /**
         * Merges payloads from several feeds, keeping the first sighting of each
         * hex and tagging it with the source it came from.
         * @param {Array<Object>} dataArrays One payload per successful source.
         * @returns {{aircraft: Array<AircraftMessage>, messages: number}} Merged set.
         */
        mergeAircraftData(dataArrays) {
            const merged = { aircraft: [], messages: 0 };
            const seenHexes = new Set();
            
            for (const data of dataArrays) {
                if (!data || typeof data !== 'object') continue;
                merged.messages += data.messages || 0;
                for (const ac of (data.aircraft || [])) {
                    if (!seenHexes.has(ac.hex)) {
                        seenHexes.add(ac.hex);
                        merged.aircraft.push({ ...ac, dataSource: data.source });
                    }
                }
            }
            
            return merged;
        },
        
        /**
         * Validates and indexes a feed payload into `state.aircraftData`, keyed by
         * uppercased hex, updating session statistics and raising emergency alerts
         * for squawks listed in {@link CONFIG.EMERGENCY_SQUAWKS}.
         *
         * Invalid messages are filtered up front so the render loop never has to
         * defend against them.
         * @param {{aircraft: Array<AircraftMessage>, messages: number}} data
         *   Merged feed payload.
         * @returns {void}
         */
        processAircraftData(data) {
            const newData = {};
            const aircraft = data.aircraft || [];
            
            // Pre-filter invalid aircraft for better performance
            const validAircraft = aircraft.filter(ac => this.isValidAircraft(ac));
            
            for (const ac of validAircraft) {
                const hex = ac.hex.trim().toUpperCase();
                newData[hex] = ac;
                state.sessionStats.uniqueAircraft.add(hex);
                
                this.updateStatistics(ac);
                
                if (CONFIG.EMERGENCY_SQUAWKS.includes(ac.squawk)) {
                    // Both are de-duplicated per aircraft: one banner and one
                    // tone per emergency, not one per poll.
                    if (UIManager.createEmergencyAlert(ac)) {
                        SoundManager.playEmergencyAlert();
                    }
                }
            }
            
            state.aircraftData = newData;
            state.sessionStats.messagesReceived = data.messages || state.sessionStats.messagesReceived;
        },
        
        /**
         * Increments the mlat/ADS-B/other counters for one message.
         * @param {AircraftMessage} aircraft Decoded message.
         * @returns {void}
         */
        updateStatistics(aircraft) {
            if (aircraft.mlat && aircraft.mlat.length > 0) {
                state.sessionStats.sourceDistribution.mlat++;
            } else if (aircraft.adsb_version !== undefined) {
                state.sessionStats.sourceDistribution.adsb++;
            } else {
                state.sessionStats.sourceDistribution.other++;
            }
        },
        
        /**
         * Rejects messages that cannot be plotted: missing hex or position,
         * NaN coordinates, or latitude/longitude out of range.
         * @param {AircraftMessage} aircraft Candidate message.
         * @returns {boolean} True if the message is plottable.
         */
        isValidAircraft(aircraft) {
            return aircraft && 
                   'lat' in aircraft && 
                   'lon' in aircraft && 
                   aircraft.hex && 
                   aircraft.hex.trim() &&
                   !isNaN(aircraft.lat) &&
                   !isNaN(aircraft.lon) &&
                   Math.abs(aircraft.lat) <= 90 &&
                   Math.abs(aircraft.lon) <= 180;
        },
        
        /**
         * Heuristic military check based on the ICAO address falling in the
         * `ADF7C0`–`ADFFFF` or `AE0000`–`AE7FFF` blocks (US military allocations).
         * @param {string} hex ICAO 24-bit address in hex.
         * @returns {boolean} True if the address is in a military block.
         */
        isMilitary(hex) {
            const icao = parseInt(hex, 16);
            return (icao >= 0xADF7C0 && icao <= 0xADFFFF) || 
                   (icao >= 0xAE0000 && icao <= 0xAE7FFF);
        },
        
        /**
         * Single-letter provenance badge for the aircraft table.
         * @param {AircraftMessage} aircraft Decoded message.
         * @returns {("M"|"A"|"O")} `M` mlat, `A` ADS-B, `O` other.
         */
        getDataSourceIndicator(aircraft) {
            if (aircraft.mlat && aircraft.mlat.length > 0) return 'M';
            if (aircraft.adsb_version !== undefined) return 'A';
            return 'O';
        }
    };

    /**
     * Draws the dynamic layer of the scope: sweep, aircraft symbols, trails,
     * speed vectors, data-block labels and the debug overlay. The static layer
     * is delegated to {@link CanvasRenderer}.
     * @namespace Renderer
     * @property {boolean} needsRedraw Set when the static layer must be rebuilt.
     */
    const Renderer = {
        lastRenderData: null,
        needsRedraw: true,
        lastFrameTime: 0,
        
        /**
         * Invalidates the current frame, forcing a repaint even while paused.
         * @returns {void}
         */
        markForRedraw() {
            this.needsRedraw = true;
        },
        
        /**
         * Paints the static layer — background, airports, navaids, runways, range
         * rings and compass ticks — preferring the cached bitmap when one is valid.
         *
         * With dirty-region tracking on, only the rectangles the previous frame
         * painted over are restored, which erases the moving layer without
         * blitting the whole scope face. A rebuilt cache always lands in full.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawScope(cx, cy, radius) {
            if (!canvasRenderer) return;

            const cacheWasStale = this.needsRedraw;
            const staticCache = canvasRenderer.cacheStaticElements(cx, cy, radius);

            if (!staticCache || !CONFIG.PERFORMANCE.CACHE_STATIC_ELEMENTS) {
                canvasRenderer.drawStaticScope(elements.ctx, cx, cy, radius);
                canvasRenderer.clearDirtyRegions();
                return;
            }

            // Restoring only the rectangles painted last frame erases the moving
            // layer without repainting the whole scope face. A rebuilt cache has
            // to land in full.
            const regions = cacheWasStale ? null : canvasRenderer.collectDirtyRegions();

            if (regions) {
                for (const r of regions) {
                    elements.ctx.putImageData(staticCache, 0, 0, r.x, r.y, r.width, r.height);
                }
            } else {
                elements.ctx.putImageData(staticCache, 0, 0);
            }

            canvasRenderer.clearDirtyRegions();
        },
        
        /**
         * Draws the rotating sweep as ten trailing lines of decreasing opacity,
         * which reads as a comet tail behind the leading edge.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawSweep(cx, cy, radius) {
            const ctx = elements.ctx;
            const sweepColor = ThemeManager.getScopeThemeColor('sweep');

            // Bounding box of the whole trailing fan, so the next frame knows
            // what to erase.
            if (canvasRenderer) {
                let minX = cx, maxX = cx, minY = cy, maxY = cy;
                for (let i = 0; i < 10; i++) {
                    const a = MathUtils.toRad(state.sweepAngle - i * 0.2);
                    const ex = cx + radius * Math.cos(a);
                    const ey = cy + radius * Math.sin(a);
                    minX = Math.min(minX, ex); maxX = Math.max(maxX, ex);
                    minY = Math.min(minY, ey); maxY = Math.max(maxY, ey);
                }
                canvasRenderer.markDirty(minX, minY, maxX - minX, maxY - minY);
            }

            for (let i = 0; i < 10; i++) {
                const angleOffset = state.sweepAngle - i * 0.2;
                const lineAngleRad = MathUtils.toRad(angleOffset);
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(cx + radius * Math.cos(lineAngleRad), cy + radius * Math.sin(lineAngleRad));
                ctx.strokeStyle = sweepColor;
                ctx.globalAlpha = 0.4 - i * 0.04;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            ctx.globalAlpha = 1.0;
        },
        
        /**
         * Draws every tracked aircraft: trails, symbols and labels.
         *
         * Targets are first bucketed by category (emergency, selected, mlat, adsb,
         * other) so each colour is set once per category instead of once per
         * aircraft. Stale targets are dropped here, alpha is faded by time since
         * last update, and labels are placed with collision avoidance against the
         * labels already drawn this frame.
         * @param {number} canvasWidth Canvas width in pixels.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        drawAircraft(canvasWidth, cx, cy, radius) {
            const ctx = elements.ctx;
            const currentTime = Date.now() / 1000;
            
            // Batch aircraft by render properties for efficiency
            const aircraftByType = {
                emergency: [],
                selected: [],
                adsb: [],
                mlat: [],
                other: []
            };
            
            let processedCount = 0;
            const maxPerFrame = CONFIG.PERFORMANCE.MAX_PARTICLES_PER_FRAME || 1000;
            
            Object.keys(state.displayedAircraft).forEach(hex => {
                if (processedCount >= maxPerFrame) return;
                
                const ac = state.displayedAircraft[hex];
                const timeSinceUpdate = currentTime - ac.lastUpdateTime;
                
                if (timeSinceUpdate > CONFIG.SWEEP_DURATION_S * CONFIG.AIRCRAFT_TIMEOUT_FACTOR) {
                    delete state.displayedAircraft[hex];
                    return;
                }
                
                const isEmergency = CONFIG.EMERGENCY_SQUAWKS.includes(ac.data.squawk) && 
                                  (Math.floor(currentTime * 4) % 2);
                
                let category;
                if (isEmergency) {
                    category = 'emergency';
                } else if (hex === state.selectedHex) {
                    category = 'selected';
                } else if (ac.data.mlat && ac.data.mlat.length > 0) {
                    category = 'mlat';
                } else if (ac.data.adsb_version !== undefined) {
                    category = 'adsb';
                } else {
                    category = 'other';
                }
                
                ac.alpha = 1.0 - Math.min(1.0, timeSinceUpdate / CONFIG.SWEEP_DURATION_S) * 0.5;
                ac.category = category;
                aircraftByType[category].push(ac);
                processedCount++;
            });
            
            const drawnLabels = []; // For collision detection in this frame

            // Draw trails, aircraft, and labels for each category
            Object.entries(aircraftByType).forEach(([category, aircraft]) => {
                if (aircraft.length === 0) return;

                const color = ThemeManager.getScopeThemeColor(category);
                ctx.strokeStyle = ctx.fillStyle = color;

                // Draw all trails for this category if enabled
                if (state.showTrails) {
                    aircraft.forEach(ac => {
                        this.drawAircraftTrail(ac, cx, cy, radius, color);
                    });
                }
                
                // Draw all symbols for this category
                aircraft.forEach(ac => {
                    this.drawAircraftSymbol(ac, canvasWidth, color);
                });

                // Draw all labels for this category with collision detection
                aircraft.forEach(ac => {
                    const { x, y } = ac.displayPos;
                    this.drawAircraftLabels(ac, x, y, canvasWidth, color, drawnLabels);
                });
            });
            
            ctx.globalAlpha = 1.0;
            ctx.textAlign = 'center';
        },
        
        /**
         * Draws an aircraft trail, projecting its stored lat/lon history to screen
         * space for this frame.
         *
         * Each segment fades with age against `trailFadeTimeMinutes`, and segments
         * are trimmed back to leave a small gap around the symbol so the trail does
         * not obscure the target.
         *
         * Two things keep long trails affordable: the projection is memoised in
         * a {@link WeakMap} keyed by the aircraft entry, so it is only redone
         * when the trail or the projection actually changes, and at most
         * {@link CONFIG.TRAIL_GRADIENT_SEGMENTS} segments are stroked however
         * many points the trail holds.
         * @param {Object} ac Displayed aircraft entry.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @param {string} color Trail colour.
         * @returns {void}
         */
        /**
         * Draws the own-ship marker at the scope centre while the receiver is
         * being tracked from the POSITION file.
         *
         * A hull outline pointing along course over ground when the fix carries
         * one, otherwise a circled cross. It dims and turns the emergency colour
         * once the fix goes stale, so a dead GPS feed is visible on the scope
         * rather than only in the status bar.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @returns {void}
         */
        drawOwnShip(cx, cy) {
            if (!state.showOwnShip || !state.positionFileEnabled) return;

            const ctx = elements.ctx;
            const size = CONFIG.AIRCRAFT_SYMBOL_SIZE * 2.5;
            const stale = PositionManager.isStale();

            if (canvasRenderer) {
                const reach = size + 10;
                canvasRenderer.markDirty(cx - reach, cy - reach, reach * 2, reach * 2);
            }

            ctx.save();
            ctx.globalAlpha = stale ? 0.45 : 1;
            ctx.strokeStyle = ctx.fillStyle = stale
                ? ThemeManager.getScopeThemeColor('emergency')
                : ThemeManager.getScopeThemeColor('selected');
            ctx.lineWidth = 1.5;

            if (typeof state.ownHeading === 'number') {
                // Hull outline pointing along course over ground.
                const rad = MathUtils.toRad(state.ownHeading - 90);
                const cos = Math.cos(rad), sin = Math.sin(rad);
                const hull = [[size, 0], [-size * 0.6, size * 0.55],
                              [-size * 0.35, 0], [-size * 0.6, -size * 0.55]];

                ctx.beginPath();
                hull.forEach(([hx, hy], i) => {
                    const px = cx + hx * cos - hy * sin;
                    const py = cy + hx * sin + hy * cos;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                });
                ctx.closePath();
                ctx.stroke();
            } else {
                // No course available: a plain circled cross marks the origin.
                ctx.beginPath();
                ctx.arc(cx, cy, size * 0.7, 0, 2 * Math.PI);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(cx - size, cy);
                ctx.lineTo(cx + size, cy);
                ctx.moveTo(cx, cy - size);
                ctx.lineTo(cx, cy + size);
                ctx.stroke();
            }

            ctx.restore();
        },

        drawAircraftTrail(ac, cx, cy, radius, color) {
            const ctx = elements.ctx;
            const currentTime = Date.now();
            const fadeTimeMs = state.trailFadeTimeMinutes * 60 * 1000;
            
            if (!ac.geoTrail || ac.geoTrail.length < 2) return;
            
            // Convert geographic trail to screen coordinates on-demand, reusing
            // the last projection while nothing that affects it has changed. The
            // cache hangs off a WeakMap keyed by the aircraft entry, so it is
            // reclaimed with the aircraft rather than needing explicit eviction.
            const projectionKey = `${state.maxRangeNm}|${cx}|${cy}|${radius}|` +
                                  `${state.homeLat}|${state.homeLon}|${ac.geoTrail.length}`;
            let screenTrail = null;

            if (CONFIG.PERFORMANCE.WEAK_REFERENCE_CLEANUP) {
                const cached = aircraftReferences.get(ac);
                if (cached && cached.projectionKey === projectionKey) {
                    screenTrail = cached.screenTrail;
                }
            }

            if (!screenTrail) {
                screenTrail = MathUtils.geoTrailToScreen(ac.geoTrail, state.maxRangeNm, cx, cy, radius);
                if (CONFIG.PERFORMANCE.WEAK_REFERENCE_CLEANUP) {
                    aircraftReferences.set(ac, { projectionKey, screenTrail });
                }
            }
            
            if (screenTrail.length < 2) return;

            // Cap the number of segments actually stroked. A 100-point trail
            // reads identically at 40 segments and costs less than half as much,
            // which is what makes long trails affordable in dense traffic.
            const maxSegments = CONFIG.TRAIL_GRADIENT_SEGMENTS > 0
                ? CONFIG.TRAIL_GRADIENT_SEGMENTS
                : screenTrail.length;
            const step = Math.max(1, Math.ceil((screenTrail.length - 1) / maxSegments));

            // Bounding box of the trail, so the next frame can erase it.
            if (canvasRenderer) {
                let tMinX = Infinity, tMinY = Infinity, tMaxX = -Infinity, tMaxY = -Infinity;
                for (const pt of screenTrail) {
                    if (pt.x < tMinX) tMinX = pt.x;
                    if (pt.x > tMaxX) tMaxX = pt.x;
                    if (pt.y < tMinY) tMinY = pt.y;
                    if (pt.y > tMaxY) tMaxY = pt.y;
                }
                const pad = state.trailWidth * 2;
                canvasRenderer.markDirty(tMinX - pad, tMinY - pad,
                                         (tMaxX - tMinX) + pad * 2, (tMaxY - tMinY) + pad * 2);
            }
            
            // Get current aircraft position
            const currentX = ac.displayPos.x;
            const currentY = ac.displayPos.y;
            const triangleSize = CONFIG.AIRCRAFT_SYMBOL_SIZE;
            const bufferDistance = triangleSize + 3; // Triangle size plus 3px space
            
            // Draw trail segments with time-based fading, avoiding the area around the aircraft
            for (let i = 0; i < screenTrail.length - 1; i += step) {
                const p1 = screenTrail[i];
                const p2 = screenTrail[Math.min(i + step, screenTrail.length - 1)];
                
                if (!p1 || !p2 || p1 === p2) continue;
                
                // Calculate distance from current aircraft position
                const dist1 = Math.hypot(p1.x - currentX, p1.y - currentY);
                const dist2 = Math.hypot(p2.x - currentX, p2.y - currentY);
                
                // Skip trail segments that are too close to current aircraft position
                if (dist1 < bufferDistance && dist2 < bufferDistance) {
                    continue;
                }
                
                // Calculate fade based on age
                const age = currentTime - (p2.timestamp || currentTime);
                const fadeRatio = Math.max(0, 1 - (age / fadeTimeMs));
                const segmentAlpha = ac.alpha * fadeRatio;
                
                if (segmentAlpha <= 0.01) continue;
                
                let startX = p1.x;
                let startY = p1.y;
                let endX = p2.x;
                let endY = p2.y;
                
                // If one point is close to aircraft, adjust the line to maintain buffer
                if (dist1 < bufferDistance) {
                    // Calculate direction from aircraft to p1
                    const dx = p1.x - currentX;
                    const dy = p1.y - currentY;
                    const length = Math.hypot(dx, dy);
                    if (length > 0) {
                        // Move start point to buffer distance
                        startX = currentX + (dx / length) * bufferDistance;
                        startY = currentY + (dy / length) * bufferDistance;
                    }
                }
                
                if (dist2 < bufferDistance) {
                    // Calculate direction from aircraft to p2
                    const dx = p2.x - currentX;
                    const dy = p2.y - currentY;
                    const length = Math.hypot(dx, dy);
                    if (length > 0) {
                        // Move end point to buffer distance
                        endX = currentX + (dx / length) * bufferDistance;
                        endY = currentY + (dy / length) * bufferDistance;
                    }
                }
                
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(endX, endY);
                ctx.strokeStyle = color;
                ctx.globalAlpha = segmentAlpha;
                ctx.lineWidth = state.trailWidth + fadeRatio * (state.trailWidth * 0.5);
                ctx.stroke();
            }
        },
        
        /**
         * Draws one aircraft symbol: a square for ground traffic, a
         * heading-oriented triangle when airborne, plus the speed vector when that
         * layer is enabled.
         * @param {Object} ac Displayed aircraft entry.
         * @param {number} canvasWidth Canvas width in pixels.
         * @param {string} color Category colour from the active scope theme.
         * @returns {void}
         */
        drawAircraftSymbol(ac, canvasWidth, color) {
            const ctx = elements.ctx;
            const { x, y } = ac.displayPos;
            
            const triangleColor = this.getHighContrastColor(color);

            if (canvasRenderer) {
                const reach = CONFIG.AIRCRAFT_SYMBOL_SIZE + CONFIG.HEADING_LINE_LENGTH + 4;
                canvasRenderer.markDirty(x - reach, y - reach, reach * 2, reach * 2);
            }
            
            ctx.globalAlpha = ac.alpha;
            ctx.lineWidth = 2.5;
            
            // Draw symbol based on altitude and heading
            if (ac.data.gnd) {
                // Ground aircraft - keep as rectangle with high contrast
                ctx.fillStyle = ctx.strokeStyle = triangleColor;
                ctx.beginPath();
                ctx.rect(x - CONFIG.AIRCRAFT_SYMBOL_SIZE, y - CONFIG.AIRCRAFT_SYMBOL_SIZE,
                        CONFIG.AIRCRAFT_SYMBOL_SIZE * 2, CONFIG.AIRCRAFT_SYMBOL_SIZE * 2);
                ctx.fill();
            } else {
                // Airborne aircraft - draw as triangle pointing in heading direction with high contrast
                ctx.fillStyle = ctx.strokeStyle = triangleColor;
                const heading = ac.data.track || ac.displayHeading || 0;
                this.drawHeadingTriangle(ctx, x, y, heading, CONFIG.AIRCRAFT_SYMBOL_SIZE);
                this.drawHeadingLine(ctx, x, y, heading);
            }
            
            // Draw speed vector if enabled (using original trail color)
            if (state.showVectors && ac.data.track && ac.data.gs && !ac.data.gnd) {
                ctx.fillStyle = ctx.strokeStyle = color; // Reset to original color for vector
                this.drawSpeedVector(ac, x, y);
            }
        },

        /**
         * Draws the short stub ahead of the nose showing where the aircraft is
         * pointing, {@link CONFIG.HEADING_LINE_LENGTH} pixels long.
         *
         * Unlike the speed vector this is a fixed length: it conveys attitude,
         * not distance covered, and stays readable at any range.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {number} x Symbol centre X.
         * @param {number} y Symbol centre Y.
         * @param {number} headingDegrees Heading in degrees true.
         * @returns {void}
         */
        drawHeadingLine(ctx, x, y, headingDegrees) {
            const length = CONFIG.HEADING_LINE_LENGTH;
            if (!(length > 0)) return;

            // Compass degrees to canvas radians: north is up, so rotate by -90.
            const rad = MathUtils.toRad(headingDegrees - 90);
            const start = CONFIG.AIRCRAFT_SYMBOL_SIZE + 1;

            ctx.beginPath();
            ctx.lineWidth = 1;
            ctx.moveTo(x + start * Math.cos(rad), y + start * Math.sin(rad));
            ctx.lineTo(x + (start + length) * Math.cos(rad), y + (start + length) * Math.sin(rad));
            ctx.stroke();
        },

        /**
         * Brightens a colour by +60 per RGB channel so aircraft symbols stay
         * legible against the trail drawn in the same base colour. Accepts `#rrggbb`
         * or `rgb(r, g, b)`; anything else is returned untouched.
         * @param {string} color Source colour.
         * @returns {string} An `rgb(...)` string, or the input if unparseable.
         */
        getHighContrastColor(color) {
            // Parse the color string to extract RGB values
            if (color.startsWith('#')) {
                // Handle hex colors
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                
                // Increase brightness by adding to each component
                const brightR = Math.min(255, r + 60);
                const brightG = Math.min(255, g + 60);
                const brightB = Math.min(255, b + 60);
                
                return `rgb(${brightR}, ${brightG}, ${brightB})`;
            } else if (color.startsWith('rgb')) {
                // Handle rgb colors
                const matches = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                if (matches) {
                    const r = parseInt(matches[1]);
                    const g = parseInt(matches[2]);
                    const b = parseInt(matches[3]);
                    
                    // Increase brightness
                    const brightR = Math.min(255, r + 60);
                    const brightG = Math.min(255, g + 60);
                    const brightB = Math.min(255, b + 60);
                    
                    return `rgb(${brightR}, ${brightG}, ${brightB})`;
                }
            }
            
            // Fallback: return original color if parsing fails
            return color;
        },

        /**
         * Draws a filled triangle pointing along the given heading. The triangle
         * is defined nose-up around the origin and rotated, so 0° points north.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {number} centerX Centre X.
         * @param {number} centerY Centre Y.
         * @param {number} headingDegrees Heading in degrees true.
         * @param {number} size Half-height of the symbol in pixels.
         * @returns {void}
         */
        drawHeadingTriangle(ctx, centerX, centerY, headingDegrees, size) {
            // Convert heading to radians and adjust for canvas coordinate system
            // (0° = North, but canvas 0° = East, so subtract 90°)
            const headingRad = MathUtils.toRad(headingDegrees);
            
            // Define triangle points relative to center (pointing "up" initially)
            // Front point (nose of aircraft)
            const frontX = 0;
            const frontY = -size;
            
            // Back left point
            const backLeftX = -size * 0.6;
            const backLeftY = size * 0.8;
            
            // Back right point  
            const backRightX = size * 0.6;
            const backRightY = size * 0.8;
            
            // Rotate points by heading angle
            const cos = Math.cos(headingRad);
            const sin = Math.sin(headingRad);
            
            // Rotated front point
            const frontXRot = frontX * cos - frontY * sin;
            const frontYRot = frontX * sin + frontY * cos;
            
            // Rotated back left point
            const backLeftXRot = backLeftX * cos - backLeftY * sin;
            const backLeftYRot = backLeftX * sin + backLeftY * cos;
            
            // Rotated back right point
            const backRightXRot = backRightX * cos - backRightY * sin;
            const backRightYRot = backRightX * sin + backRightY * cos;
            
            // Draw the triangle
            ctx.beginPath();
            ctx.moveTo(centerX + frontXRot, centerY + frontYRot);
            ctx.lineTo(centerX + backLeftXRot, centerY + backLeftYRot);
            ctx.lineTo(centerX + backRightXRot, centerY + backRightYRot);
            ctx.closePath();
            ctx.fill();
            
            // Optional: Add a small stroke outline for better visibility
            ctx.stroke();
        },
        
        /**
         * Draws the dashed vector from an aircraft to where it will be in
         * {@link CONFIG.VECTOR_MINUTES} minutes at its current track and speed.
         * @param {Object} ac Displayed aircraft entry.
         * @param {number} x Current symbol X.
         * @param {number} y Current symbol Y.
         * @returns {void}
         */
        drawSpeedVector(ac, x, y) {
            const ctx = elements.ctx;
            const projected = MathUtils.projectPosition(
                ac.data.lat, ac.data.lon,
                ac.data.track, ac.data.gs,
                CONFIG.VECTOR_MINUTES
            );
            
            const screenPos = MathUtils.latLonToScreen(
                projected.lat, projected.lon,
                state.maxRangeNm, 
                elements.canvas.width / 2, 
                elements.canvas.height / 2,
                Math.min(elements.canvas.width, elements.canvas.height) / 2 - CONFIG.CANVAS_PADDING
            );
            
            if (screenPos) {
                ctx.globalAlpha = ac.alpha * 0.5;
                ctx.lineWidth = 1;
                ctx.setLineDash([5, 5]);
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(screenPos.x, screenPos.y);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        },
        
        /**
         * Traces a rounded rectangle path. Does not fill or stroke.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @param {number} x Left edge.
         * @param {number} y Top edge.
         * @param {number} width Width in pixels.
         * @param {number} height Height in pixels.
         * @param {number} radius Corner radius.
         * @returns {void}
         */
        _drawRoundedRect(ctx, x, y, width, height, radius) {
            ctx.beginPath();
            ctx.moveTo(x + radius, y);
            ctx.lineTo(x + width - radius, y);
            ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
            ctx.lineTo(x + width, y + height - radius);
            ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
            ctx.lineTo(x + radius, y + height);
            ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
            ctx.lineTo(x, y + radius);
            ctx.quadraticCurveTo(x, y, x + radius, y);
            ctx.closePath();
        },
        
        /**
         * Axis-aligned rectangle overlap test with a 3 px breathing space, used
         * for label collision detection.
         * @param {{x: number, y: number, width: number, height: number}} r1
         * @param {{x: number, y: number, width: number, height: number}} r2
         * @returns {boolean} True if the rectangles (plus padding) intersect.
         */
        _rectsIntersect(r1, r2) {
            const padding = 3; // a few pixels apart
            return !(r2.x > r1.x + r1.width + padding ||
                     r2.x + r2.width < r1.x - padding ||
                     r2.y > r1.y + r1.height + padding ||
                     r2.y + r2.height < r1.y - padding);
        },

        /**
         * Draws the data block for an aircraft with a leader line back to the
         * symbol: the callsign alone, or — when extended labels are on, the `D`
         * key — followed by altitude and ground speed, then heading and squawk.
         *
         * Twelve candidate positions are tried on a circle around the target; the
         * first that stays on-canvas and does not overlap an already-placed label
         * wins. If all twelve collide the label is skipped rather than drawn
         * illegibly on top of another.
         * @param {Object} ac Displayed aircraft entry.
         * @param {number} aircraftX Symbol X.
         * @param {number} aircraftY Symbol Y.
         * @param {number} canvasWidth Canvas width, for edge clamping.
         * @param {string} color Label colour.
         * @param {Array<Object>} drawnLabels Rectangles already placed this frame;
         *   appended to on success.
         * @returns {void}
         */
        drawAircraftLabels(ac, aircraftX, aircraftY, canvasWidth, color, drawnLabels) {
            const ctx = elements.ctx;
        
            // The callsign is always shown; the telemetry lines are the
            // "extended labels" the D key toggles.
            const lines = [(ac.data.flight || 'N/A').trim()];
            if (state.showLabelDetails) {
                lines.push(`${ac.data.alt_baro || '???'}ft | ${ac.data.gs || '???'}kt`);
                lines.push(`HDG ${ac.data.track || '???'}° | SQK ${ac.data.squawk || '????'}`);
            }

            const padding = 4;
            const line1Height = 12;
            const otherLineHeight = 10;
            const lineSpacing = 2;
        
            // Measure text to get box dimensions
            ctx.font = 'bold 12px monospace';
            let maxWidth = ctx.measureText(lines[0]).width;
            ctx.font = '10px monospace';
            for (let i = 1; i < lines.length; i++) {
                maxWidth = Math.max(maxWidth, ctx.measureText(lines[i]).width);
            }
            
            const labelWidth = maxWidth + (padding * 2);
            const labelHeight = line1Height +
                                ((otherLineHeight + lineSpacing) * (lines.length - 1)) +
                                (padding * 2);
        
            // Define candidate positions
            const candidatePositions = [];
            const numCandidates = 12; 
            const placementRadius = 18; 

            for (let i = 0; i < numCandidates; i++) {
                const angle = (i / numCandidates) * 2 * Math.PI;
                const dx = placementRadius * Math.cos(angle);
                const dy = placementRadius * Math.sin(angle);

                candidatePositions.push({
                    dx: dx,
                    dy: dy,
                    textAlign: (dx >= 0) ? 'left' : 'right',
                    anchorX: (dx >= 0) ? 0 : 1 
                });
            }
        
            let placedLabel = null;
        
            // Iterate through candidates to find a free spot
            for (const pos of candidatePositions) {
                const potentialRect = {
                    x: aircraftX + pos.dx - (labelWidth * pos.anchorX),
                    y: aircraftY + pos.dy - (labelHeight / 2),
                    width: labelWidth,
                    height: labelHeight
                };
        
                if (potentialRect.x < 0 || potentialRect.x + potentialRect.width > canvasWidth ||
                    potentialRect.y < 0 || potentialRect.y + potentialRect.height > elements.canvas.height) {
                    continue;
                }
        
                if (!drawnLabels.some(existingLabel => this._rectsIntersect(potentialRect, existingLabel))) {
                    placedLabel = { ...potentialRect, ...pos };
                    break;
                }
            }
        
            // If a spot was found, draw the label and leader line
            if (placedLabel) {
                ctx.globalAlpha = ac.alpha;
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;

                // Define the leader line target point and calculate the start point with a gap.
                let leaderLineTargetX;
                const leaderLineTargetY = placedLabel.y + padding + (line1Height / 2);

                if (placedLabel.textAlign === 'left') {
                    leaderLineTargetX = placedLabel.x;
                } else {
                    leaderLineTargetX = placedLabel.x + placedLabel.width;
                }

                const vx = leaderLineTargetX - aircraftX;
                const vy = leaderLineTargetY - aircraftY;
                const length = Math.hypot(vx, vy);
                const gap = CONFIG.AIRCRAFT_SYMBOL_SIZE + 4; // Symbol radius + 4px space

                if (length > gap) {
                    const startX = aircraftX + (vx / length) * gap;
                    const startY = aircraftY + (vy / length) * gap;

                    ctx.beginPath();
                    ctx.moveTo(startX, startY);
                    ctx.lineTo(leaderLineTargetX, leaderLineTargetY);
                    ctx.stroke();
                }
        
                // Draw the text
                ctx.fillStyle = color;
                ctx.textAlign = placedLabel.textAlign;
                const textX = placedLabel.textAlign === 'left' ? placedLabel.x + padding : placedLabel.x + placedLabel.width - padding;
                let currentY = placedLabel.y + padding + line1Height - 2;
        
                ctx.font = 'bold 12px monospace';
                ctx.fillText(lines[0], textX, currentY);
        
                ctx.font = '10px monospace';
                for (let i = 1; i < lines.length; i++) {
                    currentY += otherLineHeight + lineSpacing;
                    ctx.fillText(lines[i], textX, currentY);
                }
        
                drawnLabels.push(placedLabel);
                if (canvasRenderer) {
                    // Union of the text block and the leader line back to the target.
                    const lx = Math.min(placedLabel.x, aircraftX);
                    const ly = Math.min(placedLabel.y, aircraftY);
                    const lw = Math.max(placedLabel.x + placedLabel.width, aircraftX) - lx;
                    const lh = Math.max(placedLabel.y + placedLabel.height, aircraftY) - ly;
                    canvasRenderer.markDirty(lx, ly, lw, lh);
                }
            }
        },

        /**
         * Draws the debug overlay (FPS, JS heap usage where the browser exposes
         * it, tracked aircraft count). Toggled with the `D` key.
         * @param {CanvasRenderingContext2D} ctx Target context.
         * @returns {void}
         */
        drawDebugInfo(ctx) {
            if (!state.showDebugInfo) return;

            if (canvasRenderer) canvasRenderer.markDirty(5, 5, 180, 60);

            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fillRect(5, 5, 180, 60);

            ctx.font = '12px monospace';
            ctx.fillStyle = '#00FF00';
            ctx.textAlign = 'left';
            
            // Display FPS
            ctx.fillText(`FPS: ${state.fps}`, 10, 20);

            // Display Memory Usage (if available)
            if (performance.memory) {
                const usedMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
                const totalMB = (performance.memory.totalJSHeapSize / 1048576).toFixed(1);
                ctx.fillText(`Mem: ${usedMB}MB / ${totalMB}MB`, 10, 40);
            } else {
                ctx.fillText('Mem: N/A', 10, 40);
            }

            // Display Tracked Aircraft
            const trackedCount = Object.keys(state.displayedAircraft).length;
            ctx.fillText(`Tracked: ${trackedCount}`, 10, 60);

            ctx.restore();
        }
        // DEBUG
    };

    /**
     * Everything outside the canvas: the aircraft table, metrics panel, status
     * bar, tooltips, popups and emergency banners.
     *
     * Panel refreshes are coalesced: each `update*` method flags the panel as
     * dirty and {@link UIManager.batchUpdates} repaints them together on the
     * next frame.
     * @namespace UIManager
     * @property {{aircraftList: boolean, metrics: boolean, status: boolean}}
     *   pendingUpdates Panels awaiting a repaint.
     */
    const UIManager = {
        pendingUpdates: {
            aircraftList: false,
            metrics: false,
            status: false
        },
        
        /**
         * Flushes the pending panel updates inside a single animation frame, so a
         * burst of state changes costs one layout pass rather than several.
         * @returns {void}
         */
        batchUpdates() {
            if (CONFIG.PERFORMANCE.BATCH_DOM_UPDATES) {
                requestAnimationFrame(() => {
                    if (this.pendingUpdates.aircraftList) {
                        this.updateAircraftListInternal();
                        this.pendingUpdates.aircraftList = false;
                    }
                    if (this.pendingUpdates.metrics) {
                        this.updateMetricsPanelInternal();
                        this.pendingUpdates.metrics = false;
                    }
                    if (this.pendingUpdates.status) {
                        this.updateScopeStatusInternal();
                        this.pendingUpdates.status = false;
                    }
                });
            }
        },
        
        /**
         * Queues (or performs) an aircraft-list refresh.
         * @returns {void}
         */
        updateAircraftList() {
            if (CONFIG.PERFORMANCE.BATCH_DOM_UPDATES) {
                this.pendingUpdates.aircraftList = true;
                this.batchUpdates();
            } else {
                this.updateAircraftListInternal();
            }
        },
        
        /**
         * Rebuilds the aircraft table, sorted by distance from home. Rows are
         * assembled into a DocumentFragment so the table is touched once instead
         * of once per row.
         * @returns {void}
         */
        updateAircraftListInternal() {
            const sortedAircraft = Object.values(state.displayedAircraft)
                .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
            
            if (sortedAircraft.length === 0) {
                elements.aircraftListBody.innerHTML = 
                    `<tr><td colspan="5" class="text-center p-4" style="color: var(--color-text-muted);">No aircraft in range</td></tr>`;
                return;
            }
            
            // Performance Optimization #3: Use DocumentFragment for batch DOM updates
            const fragment = CONFIG.PERFORMANCE.USE_DOCUMENT_FRAGMENT ? 
                document.createDocumentFragment() : null;
            
            const rows = sortedAircraft.map(ac => {
                const isSelected = ac.data.hex === state.selectedHex;
                const sourceIndicator = DataManager.getDataSourceIndicator(ac.data);
                const row = document.createElement('tr');
                row.className = `aircraft-row ${isSelected ? 'selected-row' : ''}`;
                row.dataset.hex = ac.data.hex;
                row.innerHTML = `
                    <td class="table-cell font-bold">${ac.data.flight?.trim() || ac.data.hex.slice(0, 6)}</td>
                    <td class="table-cell text-center">${sourceIndicator}</td>
                    <td class="table-cell text-right">${ac.data.alt_baro || 'N/A'}</td>
                    <td class="table-cell text-right">${ac.data.gs || 'N/A'}</td>
                    <td class="table-cell text-right">${ac.dist?.toFixed(1) || 'N/A'}</td>
                `;
                return row;
            });
            
            elements.aircraftListBody.innerHTML = '';
            
            if (fragment) {
                rows.forEach(row => fragment.appendChild(row));
                elements.aircraftListBody.appendChild(fragment);
            } else {
                rows.forEach(row => elements.aircraftListBody.appendChild(row));
            }
            
            if (window.innerWidth <= 768) {
                this.updateMobileAircraftList(sortedAircraft);
            }
        },
        
        /**
         * Renders a condensed 10-row aircraft list for narrow viewports.
         * @param {Array<Object>} sortedAircraft Aircraft ordered by distance.
         * @returns {void}
         */
        updateMobileAircraftList(sortedAircraft) {
            const mobileList = document.getElementById('mobile-aircraft-list');
            if (mobileList) {
                mobileList.innerHTML = sortedAircraft.slice(0, 10).map(ac => 
                    `<div class="p-1 border-b" style="border-color: var(--color-border);">
                        ${ac.data.flight?.trim() || ac.data.hex.slice(0, 6)} - 
                        ${ac.data.alt_baro || '?'}ft - 
                        ${ac.dist?.toFixed(1) || '?'}nm
                    </div>`
                ).join('');
            }
        },
        
        /**
         * Queues (or performs) a metrics-panel refresh.
         * @returns {void}
         */
        updateMetricsPanel() {
            if (CONFIG.PERFORMANCE.BATCH_DOM_UPDATES) {
                this.pendingUpdates.metrics = true;
                this.batchUpdates();
            } else {
                this.updateMetricsPanelInternal();
            }
        },
        
        /**
         * Renders the metrics panel (and its mobile mirror) from
         * {@link UIManager.calculateMetrics}.
         * @returns {void}
         */
        updateMetricsPanelInternal() {
            const stats = this.calculateMetrics();
            const metricItem = (label, value) => 
                `<div class="flex justify-between"><span>${label}:</span> <span class="font-bold">${value}</span></div>`;
            
            const metricsHTML = `
                <div class="mb-3">
                    <div class="text-center font-bold text-sm mb-2">Session Stats</div>
                    ${metricItem('Uptime (min)', stats.uptime)}
                    ${metricItem('Max Tracked', state.sessionStats.maxConcurrent)}
                    ${metricItem('Unique Today', state.sessionStats.uniqueAircraft.size)}
                    ${metricItem('Messages', state.sessionStats.messagesReceived.toLocaleString())}
                </div>
                <hr class="my-2" style="border-color: var(--color-border);">
                <div class="mb-3">
                    <div class="text-center font-bold text-sm mb-2">Current Traffic</div>
                    ${metricItem('Military', stats.militaryCount)}
                    ${metricItem('Civilian', stats.civilianCount)}
                    ${metricItem('On Ground', stats.groundCount)}
                    ${metricItem('Emergency', stats.emergencyCount)}
                    ${metricItem('Unique Squawks', stats.uniqueSquawks)}
                </div>
                <hr class="my-2" style="border-color: var(--color-border);">
                <div class="mb-3">
                    <div class="text-center font-bold text-sm mb-2">Averages</div>
                    ${metricItem('Avg Altitude', stats.avgAltitude + (stats.avgAltitude !== 'N/A' ? ' ft' : ''))}
                    ${metricItem('Avg Speed', stats.avgSpeed + (stats.avgSpeed !== 'N/A' ? ' kt' : ''))}
                </div>
                <hr class="my-2" style="border-color: var(--color-border);">
                <div class="mb-3">
                    <div class="text-center font-bold text-sm mb-2">Live Records</div>
                    ${metricItem('Closest', stats.closest)}
                    ${metricItem('Fastest', stats.fastest)}
                    ${metricItem('Highest', stats.highest)}
                    ${metricItem('Lowest', stats.lowest)}
                </div>
            `;
            
            elements.metricsPanel.innerHTML = metricsHTML;
            
            const mobileMetrics = document.getElementById('mobile-metrics');
            if (mobileMetrics) {
                mobileMetrics.innerHTML = metricsHTML;
            }
        },
        
        /**
         * Single pass over the displayed aircraft computing every metric the panel
         * needs: counts, averages and the closest/fastest/highest/lowest records.
         * Ground traffic is excluded from the altitude statistics.
         * @returns {Object} Formatted metrics, ready to interpolate into HTML.
         */
        calculateMetrics() {
            const uptime = ((Date.now() - state.sessionStats.startTime) / 1000 / 60).toFixed(1);
            let fastest = { gs: 0 };
            let closest = { dist: Infinity };
            let highest = { alt_baro: -99999 };
            let lowest = { alt_baro: 99999 };
            let emergencyCount = 0;
            let groundCount = 0;
            let totalAltitude = 0;
            let airborneCount = 0;
            let totalSpeed = 0;
            let speedCount = 0;
            
            const squawks = new Set();
            let militaryCount = 0;
            let civilianCount = 0;
            
            Object.values(state.displayedAircraft).forEach(ac => {
                const hex = ac.data.hex;
                if (DataManager.isMilitary(hex)) {
                    militaryCount++;
                } else {
                    civilianCount++;
                }
                
                if (ac.data.squawk) {
                    squawks.add(ac.data.squawk);
                }
                
                if (ac.data.gnd) {
                    groundCount++;
                } else {
                    airborneCount++;
                    if (ac.data.alt_baro) {
                        totalAltitude += ac.data.alt_baro;
                        if (ac.data.alt_baro > highest.alt_baro) highest = ac.data;
                        if (ac.data.alt_baro < lowest.alt_baro) lowest = ac.data;
                    }
                }
                
                if (ac.data.gs) {
                    totalSpeed += ac.data.gs;
                    speedCount++;
                    if (ac.data.gs > fastest.gs) fastest = ac.data;
                }
                
                if ((ac.dist || Infinity) < closest.dist) {
                    closest = { ...ac.data, dist: ac.dist };
                }
                
                if (CONFIG.EMERGENCY_SQUAWKS.includes(ac.data.squawk)) {
                    emergencyCount++;
                }
            });
            
            const avgAltitude = airborneCount > 0 ? (totalAltitude / airborneCount).toFixed(0) : 'N/A';
            const avgSpeed = speedCount > 0 ? (totalSpeed / speedCount).toFixed(0) : 'N/A';
            
            return {
                uptime,
                groundCount,
                emergencyCount,
                avgAltitude,
                avgSpeed,
                militaryCount,
                civilianCount,
                uniqueSquawks: squawks.size,
                closest: closest.dist !== Infinity ? 
                    `${closest.flight?.trim() || closest.hex} (${closest.dist.toFixed(1)} nm)` : 'N/A',
                fastest: fastest.gs > 0 ? 
                    `${fastest.flight?.trim() || fastest.hex} (${fastest.gs} kt)` : 'N/A',
                highest: highest.alt_baro > -99999 ? 
                    `${highest.flight?.trim() || highest.hex} (${highest.alt_baro} ft)` : 'N/A',
                lowest: lowest.alt_baro < 99999 && airborneCount > 0 ? 
                    `${lowest.flight?.trim() || lowest.hex} (${lowest.alt_baro} ft)` : 'N/A'
            };
        },
        
        /**
         * Queues (or performs) a status-bar refresh.
         * @returns {void}
         */
        updateScopeStatus() {
            if (CONFIG.PERFORMANCE.BATCH_DOM_UPDATES) {
                this.pendingUpdates.status = true;
                this.batchUpdates();
            } else {
                this.updateScopeStatusInternal();
            }
        },
        
        /**
         * Renders the status bar: range, connection state with indicator, tracked
         * count, active filter, CSV load counts and home position.
         * @returns {void}
         */
        updateScopeStatusInternal() {
            const dataStatus = state.dataLoaded ? 
                `DATA: ${state.airports.length}A/${state.navaids.length}N/${state.runways.length}R` :
                'DATA: Loading...';
            
            let connectionStatusHTML = '';
            if (state.connectionStatus === "OK") {
                connectionStatusHTML = '<span class="status-icon status-ok"></span>CONN: OK';
            } else if (state.connectionStatus.includes("Error")) {
                connectionStatusHTML = '<span class="status-icon status-error"></span>CONN: ' + state.connectionStatus;
            } else {
                connectionStatusHTML = '<span class="status-icon status-connecting"></span>CONN: ' + state.connectionStatus;
            }
            
            // A moving receiver gets its own segment: course, speed and whether
            // the fix is still fresh.
            let positionLabel = `POS: ${state.homeLat.toFixed(5)}, ${state.homeLon.toFixed(5)}`;
            if (state.positionFileEnabled) {
                const stale = PositionManager.isStale();
                const icon = state.positionFileStatus.kind === 'error' || stale
                    ? '<span class="status-icon status-error"></span>'
                    : (state.positionFileStatus.kind === 'ok'
                        ? '<span class="status-icon status-ok"></span>'
                        : '<span class="status-icon status-connecting"></span>');
                const cog = typeof state.ownHeading === 'number'
                    ? ` ${Math.round(state.ownHeading).toString().padStart(3, '0')}°` : '';
                const sog = typeof state.ownSpeed === 'number'
                    ? ` ${state.ownSpeed.toFixed(1)}kt` : '';
                positionLabel = `${icon}UNDERWAY: ${state.homeLat.toFixed(5)}, ` +
                                `${state.homeLon.toFixed(5)}${cog}${sog}` +
                                (stale ? ' (STALE)' : '');
            }

            elements.scopeStatusBar.innerHTML = [
                `RANGE: ${state.maxRangeNm} NM`,
                connectionStatusHTML,
                `TRACKED: ${Object.keys(state.displayedAircraft).length}`,
                `FILTER: ${state.aircraftFilter.toUpperCase()}`,
                dataStatus,
                positionLabel
            ].map(item => `<span>${item}</span>`).join('<span class="mx-2">|</span>');
        },
        
        /**
         * Syncs the toolbar tooltips with the current ON/OFF state of each layer.
         * @returns {void}
         */
        updateTooltips() {
            const vectorsTooltip = elements.vectorsButton?.querySelector('.tooltip-text');
            const trailsTooltip = elements.trailsButton?.querySelector('.tooltip-text'); 
            const airportsTooltip = elements.airportsButton?.querySelector('.tooltip-text');
            const navaidsTooltip = elements.navaidsButton?.querySelector('.tooltip-text');
            const runwaysTooltip = elements.runwaysButton?.querySelector('.tooltip-text');
            
            if (vectorsTooltip) vectorsTooltip.textContent = `Vectors: ${state.showVectors ? 'ON' : 'OFF'}`;
            if (trailsTooltip) trailsTooltip.textContent = `Trails: ${state.showTrails ? 'ON' : 'OFF'}`; 
            if (airportsTooltip) airportsTooltip.textContent = `Airports: ${state.showAirports ? 'ON' : 'OFF'}`;
            if (navaidsTooltip) navaidsTooltip.textContent = `Navaids: ${state.showNavaids ? 'ON' : 'OFF'}`;
            if (runwaysTooltip) runwaysTooltip.textContent = `Runways: ${state.showRunways ? 'ON' : 'OFF'}`;
        },
        
        /**
         * Keeps the open aircraft popup anchored to its target as the target
         * moves, flipping sides when it would overflow the canvas. Driven by a
         * 100 ms interval while a popup is open.
         * @returns {void}
         */
        updatePopup() {
            if (state.popupAircraft && !elements.aircraftPopup.classList.contains('hidden')) {
                const aircraft = state.displayedAircraft[state.popupAircraft];
                if (aircraft) {
                    const { x, y } = aircraft.displayPos;
                    const popupRect = elements.aircraftPopup.getBoundingClientRect();
                    const canvasRect = elements.canvas.getBoundingClientRect();
                    
                    let popupX = x + 15;
                    let popupY = y + 15;
                    
                    if (popupX + popupRect.width > canvasRect.width) {
                        popupX = x - popupRect.width - 15;
                    }
                    if (popupY + popupRect.height > canvasRect.height) {
                        popupY = y - popupRect.height - 15;
                    }
                    
                    elements.aircraftPopup.style.left = `${popupX}px`;
                    elements.aircraftPopup.style.top = `${popupY}px`;
                }
            }
        },
        
        /**
         * Shows the airport info popup (name, location, elevation, type, runway
         * identifiers), flipped to stay inside the canvas, auto-hiding after 5 s.
         * @param {Airport} airport Airport that was clicked.
         * @param {number} x Click X, canvas-relative.
         * @param {number} y Click Y, canvas-relative.
         * @returns {void}
         */
        showAirportPopup(airport, x, y) {
            if (!elements.airportPopup) return;
            
            const runways = CSVDataManager.getRunwaysForAirport(airport.icao);
            const runwayInfo = runways.length > 0 ? 
                `<br><strong>Runways:</strong> ${runways.map(r => r.id).join(', ')}` : '';
            
            elements.airportPopup.innerHTML = `
                <div><strong>${airport.icao}</strong> - ${airport.name}</div>
                <div>${airport.municipality}, ${airport.iso_country}</div>
                <div><strong>Elevation:</strong> ${airport.elevation}ft</div>
                <div><strong>Type:</strong> ${airport.type}</div>
                ${runwayInfo}
            `;
            
            const canvasRect = elements.canvas.getBoundingClientRect();
            let popupX = x + 15;
            let popupY = y + 15;
            
            if (popupX + 200 > canvasRect.width) {
                popupX = x - 215;
            }
            if (popupY + 100 > canvasRect.height) {
                popupY = y - 115;
            }
            
            elements.airportPopup.style.left = `${popupX}px`;
            elements.airportPopup.style.top = `${popupY}px`;
            elements.airportPopup.classList.remove('hidden');
            
            setTimeout(() => {
                elements.airportPopup.classList.add('hidden');
            }, 5000);
        },
        
        /**
         * Renders the keyboard-shortcut legend into both the bottom bar and the
         * help modal from a single source of truth.
         * @returns {void}
         */
        createShortcutBar() {
            const shortcuts = {
                "H / ?": "Help",
                "Space": "Pause",
                "+/-/Scroll": "Range",
                "Click ring": "Zoom to ring",
                "R": "Reset view",
                "M": "Mil/Civ/All",
                "V": "Vectors",
                "T": "Trails", 
                "A": "Airports",
                "N": "Navaids",
                "W": "Runways",
                "D": "Label details",
                "I": "Debug info",
                "S": "Settings"
            };
            
            const kbdStyle = "font-sans px-1.5 py-0.5 text-xs font-semibold border";
            const kbdColors = `background-color: var(--color-kbd-bg); color: var(--color-kbd-text); border-color: var(--color-kbd-border);`;
            
            elements.shortcutBar.innerHTML = Object.entries(shortcuts)
                .map(([key, desc]) => 
                    `<div class="flex items-center gap-1">
                        <kbd class="${kbdStyle}" style="${kbdColors}">${key}</kbd> ${desc}
                    </div>`)
                .join('');
            
            const helpList = document.getElementById('help-shortcut-list');
            if (helpList) {
                helpList.innerHTML = Object.entries(shortcuts)
                    .map(([key, desc]) => 
                        `<div><kbd class="${kbdStyle}" style="${kbdColors}">${key}</kbd> - ${desc}</div>`)
                    .join('');
            }
        },
        
        /**
         * Raises a visual emergency banner for an aircraft squawking 7500/7600/
         * 7700. De-duplicated through `state.activeAlerts`, so one aircraft yields
         * one banner however many messages arrive; it clears after
         * {@link CONFIG.ALERT_DURATION_MS}.
         *
         * The return value is what gates the alert tone, so the sound is
         * de-duplicated on exactly the same decision as the banner.
         * @param {AircraftMessage} aircraft Aircraft in distress.
         * @returns {boolean} True if this raised a new banner.
         */
        createEmergencyAlert(aircraft) {
            // Normalised so the key matches the one processAircraftData indexes by.
            const hex = String(aircraft.hex || '').trim().toUpperCase();
            if (!hex || state.activeAlerts.has(hex)) return false;
            
            state.activeAlerts.add(hex);
            const alertDiv = document.createElement('div');
            alertDiv.className = 'bg-red-500 text-white p-2 shadow-lg text-sm alert-animate';
            alertDiv.innerHTML = `<b>EMERGENCY</b><br>${aircraft.flight?.trim() || hex}<br>Squawk: ${aircraft.squawk}`;
            elements.alertContainer.appendChild(alertDiv);
            
            const timeout = setTimeout(() => {
                alertDiv.remove();
                state.activeAlerts.delete(hex);
            }, CONFIG.ALERT_DURATION_MS);
            state.timeouts.push(timeout);
            return true;
        }
    };

    /**
     * Download helpers for the current scope contents: CSV, KML and a JSON
     * statistics snapshot.
     * @namespace ExportManager
     */
    const ExportManager = {
        /**
         * Exports the tracked aircraft as CSV.
         * @returns {void}
         */
        exportCSV() {
            const data = Object.values(state.displayedAircraft);
            const headers = ['hex', 'flight', 'lat', 'lon', 'alt_baro', 'gs', 'track', 'squawk', 'data_source'];
            
            let csv = headers.join(',') + '\n';
            data.forEach(ac => {
                const row = headers.map(h => {
                    if (h === 'data_source') return ac.data.dataSource || '';
                    return ac.data[h] || '';
                }).join(',');
                csv += row + '\n';
            });
            
            this.downloadFile(csv, 'aircraft_data.csv', 'text/csv');
        },
        
        /**
         * Exports the tracked aircraft as KML placemarks for Google Earth.
         * Altitudes are converted from feet to metres.
         * @returns {void}
         */
        exportKML() {
            const data = Object.values(state.displayedAircraft);
            
            let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>Aircraft Positions</name>`;
            
            data.forEach(ac => {
                kml += `
<Placemark>
    <name>${ac.data.flight || ac.data.hex}</name>
    <description>Alt: ${ac.data.alt_baro}ft, Speed: ${ac.data.gs}kt, Source: ${ac.data.dataSource || 'Unknown'}</description>
    <Point>
        <coordinates>${ac.data.lon},${ac.data.lat},${(ac.data.alt_baro || 0) * 0.3048}</coordinates>
    </Point>
</Placemark>`;
            });
            
            kml += `
</Document>
</kml>`;
            
            this.downloadFile(kml, 'aircraft_positions.kml', 'application/vnd.google-earth.kml+xml');
        },
        
        /**
         * Exports a JSON snapshot of session stats, current traffic, averages,
         * live records and the active configuration.
         * @returns {void}
         */
        exportStatistics() {
            const stats = UIManager.calculateMetrics();
            const exportData = {
                session: {
                    startTime: new Date(state.sessionStats.startTime).toISOString(),
                    uptime: stats.uptime,
                    maxConcurrent: state.sessionStats.maxConcurrent,
                    uniqueAircraft: state.sessionStats.uniqueAircraft.size,
                    messagesReceived: state.sessionStats.messagesReceived
                },
                current: {
                    tracked: Object.keys(state.displayedAircraft).length,
                    military: stats.militaryCount,
                    civilian: stats.civilianCount,
                    onGround: stats.groundCount,
                    emergency: stats.emergencyCount,
                    uniqueSquawks: stats.uniqueSquawks
                },
                averages: {
                    altitude: stats.avgAltitude,
                    speed: stats.avgSpeed
                },
                records: {
                    closest: stats.closest,
                    fastest: stats.fastest,
                    highest: stats.highest,
                    lowest: stats.lowest
                },
                configuration: {
                    homePosition: { lat: state.homeLat, lon: state.homeLon },
                    range: state.maxRangeNm,
                    dataSources: state.dataSources.filter(s => s.enabled).map(s => s.name)
                }
            };
            
            this.downloadFile(JSON.stringify(exportData, null, 2), 'adsb_statistics.json', 'application/json');
        },
        
        /**
         * Triggers a browser download from an in-memory string via a temporary
         * object URL, which is revoked immediately afterwards.
         * @param {string} content File contents.
         * @param {string} filename Suggested filename.
         * @param {string} mimeType MIME type for the blob.
         * @returns {void}
         */
        downloadFile(content, filename, mimeType) {
            const blob = new Blob([content], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    };

    /**
     * Bridge between the raw feed (`state.aircraftData`) and what is on screen
     * (`state.displayedAircraft`). Owns sweep-gated updates and the geographic
     * trail buffers.
     * @namespace AircraftStateManager
     */
    const AircraftStateManager = {
        /**
         * Promotes freshly fetched aircraft into the displayed set, but only as
         * the sweep passes over them — which is what produces the characteristic
         * radar "paint" instead of every target jumping at once.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        updateAircraftState(cx, cy, radius) {
            const currentTime = Date.now() / 1000;
            state.sessionStats.maxConcurrent = Math.max(
                state.sessionStats.maxConcurrent,
                Object.keys(state.displayedAircraft).length
            );
            
            Object.values(state.aircraftData).forEach(ac_latest => {
                const hex = ac_latest.hex.trim().toUpperCase();
                
                if (!this.shouldDisplayAircraft(ac_latest, hex)) {
                    if (state.displayedAircraft[hex]) {
                        // Clean up trail points before deleting
                        if (state.displayedAircraft[hex].geoTrail) {
                            state.displayedAircraft[hex].geoTrail.forEach(point => 
                                trailPointPool.release(point)
                            );
                        }
                        delete state.displayedAircraft[hex];
                    }
                    return;
                }
                
                const currentBrng = MathUtils.bearing(
                    state.homeLat, state.homeLon,
                    ac_latest.lat, ac_latest.lon
                );
                
                const sweepBrng = ((state.displayedAircraft[hex]?.compassBearing ?? currentBrng) - 90 + 360) % 360;
                const isSwept = this.isInSweepArea(sweepBrng);
                
                if (isSwept) {
                    this.updateAircraftDisplay(hex, ac_latest, currentTime, currentBrng, cx, cy, radius);
                }
            });
        },
        
        /**
         * Applies the display filters: an aircraft needs either a barometric
         * altitude or a ground flag, and must match the active
         * all/military/civilian filter.
         * @param {AircraftMessage} aircraft Decoded message.
         * @param {string} hex Uppercased ICAO hex address.
         * @returns {boolean} True if it should be drawn.
         */
        shouldDisplayAircraft(aircraft, hex) {
            if (typeof aircraft.alt_baro !== 'number' && !aircraft.gnd) return false;
            
            if (state.aircraftFilter === 'military' && !DataManager.isMilitary(hex)) return false;
            if (state.aircraftFilter === 'civilian' && DataManager.isMilitary(hex)) return false;
            
            return true;
        },
        
        /**
         * Tests whether a bearing was crossed by the sweep between the previous
         * frame and this one, handling the 360°→0° wrap.
         * @param {number} sweepBrng Bearing in sweep (screen) degrees.
         * @returns {boolean} True if the sweep passed over it this frame.
         */
        isInSweepArea(sweepBrng) {
            if (state.sweepAngle > state.prevSweepAngle) {
                return sweepBrng > state.prevSweepAngle && sweepBrng <= state.sweepAngle;
            } else if (state.sweepAngle < state.prevSweepAngle) {
                return sweepBrng > state.prevSweepAngle || sweepBrng <= state.sweepAngle;
            }
            return false;
        },
        
        /**
         * Creates or refreshes the display entry for one aircraft and appends a
         * point to its geographic trail.
         *
         * Trails are stored as lat/lon only — never screen pixels — so zooming or
         * resizing does not distort history; screen coordinates are derived per
         * frame by {@link MathUtils.geoTrailToScreen}. Trail points come from
         * `trailPointPool` and are returned to it when they age out. Aircraft that
         * fall outside the current range are dropped entirely.
         * @param {string} hex Uppercased ICAO hex address.
         * @param {AircraftMessage} ac_latest Newest message for this aircraft.
         * @param {number} currentTime Current time in seconds.
         * @param {number} currentBrng True bearing from home, in degrees.
         * @param {number} cx Canvas centre X.
         * @param {number} cy Canvas centre Y.
         * @param {number} radius Scope radius in pixels.
         * @returns {void}
         */
        updateAircraftDisplay(hex, ac_latest, currentTime, currentBrng, cx, cy, radius) {
            const previous = state.displayedAircraft[hex];
            const smoothed = this.smoothPosition(previous, ac_latest);

            const screenPos = MathUtils.latLonToScreen(
                smoothed.lat, smoothed.lon,
                state.maxRangeNm, cx, cy, radius
            );
            
            if (!screenPos) {
                if (state.displayedAircraft[hex]) {
                    // Clean up before deleting
                    if (state.displayedAircraft[hex].geoTrail) {
                        state.displayedAircraft[hex].geoTrail.forEach(point => 
                            trailPointPool.release(point)
                        );
                    }
                    delete state.displayedAircraft[hex];
                }
                return;
            }
            
            if (!state.displayedAircraft[hex]) {
                state.displayedAircraft[hex] = { 
                    geoTrail: []  // Only store geographic coordinates
                };
            }
            
            const entry = state.displayedAircraft[hex];
            entry.lastUpdateTime = currentTime;
            entry.displayPos = screenPos;
            entry.displayHeading = ac_latest.track;
            entry.compassBearing = currentBrng;
            entry.data = ac_latest;
            entry.dist = screenPos.dist;
            
            entry.smoothLat = smoothed.lat;
            entry.smoothLon = smoothed.lon;

            // The trail records the smoothed track, so the symbol always sits on
            // the head of its own trail rather than beside it.
            const geoPoint = trailPointPool.acquire();
            geoPoint.lat = smoothed.lat;
            geoPoint.lon = smoothed.lon;
            geoPoint.timestamp = Date.now();
            
            entry.geoTrail.push(geoPoint);
            
            // Limit trail length and clean up old points
            while (entry.geoTrail.length > state.maxTrailLength) {
                const oldPoint = entry.geoTrail.shift();
                trailPointPool.release(oldPoint);
            }
        },

        /**
         * Applies exponential smoothing between the last displayed position and
         * the newly reported one.
         *
         * ADS-B positions arrive quantised and occasionally jitter by a few
         * hundred metres, which on a 5 nm scope is a visible twitch.
         * {@link CONFIG.SMOOTHING_FACTOR} is the weight kept from the previous
         * position: `0` snaps straight to each report, `0.3` (the default) damps
         * the jitter while still tracking, and values near `1` lag badly.
         *
         * A jump larger than {@link AircraftStateManager.SMOOTHING_SNAP_NM} is
         * treated as a genuine repositioning and snaps, so an aircraft
         * re-acquired after a gap does not glide across the scope.
         * @param {?Object} previous Existing display entry, if any.
         * @param {AircraftMessage} ac_latest Newly reported message.
         * @returns {{lat: number, lon: number}} Position to display.
         */
        smoothPosition(previous, ac_latest) {
            const f = CONFIG.SMOOTHING_FACTOR;

            if (!previous || typeof previous.smoothLat !== 'number' ||
                !(f > 0) || f >= 1) {
                return { lat: ac_latest.lat, lon: ac_latest.lon };
            }

            const jump = MathUtils.haversineDistance(
                previous.smoothLat, previous.smoothLon, ac_latest.lat, ac_latest.lon
            );
            if (jump > AircraftStateManager.SMOOTHING_SNAP_NM) {
                return { lat: ac_latest.lat, lon: ac_latest.lon };
            }

            return {
                lat: previous.smoothLat * f + ac_latest.lat * (1 - f),
                lon: previous.smoothLon * f + ac_latest.lon * (1 - f)
            };
        },

        /**
         * Distance beyond which a new report is a reposition rather than jitter,
         * in nautical miles.
         * @type {number}
         */
        SMOOTHING_SNAP_NM: 2
    };

    /**
     * All user interaction: toolbar toggles, keyboard shortcuts, canvas
     * hit-testing, the settings modal and persistence of UI state.
     *
     * Every listener is registered through
     * {@link EventHandlers.addEventListenerWithCleanup} so it can be torn down
     * deterministically on unload.
     * @namespace EventHandlers
     */
    const EventHandlers = {
        /**
         * Removes every tracked listener, interval and timeout. Called on page
         * unload via {@link App.cleanup}.
         * @returns {void}
         */
        cleanup() {
            state.eventListeners.forEach(({ element, event, handler }) => {
                element.removeEventListener(event, handler);
            });
            state.eventListeners = [];
            
            state.intervals.forEach(interval => clearInterval(interval));
            state.intervals = [];
            
            state.timeouts.forEach(timeout => clearTimeout(timeout));
            state.timeouts = [];
        },
        
        /**
         * Adds a listener and records it so {@link EventHandlers.cleanup} can
         * remove it later. No-ops when the element is missing.
         * @param {?EventTarget} element Target to bind to.
         * @param {string} event Event name.
         * @param {EventListener} handler Callback.
         * @param {(boolean|AddEventListenerOptions)} [options] Listener options.
         * @returns {void}
         */
        addEventListenerWithCleanup(element, event, handler, options) {
            if (element) {
                element.addEventListener(event, handler, options);
                state.eventListeners.push({ element, event, handler });
            }
        },
        
        /**
         * Builds a resize handler debounced by
         * {@link CONFIG.PERFORMANCE.DEBOUNCE_RESIZE_MS}, which marks the scope for
         * redraw and rebuilds the offscreen canvas at the new size.
         * @returns {function(): void} The debounced handler.
         */
        createDebouncedResize() {
            let resizeTimeout;
            return () => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    Renderer.markForRedraw();
                    if (canvasRenderer && canvasRenderer.initOffscreenCanvas) {
                        canvasRenderer.initOffscreenCanvas();
                    }
                }, CONFIG.PERFORMANCE.DEBOUNCE_RESIZE_MS);
            };
        },
        
        /**
         * Binds every application listener: delegation, dropdowns, toolbar
         * toggles, modals, collapsible sections, panel resizing, canvas
         * interaction, keyboard shortcuts, the debounced window resize and the
         * mobile menu. The AudioContext is created lazily on the first click,
         * because browsers reject one built without a user gesture.
         * @returns {void}
         */
        initializeEventListeners() {
            // Event delegation for dynamic elements
            this.setupEventDelegation();
            
            // Theme dropdowns
            this.setupDropdowns();
            
            // Panel controls
            this.addEventListenerWithCleanup(elements.hideUiButton, 'click', this.togglePanels);
            this.addEventListenerWithCleanup(elements.vectorsButton, 'click', this.toggleVectors.bind(this));
            this.addEventListenerWithCleanup(elements.trailsButton, 'click', this.toggleTrails.bind(this)); 
            this.addEventListenerWithCleanup(elements.airportsButton, 'click', this.toggleAirports.bind(this));
            this.addEventListenerWithCleanup(elements.navaidsButton, 'click', this.toggleNavaids.bind(this));
            this.addEventListenerWithCleanup(elements.runwaysButton, 'click', this.toggleRunways.bind(this));
            
            // Modal controls
            this.addEventListenerWithCleanup(elements.settingsButton, 'click', this.showSettings.bind(this));
            this.addEventListenerWithCleanup(elements.exportButton, 'click', this.showExportMenu);
            
            // Collapsible sections
            this.addEventListenerWithCleanup(elements.aircraftHeader, 'click', this.toggleAircraftSection.bind(this));
            this.addEventListenerWithCleanup(elements.metricsHeader, 'click', this.toggleMetricsSection.bind(this));
            
            // Resizers
            this.makeResizable(elements.rightPanel, elements.rightResizer);
            
            // Canvas interactions
            this.addEventListenerWithCleanup(elements.canvas, 'click', this.handleCanvasClick.bind(this));
            this.addEventListenerWithCleanup(elements.canvas, 'wheel', this.handleMouseWheel.bind(this));
            
            // Keyboard shortcuts
            this.addEventListenerWithCleanup(window, 'keydown', this.handleKeydown);
            
            // Debounced window resize
            const debouncedResize = this.createDebouncedResize();
            this.addEventListenerWithCleanup(window, 'resize', debouncedResize);
            
            // Modal close buttons
            this.addEventListenerWithCleanup(elements.closeHelpButton, 'click', () => {
                elements.helpModal.classList.add('hidden');
            });
            
            const closeSettingsBtn = document.getElementById('close-settings-btn');
            this.addEventListenerWithCleanup(closeSettingsBtn, 'click', () => {
                elements.settingsModal.classList.add('hidden');
            });
            
            // Settings save button
            const saveSettingsBtn = document.getElementById('save-settings-btn');
            this.addEventListenerWithCleanup(saveSettingsBtn, 'click', this.saveSettings.bind(this));

            // Clear stored settings
            const clearStorageBtn = document.getElementById('clear-storage-btn');
            this.addEventListenerWithCleanup(clearStorageBtn, 'click', this.clearStorage.bind(this));
            
            // Add source button
            const addSourceBtn = document.getElementById('add-source-btn');
            this.addEventListenerWithCleanup(addSourceBtn, 'click', this.addDataSource.bind(this));

            // Home fields follow the tracking checkbox without waiting for Save
            const positionToggle = document.getElementById('position-file-enabled');
            this.addEventListenerWithCleanup(positionToggle, 'change',
                this.updateHomeFieldState.bind(this));
            
            // Mobile menu
            this.addEventListenerWithCleanup(elements.mobileMenuButton, 'click', this.toggleMobileMenu);
            this.addEventListenerWithCleanup(elements.mobileOverlay, 'click', this.toggleMobileMenu);
            
            // Mobile controls
            const mobileButtons = [
                ['mobile-vectors-button', this.toggleVectors.bind(this)],
                ['mobile-trails-button', this.toggleTrails.bind(this)], 
                ['mobile-airports-button', this.toggleAirports.bind(this)],
                ['mobile-navaids-button', this.toggleNavaids.bind(this)],
                ['mobile-runways-button', this.toggleRunways.bind(this)],
                ['mobile-settings-button', () => { this.toggleMobileMenu(); this.showSettings(); }],
                ['mobile-export-button', () => { this.toggleMobileMenu(); this.showExportMenu(); }]
            ];
            
            mobileButtons.forEach(([id, handler]) => {
                const element = document.getElementById(id);
                this.addEventListenerWithCleanup(element, 'click', handler);
            });
            
            // Initialize audio context on first user interaction
            const initAudio = () => {
                if (!audioContext) {
                    try {
                        audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    } catch (error) {
                        ErrorBoundary.handleError(error, 'Audio Context');
                    }
                }
            };
            this.addEventListenerWithCleanup(document, 'click', initAudio);
        },
        
        /**
         * Installs a single delegated click handler on the aircraft table body,
         * so the rows can be re-rendered freely without rebinding listeners.
         * Clicking the selected row deselects it.
         * @returns {void}
         */
        setupEventDelegation() {
            // Delegate aircraft list clicks
            this.addEventListenerWithCleanup(elements.aircraftListBody, 'click', (e) => {
                const row = e.target.closest('.aircraft-row');
                if (row) {
                    const hex = row.dataset.hex;
                    state.selectedHex = state.selectedHex === hex ? null : hex;
                    this.saveUIState();
                    UIManager.updateAircraftList();
                }
            });
        },
        
        /**
         * Wires the UI-theme and scope-theme dropdowns (desktop menus and mobile
         * selects), including the document-level click handler that closes any
         * open menu or popup.
         * @returns {void}
         */
        setupDropdowns() {
            const toggleDropdown = (menu) => {
                document.querySelectorAll('.dropdown-menu').forEach(m => {
                    if (m !== menu) m.classList.add('hidden');
                });
                menu.classList.toggle('hidden');
            };
            
            this.addEventListenerWithCleanup(elements.uiThemeButton, 'click', (e) => {
                e.stopPropagation();
                toggleDropdown(elements.uiThemeMenu);
            });
            
            this.addEventListenerWithCleanup(elements.scopeThemeButton, 'click', (e) => {
                e.stopPropagation();
                toggleDropdown(elements.scopeThemeMenu);
            });
            
            this.addEventListenerWithCleanup(document, 'click', () => {
                elements.uiThemeMenu?.classList.add('hidden');
                elements.scopeThemeMenu?.classList.add('hidden');
                if (!state.popupAircraft) {
                    elements.aircraftPopup?.classList.add('hidden');
                }
                elements.airportPopup?.classList.add('hidden');
            });
            
            this.addEventListenerWithCleanup(elements.uiThemeMenu, 'click', (e) => {
                if (e.target.dataset.theme) {
                    state.uiTheme = e.target.dataset.theme;
                    ThemeManager.applyUiTheme();
                    elements.uiThemeMenu.classList.add('hidden');
                }
            });
            
            this.addEventListenerWithCleanup(elements.scopeThemeMenu, 'click', (e) => {
                if (e.target.dataset.themeId) {
                    state.scopeThemeIndex = parseInt(e.target.dataset.themeId, 10);
                    elements.scopeThemeMenu.classList.add('hidden');
                }
            });
            
            // Mobile theme selects
            const mobileUiSelect = document.getElementById('mobile-ui-theme-select');
            const mobileScopeSelect = document.getElementById('mobile-scope-theme-select');
            
            this.addEventListenerWithCleanup(mobileUiSelect, 'change', (e) => {
                state.uiTheme = e.target.value;
                ThemeManager.applyUiTheme();
            });
            
            this.addEventListenerWithCleanup(mobileScopeSelect, 'change', (e) => {
                state.scopeThemeIndex = parseInt(e.target.value, 10);
            });
        },
        
        /**
         * Opens/closes the mobile slide-out menu and its backdrop.
         * @returns {void}
         */
        toggleMobileMenu() {
            elements.mobileMenu?.classList.toggle('active');
            elements.mobileOverlay?.classList.toggle('active');
        },
        
        /**
         * Shows/hides the right-hand panel together with its resizer, and updates
         * the button tooltip to match.
         * @returns {void}
         */
        togglePanels() {
            const hiding = !elements.rightPanel.classList.contains('hidden');
            elements.rightPanel.classList.toggle('hidden', hiding);
            elements.rightResizer.classList.toggle('hidden', hiding);
            
            const tooltip = elements.hideUiButton?.querySelector('.tooltip-text');
            if (tooltip) {
                tooltip.textContent = hiding ? 'Show Panels' : 'Hide Panels';
            }
        },
        
        /**
         * Toggles the projected speed vectors.
         * @returns {void}
         */
        toggleVectors() {
            state.showVectors = !state.showVectors;
            UIManager.updateTooltips();
            
            const mobileButton = document.getElementById('mobile-vectors-button');
            if (mobileButton) {
                mobileButton.querySelector('span').textContent = `Vectors: ${state.showVectors ? 'ON' : 'OFF'}`;
            }
        },
        
        /**
         * Toggles aircraft trail rendering.
         * @returns {void}
         */
        toggleTrails() {
            state.showTrails = !state.showTrails;
            UIManager.updateTooltips();
            
            const mobileButton = document.getElementById('mobile-trails-button');
            if (mobileButton) {
                mobileButton.querySelector('span').textContent = `Trails: ${state.showTrails ? 'ON' : 'OFF'}`;
            }
        },
        
        /**
         * Toggles airport rendering. Invalidates the static scope cache.
         * @returns {void}
         */
        toggleAirports() {
            state.showAirports = !state.showAirports;
            UIManager.updateTooltips();
            Renderer.markForRedraw();
            
            const mobileButton = document.getElementById('mobile-airports-button');
            if (mobileButton) {
                mobileButton.querySelector('span').textContent = `Airports: ${state.showAirports ? 'ON' : 'OFF'}`;
            }
        },
        
        /**
         * Toggles navaid rendering. Invalidates the static scope cache.
         * @returns {void}
         */
        toggleNavaids() {
            state.showNavaids = !state.showNavaids;
            UIManager.updateTooltips();
            Renderer.markForRedraw();
            
            const mobileButton = document.getElementById('mobile-navaids-button');
            if (mobileButton) {
                mobileButton.querySelector('span').textContent = `Navaids: ${state.showNavaids ? 'ON' : 'OFF'}`;
            }
        },
        
        /**
         * Toggles runway rendering. Invalidates the static scope cache.
         * @returns {void}
         */
        toggleRunways() {
            state.showRunways = !state.showRunways;
            UIManager.updateTooltips();
            Renderer.markForRedraw();
            
            const mobileButton = document.getElementById('mobile-runways-button');
            if (mobileButton) {
                mobileButton.querySelector('span').textContent = `Runways: ${state.showRunways ? 'ON' : 'OFF'}`;
            }
        },
        
        /**
         * Expands/collapses the aircraft list section and persists the choice.
         * @returns {void}
         */
        toggleAircraftSection() {
            state.aircraftSectionExpanded = !state.aircraftSectionExpanded;
            const section = elements.aircraftSection;
            const toggleIcon = elements.aircraftToggle?.querySelector('svg');
            
            if (state.aircraftSectionExpanded) {
                section.classList.remove('section-collapsed');
                section.classList.add('section-expanded');
                toggleIcon?.classList.remove('collapsed');
            } else {
                section.classList.remove('section-expanded');
                section.classList.add('section-collapsed');
                toggleIcon?.classList.add('collapsed');
            }
            
            this.saveUIState();
        },
        
        /**
         * Expands/collapses the metrics panel section and persists the choice.
         * @returns {void}
         */
        toggleMetricsSection() {
            state.metricsSectionExpanded = !state.metricsSectionExpanded;
            const section = elements.metricsSection;
            const toggleIcon = elements.metricsToggle?.querySelector('svg');
            
            if (state.metricsSectionExpanded) {
                section.classList.remove('section-collapsed');
                section.classList.add('section-expanded');
                toggleIcon?.classList.remove('collapsed');
            } else {
                section.classList.remove('section-expanded');
                section.classList.add('section-collapsed');
                toggleIcon?.classList.add('collapsed');
            }
            
            this.saveUIState();
        },
        
        /**
         * Fills the settings modal with the current {@link state} values and
         * shows it.
         * @returns {void}
         */
        showSettings() {
            const set = (id, value, prop = 'value') => {
                const el = document.getElementById(id);
                if (el) el[prop] = value;
            };

            set('home-lat', state.homeLat);
            set('home-lon', state.homeLon);
            set('sound-enabled', state.soundEnabled, 'checked');
            set('show-airports', state.showAirports, 'checked');
            set('show-navaids', state.showNavaids, 'checked');
            set('show-runways', state.showRunways, 'checked');
            set('min-runway-length', state.minRunwayLength);
            set('max-trail-length', state.maxTrailLength);
            set('trail-fade-time', state.trailFadeTimeMinutes);
            set('trail-width', state.trailWidth);

            // Moving receiver
            set('position-file-enabled', state.positionFileEnabled, 'checked');
            set('position-file-path', state.positionFilePath);
            set('position-poll-interval', state.positionPollIntervalMs);
            set('position-min-move', state.positionMinMoveNm);
            set('show-own-ship', state.showOwnShip, 'checked');

            // Display
            set('show-label-details', state.showLabelDetails, 'checked');
            set('aircraft-symbol-size', CONFIG.AIRCRAFT_SYMBOL_SIZE);
            set('heading-line-length', CONFIG.HEADING_LINE_LENGTH);
            set('vector-minutes', CONFIG.VECTOR_MINUTES);

            // Performance
            set('sweep-duration', CONFIG.SWEEP_DURATION_S);
            set('render-throttle', CONFIG.CANVAS_RENDER_THROTTLE_MS);
            set('ui-update-interval', CONFIG.UI_UPDATE_INTERVAL_MS);
            set('max-airports-display', CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY);
            set('smoothing-factor', CONFIG.SMOOTHING_FACTOR);

            this.populateThemeSelects();
            this.updateHomeFieldState();
            this.updateDataSourcesList();
            PositionManager.setStatus(state.positionFileStatus.kind,
                                      state.positionFileStatus.message ||
                                      'Disabled — using the configured home position.');
            elements.settingsModal.classList.remove('hidden');
        },

        /**
         * Fills the settings-panel theme selects from {@link UI_THEMES} and
         * {@link SCOPE_THEMES} and selects the active entries.
         *
         * The top-bar dropdowns remain the quick way to change theme; these
         * exist so every setting is reachable from one place.
         * @returns {void}
         */
        populateThemeSelects() {
            const uiSelect = document.getElementById('settings-ui-theme');
            const scopeSelect = document.getElementById('settings-scope-theme');

            if (uiSelect && !uiSelect.options.length) {
                uiSelect.innerHTML = UI_THEMES
                    .map(t => `<option value="${t.key}">${t.group} — ${t.name}</option>`)
                    .join('');
            }
            if (scopeSelect && !scopeSelect.options.length) {
                scopeSelect.innerHTML = SCOPE_THEMES
                    .map((t, i) => `<option value="${i}">${t.name}</option>`)
                    .join('');
            }
            if (uiSelect) uiSelect.value = state.uiTheme;
            if (scopeSelect) scopeSelect.value = String(state.scopeThemeIndex);
        },

        /**
         * Disables the manual home-position fields while the POSITION file is
         * driving them, so the panel cannot promise an edit it will overwrite on
         * the next poll.
         * @returns {void}
         */
        updateHomeFieldState() {
            const tracking = !!document.getElementById('position-file-enabled')?.checked;
            ['home-lat', 'home-lon'].forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.readOnly = tracking;
                el.style.opacity = tracking ? '0.5' : '';
                el.title = tracking
                    ? 'Driven by the POSITION file while tracking is enabled'
                    : '';
            });
        },
        
        /**
         * Re-renders the data-source editor rows, each with a live URL validity
         * badge from {@link URLValidator.isValidDataSourceUrl}.
         * @returns {void}
         */
        updateDataSourcesList() {
            const sourcesDiv = document.getElementById('data-sources-list');
            sourcesDiv.innerHTML = state.dataSources.map((source, i) => `
                <div class="border p-2 mb-2" style="border-color: var(--color-border);">
                    <input type="text" value="${URLValidator.sanitizeUrl(source.url)}" placeholder="URL" class="w-full px-2 py-1 border mb-2" data-source-index="${i}" data-field="url" style="background-color: var(--color-bg-primary); border-color: var(--color-border);">
                    <input type="text" value="${source.name || ''}" placeholder="Name" class="w-full px-2 py-1 border mb-2" data-source-index="${i}" data-field="name" style="background-color: var(--color-bg-primary); border-color: var(--color-border);">
                    <div class="flex justify-between items-center">
                        <label class="flex items-center gap-2">
                            <input type="checkbox" ${source.enabled ? 'checked' : ''} data-source-index="${i}" data-field="enabled">
                            <span>Enabled</span>
                        </label>
                        <div class="text-xs ${URLValidator.isValidDataSourceUrl(source.url) ? 'text-green-500' : 'text-red-500'}">
                            ${URLValidator.isValidDataSourceUrl(source.url) ? '✓ Valid' : '✗ Invalid URL'}
                        </div>
                        ${state.dataSources.length > 1 ? `<button class="btn text-red-500" onclick="EventHandlers.removeDataSource(${i})">Remove</button>` : ''}
                    </div>
                </div>
            `).join('');
        },
        
        /**
         * Appends a blank, disabled data source row to the settings modal.
         * @returns {void}
         */
        addDataSource() {
            state.dataSources.push({
                url: '',
                name: `Source ${state.dataSources.length + 1}`,
                enabled: false
            });
            this.updateDataSourcesList();
        },
        
        /**
         * Removes a data source, refusing to delete the last remaining one.
         * Exposed on `window.EventHandlers` for the inline Remove buttons.
         * @param {number} index Index into `state.dataSources`.
         * @returns {void}
         */
        removeDataSource(index) {
            if (state.dataSources.length > 1) {
                state.dataSources.splice(index, 1);
                this.updateDataSourcesList();
            }
        },
        
        /**
         * Reads every settings-modal field back into {@link state}, validates the
         * data sources (at least one enabled source must have a valid URL) and
         * persists the result. Clears `displayedAircraft` so the new home
         * position and range take effect on the next sweep.
         * @returns {void}
         */
        saveSettings() {
            try {
                state.homeLat = parseFloat(document.getElementById('home-lat').value) || CONFIG.DEFAULT_HOME_LAT;
                state.homeLon = parseFloat(document.getElementById('home-lon').value) || CONFIG.DEFAULT_HOME_LON;
                state.soundEnabled = document.getElementById('sound-enabled').checked;
                state.showAirports = document.getElementById('show-airports').checked;
                state.showNavaids = document.getElementById('show-navaids').checked;
                state.showRunways = document.getElementById('show-runways').checked;
                state.minRunwayLength = parseInt(document.getElementById('min-runway-length').value) || CONFIG.AIRPORT_DISPLAY.MIN_RUNWAY_LENGTH_FT;
                state.maxTrailLength = parseInt(document.getElementById('max-trail-length').value) || CONFIG.MAX_TRAIL_LENGTH;
                state.trailFadeTimeMinutes = parseInt(document.getElementById('trail-fade-time').value) || CONFIG.TRAIL_FADE_TIME_MINUTES;
                state.trailWidth = parseInt(document.getElementById('trail-width').value) || 2;

                const num = (id, fallback, min, max) => {
                    const el = document.getElementById(id);
                    if (!el) return fallback;
                    const v = parseFloat(el.value);
                    if (!Number.isFinite(v)) return fallback;
                    return Math.min(max, Math.max(min, v));
                };
                const bool = (id, fallback) =>
                    document.getElementById(id)?.checked ?? fallback;

                // Moving receiver
                const wasTracking = state.positionFileEnabled;
                const previousPath = state.positionFilePath;
                const previousInterval = state.positionPollIntervalMs;

                state.positionFileEnabled = bool('position-file-enabled', state.positionFileEnabled);
                state.positionFilePath =
                    (document.getElementById('position-file-path')?.value || '').trim()
                    || CONFIG.POSITION_FILE.PATH;
                state.positionPollIntervalMs = num('position-poll-interval',
                    CONFIG.POSITION_FILE.POLL_INTERVAL_MS, 250, 60000);
                state.positionMinMoveNm = num('position-min-move',
                    CONFIG.POSITION_FILE.MIN_MOVE_NM, 0, 5);
                state.showOwnShip = bool('show-own-ship', state.showOwnShip);

                // Display
                state.showLabelDetails = bool('show-label-details', state.showLabelDetails);
                CONFIG.AIRCRAFT_SYMBOL_SIZE = num('aircraft-symbol-size', CONFIG.AIRCRAFT_SYMBOL_SIZE, 1, 12);
                CONFIG.HEADING_LINE_LENGTH = num('heading-line-length', CONFIG.HEADING_LINE_LENGTH, 0, 60);
                CONFIG.VECTOR_MINUTES = num('vector-minutes', CONFIG.VECTOR_MINUTES, 0, 30);

                // Performance
                CONFIG.SWEEP_DURATION_S = num('sweep-duration', CONFIG.SWEEP_DURATION_S, 0, 30);
                CONFIG.CANVAS_RENDER_THROTTLE_MS = num('render-throttle', CONFIG.CANVAS_RENDER_THROTTLE_MS, 8, 200);
                CONFIG.UI_UPDATE_INTERVAL_MS = num('ui-update-interval', CONFIG.UI_UPDATE_INTERVAL_MS, 100, 5000);
                CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY = num('max-airports-display',
                    CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY, 1, 500);
                CONFIG.SMOOTHING_FACTOR = num('smoothing-factor', CONFIG.SMOOTHING_FACTOR, 0, 0.9);

                // Theme
                const uiSelect = document.getElementById('settings-ui-theme');
                if (uiSelect && uiSelect.value && uiSelect.value !== state.uiTheme) {
                    state.uiTheme = uiSelect.value;
                    ThemeManager.applyUiTheme();
                }
                const scopeSelect = document.getElementById('settings-scope-theme');
                if (scopeSelect && scopeSelect.value !== '') {
                    state.scopeThemeIndex = parseInt(scopeSelect.value, 10) || 0;
                }
                
                // Validate and save data sources
                let hasValidSource = false;
                document.querySelectorAll('[data-source-index]').forEach(input => {
                    const index = parseInt(input.dataset.sourceIndex);
                    const field = input.dataset.field;
                    if (state.dataSources[index]) {
                        if (field === 'enabled') {
                            state.dataSources[index][field] = input.checked;
                        } else if (field === 'url') {
                            const sanitizedUrl = URLValidator.sanitizeUrl(input.value);
                            state.dataSources[index][field] = sanitizedUrl;
                            if (state.dataSources[index].enabled && URLValidator.isValidDataSourceUrl(sanitizedUrl)) {
                                hasValidSource = true;
                            }
                        } else {
                            state.dataSources[index][field] = input.value;
                        }
                    }
                });
                
                if (!hasValidSource) {
                    ErrorBoundary.showWarning('At least one valid and enabled data source is required');
                    return;
                }

                if (state.positionFileEnabled && !state.positionFilePath) {
                    ErrorBoundary.showWarning('A POSITION file path is required while tracking is enabled');
                    return;
                }
                
                // Save to localStorage with debouncing if enabled
                const settings = {
                    homeLat: state.homeLat,
                    homeLon: state.homeLon,
                    positionFileEnabled: state.positionFileEnabled,
                    positionFilePath: state.positionFilePath,
                    positionPollIntervalMs: state.positionPollIntervalMs,
                    positionMinMoveNm: state.positionMinMoveNm,
                    showOwnShip: state.showOwnShip,
                    showLabelDetails: state.showLabelDetails,
                    scopeThemeIndex: state.scopeThemeIndex,
                    display: {
                        aircraftSymbolSize: CONFIG.AIRCRAFT_SYMBOL_SIZE,
                        headingLineLength: CONFIG.HEADING_LINE_LENGTH,
                        vectorMinutes: CONFIG.VECTOR_MINUTES
                    },
                    performance: {
                        sweepDurationS: CONFIG.SWEEP_DURATION_S,
                        renderThrottleMs: CONFIG.CANVAS_RENDER_THROTTLE_MS,
                        uiUpdateIntervalMs: CONFIG.UI_UPDATE_INTERVAL_MS,
                        maxAirportsDisplay: CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY,
                        smoothingFactor: CONFIG.SMOOTHING_FACTOR
                    },
                    soundEnabled: state.soundEnabled,
                    dataSources: state.dataSources,
                    showAirports: state.showAirports,
                    showNavaids: state.showNavaids,
                    showRunways: state.showRunways,
                    minRunwayLength: state.minRunwayLength,
                    maxTrailLength: state.maxTrailLength,
                    trailFadeTimeMinutes: state.trailFadeTimeMinutes,
                    trailWidth: state.trailWidth,
                    aircraftSectionExpanded: state.aircraftSectionExpanded,
                    metricsSectionExpanded: state.metricsSectionExpanded,
                    selectedHex: state.selectedHex
                };
                
                if (CONFIG.PERFORMANCE.LOCALSTORAGE_DEBOUNCE_MS) {
                    this.debouncedSaveSettings(settings);
                } else {
                    localStorage.setItem('adsbScope_settings', JSON.stringify(settings));
                }
                
                elements.settingsModal.classList.add('hidden');

                // Restart position tracking when it was switched on or off, or
                // its file or cadence changed.
                if (state.positionFileEnabled !== wasTracking ||
                    state.positionFilePath !== previousPath ||
                    state.positionPollIntervalMs !== previousInterval) {
                    PositionManager.start();
                }

                // The home position, range or projection may all have changed.
                MathUtils._cache.clear();
                state.staticEpoch++;
                Renderer.markForRedraw();
                
                // Clear displayed aircraft to force refresh
                state.displayedAircraft = {};
                
                if (!state.dataLoaded) {
                    CSVDataManager.loadAllData();
                }
                
                ErrorBoundary.showWarning('Settings saved successfully');
            } catch (error) {
                ErrorBoundary.handleError(error, 'Settings Save');
            }
        },
        
        /**
         * Debounced writer for the `adsbScope_settings` key, so rapid saves
         * collapse into a single localStorage write.
         * @type {function(Object): void}
         */
        debouncedSaveSettings: (() => {
            let timeout;
            return (settings) => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    localStorage.setItem('adsbScope_settings', JSON.stringify(settings));
                }, CONFIG.PERFORMANCE.LOCALSTORAGE_DEBOUNCE_MS);
            };
        })(),
        
        /**
         * Persists the lightweight UI state (panel expansion, selected aircraft,
         * current range) that changes far more often than the settings blob.
         * @returns {void}
         */
        saveUIState() {
            try {
                const uiState = {
                    aircraftSectionExpanded: state.aircraftSectionExpanded,
                    metricsSectionExpanded: state.metricsSectionExpanded,
                    selectedHex: state.selectedHex,
                    maxRangeNm: state.maxRangeNm
                };
                
                if (CONFIG.PERFORMANCE.LOCALSTORAGE_DEBOUNCE_MS) {
                    this.debouncedSaveUIState(uiState);
                } else {
                    localStorage.setItem('adsbScope_uiState', JSON.stringify(uiState));
                }
            } catch (error) {
                ErrorBoundary.handleError(error, 'UI State Save');
            }
        },
        
        /**
         * Debounced writer for the `adsbScope_uiState` key.
         * @type {function(Object): void}
         */
        debouncedSaveUIState: (() => {
            let timeout;
            return (uiState) => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    localStorage.setItem('adsbScope_uiState', JSON.stringify(uiState));
                }, CONFIG.PERFORMANCE.LOCALSTORAGE_DEBOUNCE_MS);
            };
        })(),
        
        /**
         * Discards every stored setting and reloads, so the next start comes
         * from {@link CONFIG} alone.
         *
         * This is the only way back to the `config.js` defaults once settings
         * have been saved, since stored values shadow them on every load.
         * @returns {void}
         */
        clearStorage() {
            if (!window.confirm(
                    'Discard all saved settings and reload using the config.js defaults?')) {
                return;
            }

            try {
                ['adsbScope_settings', 'adsbScope_uiState', 'adsbScope_uiTheme']
                    .forEach(key => localStorage.removeItem(key));
            } catch (error) {
                ErrorBoundary.handleError(error, 'Clear Storage');
                return;
            }

            elements.settingsModal?.classList.add('hidden');
            ErrorBoundary.showWarning('Stored settings cleared — reloading');
            const timeout = setTimeout(() => window.location.reload(), 400);
            state.timeouts.push(timeout);
        },

        /**
         * Prompts for an export format and delegates to {@link ExportManager}.
         * @returns {void}
         */
        showExportMenu() {
            const options = ['CSV', 'KML', 'Statistics'];
            const choice = prompt(`Export format?\n1. CSV\n2. KML\n3. Statistics\nEnter number (1-3):`);
            
            switch(choice) {
                case '1':
                    ExportManager.exportCSV();
                    break;
                case '2':
                    ExportManager.exportKML();
                    break;
                case '3':
                    ExportManager.exportStatistics();
                    break;
                default:
                    if (choice !== null) {
                        ErrorBoundary.showWarning('Invalid choice. Please select 1, 2, or 3.');
                    }
            }
        },
        
        /**
         * Mouse-wheel zoom. Scrolling up widens the range, down narrows it, in
         * {@link CONFIG.RANGE_STEP_NM} increments clamped to
         * `MIN_RANGE_NM`/`MAX_RANGE_NM`. Forces a static-layer redraw.
         * @param {WheelEvent} e
         * @returns {void}
         */
        handleMouseWheel(e) {
            e.preventDefault();
            const oldRange = state.maxRangeNm;
            if (e.deltaY < 0) {
                state.maxRangeNm = Math.min(CONFIG.MAX_RANGE_NM, state.maxRangeNm + CONFIG.RANGE_STEP_NM);
            } else {
                state.maxRangeNm = Math.max(CONFIG.MIN_RANGE_NM, state.maxRangeNm - CONFIG.RANGE_STEP_NM);
            }
            
            if (oldRange !== state.maxRangeNm) {
                state.lastRangeNm = oldRange;
                this.saveUIState();
                Renderer.markForRedraw();
            }
        },
        
        /**
         * Turns a resizer element into a horizontal drag handle for a side panel,
         * clamped to {@link CONFIG.MIN_PANEL_WIDTH}.
         * @param {?HTMLElement} panel Panel being resized.
         * @param {?HTMLElement} resizer Grab handle.
         * @returns {void}
         */
        makeResizable(panel, resizer) {
            if (!panel || !resizer) return;
            
            const handleMouseMove = (e) => {
                const newWidth = document.body.clientWidth - e.clientX;
                panel.style.width = `${Math.max(CONFIG.MIN_PANEL_WIDTH, newWidth)}px`;
            };
            
            const handleMouseUp = () => {
                document.body.style.cursor = 'default';
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };
            
            this.addEventListenerWithCleanup(resizer, 'mousedown', () => {
                document.body.style.cursor = 'col-resize';
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
            });
        },
        
        /**
         * Canvas click handler. Airports are hit-tested first (within
         * `SYMBOL_SIZE + 5` px), then aircraft within
         * {@link CONFIG.CLICK_RADIUS_PX}; the nearest one wins. Selecting an
         * aircraft opens the detail popup and starts a 100 ms interval that keeps
         * the popup pinned to the moving target. Clicking empty space closes it.
         * @param {MouseEvent} e
         * @returns {void}
         */
        handleCanvasClick(e) {
            e.stopPropagation();

            // Range rings first: they are the coarsest target, but only claim
            // the click when nothing more specific is under the cursor.
            if (this.handleRangeRingClick(e)) return;
            
            // Check for airport clicks first
            if (state.showAirports) {
                const cx = elements.canvas.width / 2;
                const cy = elements.canvas.height / 2;
                const radius = Math.min(cx, cy) - CONFIG.CANVAS_PADDING;
                
                const airports = CSVDataManager.getAirportsInRange(state.homeLat, state.homeLon, state.maxRangeNm);
                for (const airport of airports) {
                    const pos = MathUtils.latLonToScreen(airport.lat, airport.lon, state.maxRangeNm, cx, cy, radius);
                    if (pos) {
                        const dist = Math.hypot(e.offsetX - pos.x, e.offsetY - pos.y);
                        if (dist < CONFIG.AIRPORT_DISPLAY.SYMBOL_SIZE + 5) {
                            UIManager.showAirportPopup(airport, e.offsetX, e.offsetY);
                            return;
                        }
                    }
                }
            }
            
            // Check for aircraft clicks
            let clickedHex = null;
            let closestDist = CONFIG.CLICK_RADIUS_PX;
            
            for (const hex in state.displayedAircraft) {
                const ac = state.displayedAircraft[hex];
                const dist = Math.hypot(e.offsetX - ac.displayPos.x, e.offsetY - ac.displayPos.y);
                if (dist < closestDist) {
                    clickedHex = hex;
                    closestDist = dist;
                }
            }
            
            if (clickedHex && state.displayedAircraft[clickedHex]) {
                const acData = state.displayedAircraft[clickedHex].data;
                const popupContent = Object.entries(acData)
                    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                    .join('\n');
                
                elements.aircraftPopup.textContent = popupContent;
                
                const popupWidth = 300;
                const popupHeight = 200;
                const canvasRect = elements.canvas.getBoundingClientRect();
                
                let popupX = e.offsetX + 15;
                let popupY = e.offsetY + 15;
                
                if (popupX + popupWidth > canvasRect.width) {
                    popupX = e.offsetX - popupWidth - 15;
                }
                if (popupY + popupHeight > canvasRect.height) {
                    popupY = e.offsetY - popupHeight - 15;
                }
                
                elements.aircraftPopup.style.left = `${popupX}px`;
                elements.aircraftPopup.style.top = `${popupY}px`;
                elements.aircraftPopup.classList.remove('hidden');
                
                state.popupAircraft = clickedHex;
                if (state.popupUpdateInterval) {
                    clearInterval(state.popupUpdateInterval);
                }
                const interval = setInterval(() => UIManager.updatePopup(), 100);
                state.intervals.push(interval);
                state.popupUpdateInterval = interval;
            } else {
                elements.aircraftPopup.classList.add('hidden');
                state.popupAircraft = null;
                if (state.popupUpdateInterval) {
                    clearInterval(state.popupUpdateInterval);
                    state.popupUpdateInterval = null;
                }
            }
        },
        
        /**
         * Zooms to a range ring when the click lands on one.
         *
         * The four rings mark a quarter, half, three quarters and all of the
         * current range, so clicking one sets the range to the distance that
         * ring represents — a fast way down from 200 nm to 50 nm.
         *
         * Yields to aircraft and airports: a click within
         * {@link CONFIG.CLICK_RADIUS_PX} of a target is a selection, not a zoom.
         * @param {MouseEvent} e Canvas click.
         * @returns {boolean} True if the click was consumed as a zoom.
         */
        handleRangeRingClick(e) {
            const cx = elements.canvas.width / 2;
            const cy = elements.canvas.height / 2;
            const radius = Math.min(cx, cy) - CONFIG.CANVAS_PADDING;
            if (!(radius > 0)) return false;

            const fromCentre = Math.hypot(e.offsetX - cx, e.offsetY - cy);

            // Anything close to a drawn target belongs to that target.
            for (const hex in state.displayedAircraft) {
                const ac = state.displayedAircraft[hex];
                if (!ac.displayPos) continue;
                if (Math.hypot(e.offsetX - ac.displayPos.x, e.offsetY - ac.displayPos.y)
                        < CONFIG.CLICK_RADIUS_PX) {
                    return false;
                }
            }
            if (state.showAirports) {
                const airports = CSVDataManager.getAirportsInRange(
                    state.homeLat, state.homeLon, state.maxRangeNm);
                for (const airport of airports) {
                    const pos = MathUtils.latLonToScreen(
                        airport.lat, airport.lon, state.maxRangeNm, cx, cy, radius);
                    if (pos && Math.hypot(e.offsetX - pos.x, e.offsetY - pos.y)
                            < CONFIG.AIRPORT_DISPLAY.SYMBOL_SIZE + 5) {
                        return false;
                    }
                }
            }

            for (let i = 1; i <= 4; i++) {
                const ringRadius = radius * (i / 4);
                if (Math.abs(fromCentre - ringRadius) > EventHandlers.RING_CLICK_TOLERANCE_PX) {
                    continue;
                }

                const target = Math.round(
                    (state.maxRangeNm * (i / 4)) / CONFIG.RANGE_STEP_NM) * CONFIG.RANGE_STEP_NM;
                const clamped = Math.min(CONFIG.MAX_RANGE_NM,
                                         Math.max(CONFIG.MIN_RANGE_NM, target));

                if (clamped !== state.maxRangeNm) {
                    state.lastRangeNm = state.maxRangeNm;
                    state.maxRangeNm = clamped;
                    this.saveUIState();
                    Renderer.markForRedraw();
                }
                return true;
            }

            return false;
        },

        /**
         * How near a range ring a click has to land to count as a ring click.
         * @type {number}
         */
        RING_CLICK_TOLERANCE_PX: 8,

        /**
         * Global keyboard shortcut handler.
         *
         * `H` or `?` help, `Space` pause, `+`/`-` range, `R` reset view,
         * `M` cycle all/military/civilian filter, `V` vectors, `T` trails,
         * `A` airports, `N` navaids, `W` runways, `D` extended labels,
         * `I` debug overlay, `S` settings, `Escape` close modals.
         *
         * Returns early when the event came from a form control, so typing a
         * latitude or a URL in the settings panel does not also drive the scope.
         * @param {KeyboardEvent} e
         * @returns {void}
         */
        handleKeydown(e) {
            // Shortcuts must not fire while the user is filling in the settings
            // form: typing a latitude would otherwise change the range twice.
            const target = e.target;
            if (target && (target.tagName === 'INPUT' ||
                           target.tagName === 'TEXTAREA' ||
                           target.tagName === 'SELECT' ||
                           target.isContentEditable)) {
                return;
            }

            switch(e.key.toLowerCase()) {
                case 'd':
                    state.showLabelDetails = !state.showLabelDetails;
                    Renderer.markForRedraw();
                    UIManager.updateTooltips();
                    break;
                case 'i':
                    state.showDebugInfo = !state.showDebugInfo;
                    break;
                case ' ':
                    e.preventDefault();
                    state.isPaused = !state.isPaused;
                    break;
                case 'h':
                case '?':
                    elements.helpModal?.classList.remove('hidden');
                    break;
                case 'escape':
                    elements.helpModal?.classList.add('hidden');
                    elements.settingsModal?.classList.add('hidden');
                    break;
                case '+':
                case '=':
                    state.maxRangeNm = Math.min(CONFIG.MAX_RANGE_NM, state.maxRangeNm + CONFIG.RANGE_STEP_NM);
                    EventHandlers.saveUIState();
                    break;
                case '-':
                case '_':
                    state.maxRangeNm = Math.max(CONFIG.MIN_RANGE_NM, state.maxRangeNm - CONFIG.RANGE_STEP_NM);
                    EventHandlers.saveUIState();
                    break;
                case 'm':
                    const filters = ['all', 'military', 'civilian'];
                    state.aircraftFilter = filters[(filters.indexOf(state.aircraftFilter) + 1) % filters.length];
                    break;
                case 'v':
                    EventHandlers.toggleVectors();
                    break;
                case 't':
                    EventHandlers.toggleTrails();
                    break;
                case 'a':
                    EventHandlers.toggleAirports();
                    break;
                case 'n':
                    EventHandlers.toggleNavaids();
                    break;
                case 'w':
                    EventHandlers.toggleRunways();
                    break;
                case 'r':
                    EventHandlers.resetView();
                    break;
                case 's':
                    EventHandlers.showSettings();
                    break;
            }
        },

        /**
         * Returns the scope to its configured defaults: startup range, no
         * selected aircraft, unpaused, filter back to `all`, popups closed.
         *
         * Deliberately leaves the home position, themes and layer toggles
         * alone — this resets the *view*, not the configuration.
         * @returns {void}
         */
        resetView() {
            state.maxRangeNm = CONFIG.DEFAULT_RANGE_NM;
            state.aircraftFilter = 'all';
            state.selectedHex = null;
            state.isPaused = false;

            state.popupAircraft = null;
            if (state.popupUpdateInterval) {
                clearInterval(state.popupUpdateInterval);
                state.popupUpdateInterval = null;
            }
            elements.aircraftPopup?.classList.add('hidden');
            elements.airportPopup?.classList.add('hidden');

            this.saveUIState();
            Renderer.markForRedraw();
            UIManager.updateAircraftList();
        }
    };

    /**
     * The requestAnimationFrame driver. Everything that must happen per
     * frame — sweep advance, aircraft state update, painting and throttled UI
     * refresh — is sequenced here.
     * @namespace ScopeLoop
     * @property {?number} animationId Handle of the pending frame, if any.
     * @property {number} lastFrameTime Timestamp of the last rendered frame.
     */
    const ScopeLoop = {
        animationId: null,
        lastFrameTime: 0,
        
        /**
         * Schedules the first frame; {@link ScopeLoop.update} re-schedules itself
         * from then on.
         * @returns {void}
         */
        start() {
            this.animationId = requestAnimationFrame((time) => this.update(time));
        },
        
        /**
         * Cancels the pending animation frame and halts the loop.
         * @returns {void}
         */
        stop() {
            if (this.animationId) {
                cancelAnimationFrame(this.animationId);
                this.animationId = null;
            }
        },
        
        /**
         * One frame of the render loop. Throttles to
         * {@link CONFIG.CANVAS_RENDER_THROTTLE_MS}, resizes the canvas when the
         * container changes, advances the sweep angle, repaints the scope,
         * aircraft and sweep, refreshes the side panels at the slower
         * {@link CONFIG.UI_UPDATE_INTERVAL_MS} cadence and recomputes FPS once a
         * second. Errors are caught so a single bad frame cannot kill the loop.
         * @param {DOMHighResTimeStamp} time Timestamp supplied by rAF.
         * @returns {void}
         */
        update(time) {
            try {
                // Frame rate throttling
                const deltaTime = time - this.lastFrameTime;
                if (deltaTime < CONFIG.CANVAS_RENDER_THROTTLE_MS) {
                    this.animationId = requestAnimationFrame((time) => this.update(time));
                    return;
                }
                this.lastFrameTime = time;
                
                const w = elements.canvasContainer.clientWidth;
                const h = elements.canvasContainer.clientHeight;
                
                if (w <= 0 || h <= 0) {
                    this.animationId = requestAnimationFrame((time) => this.update(time));
                    return;
                }
                
                // Only resize canvas if dimensions changed
                if (elements.canvas.width !== w || elements.canvas.height !== h) {
                    elements.canvas.width = w;
                    elements.canvas.height = h;
                    
                    // Reinitialize offscreen canvas if needed
                    if (canvasRenderer && canvasRenderer.initOffscreenCanvas) {
                        canvasRenderer.offscreenCanvas = null;
                        canvasRenderer.initOffscreenCanvas();
                    }
                    
                    Renderer.markForRedraw();
                }
                
                const cx = w / 2;
                const cy = h / 2;
                const radius = Math.min(cx, cy) - CONFIG.CANVAS_PADDING;
                
                // Update sweep angle
                state.prevSweepAngle = state.sweepAngle;
                if (!state.isPaused) {
                    state.sweepAngle = (time / 1000 * (360 / CONFIG.SWEEP_DURATION_S)) % 360;
                    AircraftStateManager.updateAircraftState(cx, cy, radius);
                }
                
                // Only render if needed or forced
                const shouldRender = Renderer.needsRedraw || 
                                   !state.isPaused || 
                                   (time - state.lastRenderTime) > 100;
                
                if (shouldRender) {
                    Renderer.drawScope(cx, cy, radius);
                    Renderer.drawAircraft(w, cx, cy, radius);
                    Renderer.drawOwnShip(cx, cy);
                    Renderer.drawSweep(cx, cy, radius);
                    Renderer.needsRedraw = false;
                    state.lastRenderTime = time;
                    state.frameCount++;
                }
                
                // Update UI at reduced frequency
                if (time - state.lastUiUpdateTime > CONFIG.UI_UPDATE_INTERVAL_MS) {
                    UIManager.updateAircraftList();
                    UIManager.updateMetricsPanel();
                    UIManager.updateScopeStatus();
                    UIManager.updateTooltips();
                    state.lastUiUpdateTime = time;
                }
                
                // Update paused overlay
                if (elements.pausedText) {
                    elements.pausedText.classList.toggle('hidden', !state.isPaused);
                }
                // DEBUG
                // Calculate FPS once per second
                const now = performance.now();
                if (now - state.lastFpsUpdateTime > 1000) {
                    state.fps = state.frameCount;
                    state.frameCount = 0;
                    state.lastFpsUpdateTime = now;
                }

                // Draw debug info if enabled
                Renderer.drawDebugInfo(elements.ctx);
                // DEBUG
                // Continue loop
                this.animationId = requestAnimationFrame((time) => this.update(time));
            } catch (error) {
                ErrorBoundary.handleError(error, 'Render Loop');
                // Continue loop even after error
                this.animationId = requestAnimationFrame((time) => this.update(time));
            }
        }
    };

    /**
     * Application bootstrapper. Owns the startup sequence and the matching
     * teardown, and is the only module that talks to localStorage on load.
     * @namespace App
     */
    const App = {
        /**
         * Boots the application: restores settings, builds the theme menus and
         * shortcut bar, wires up every event listener, schedules memory cleanup,
         * loads the airport/navaid/runway CSVs, starts the polling interval and
         * kicks off the render loop.
         *
         * Runs on `DOMContentLoaded` (or immediately if the DOM is already
         * parsed). Any failure is contained by {@link ErrorBoundary}.
         * @returns {void}
         */
        init() {
            try {
                // Set up page title and version
                document.title = `ADSB Radarscope | v${CONFIG.VERSION} | by dustsignal`;
                if (elements.versionDisplay) {
                    elements.versionDisplay.innerHTML = 
                        `<a href="https://github.com/dustsignal/adsb-scope" target="_blank" rel="noopener noreferrer" class="hover:underline">v${CONFIG.VERSION}</a>`;
                }
                
                // Load saved settings
                this.loadSettings();
                
                // Initialize theme menus
                this.initializeThemeMenus();
                
                // Set up UI components
                UIManager.createShortcutBar();
                ThemeManager.applyUiTheme();
                
                // Initialize tooltip manager
                TooltipManager.init();
                
                // Initialize collapsible sections
                this.initializeCollapsibleSections();
                
                // Initialize event handlers
                EventHandlers.initializeEventListeners();
                
                // Set up memory management
                MemoryManager.scheduleCleanup();
                
                // Load CSV data
                CSVDataManager.loadAllData();
                
                // Begin tracking a moving receiver, if configured
                PositionManager.start();
                
                // Start data fetching with network optimization
                DataManager.fetchData();
                const fetchInterval = setInterval(() => DataManager.fetchData(), CONFIG.FETCH_INTERVAL_MS);
                state.intervals.push(fetchInterval);
                
                // Start render loop
                ScopeLoop.start();
                
                // Global function for removing data sources
                window.EventHandlers = EventHandlers;
                
                console.log(`ADSB Radarscope v${CONFIG.VERSION} initialized successfully with performance optimizations`);
            } catch (error) {
                ErrorBoundary.handleError(error, 'Application Initialization');
            }
        },
        
        /**
         * Restores state from the three localStorage keys written by the app:
         * `adsbScope_settings`, `adsbScope_uiState` and `adsbScope_uiTheme`.
         * Booleans are compared strictly so a stale truthy value cannot enable
         * a feature the user turned off. Falls back to {@link CONFIG} defaults.
         *
         * Also restores the moving-receiver settings and the display and
         * performance values, which live on {@link CONFIG} because the rest of
         * the code reads them from there directly.
         * @returns {void}
         */
        loadSettings() {
            try {
                // Load main settings
                const saved = localStorage.getItem('adsbScope_settings');
                if (saved) {
                    const settings = JSON.parse(saved);
                    state.homeLat = settings.homeLat || CONFIG.DEFAULT_HOME_LAT;
                    state.homeLon = settings.homeLon || CONFIG.DEFAULT_HOME_LON;
                    
                    // Stricter boolean checks to prevent incorrect truthy values from storage.
                    state.soundEnabled = settings.soundEnabled === true;
                    state.showAirports = settings.showAirports === true;
                    state.showNavaids = settings.showNavaids === true;
                    state.showRunways = settings.showRunways !== false; // Default to true

                    state.dataSources = settings.dataSources || state.dataSources;
                    state.minRunwayLength = settings.minRunwayLength || CONFIG.AIRPORT_DISPLAY.MIN_RUNWAY_LENGTH_FT;
                    state.maxTrailLength = settings.maxTrailLength || CONFIG.MAX_TRAIL_LENGTH;
                    state.trailFadeTimeMinutes = settings.trailFadeTimeMinutes || CONFIG.TRAIL_FADE_TIME_MINUTES;
                    state.trailWidth = settings.trailWidth || 2;
                    state.aircraftSectionExpanded = settings.aircraftSectionExpanded !== undefined ? settings.aircraftSectionExpanded : true;
                    state.metricsSectionExpanded = settings.metricsSectionExpanded !== undefined ? settings.metricsSectionExpanded : true;
                    state.selectedHex = settings.selectedHex || null;

                    state.positionFileEnabled = settings.positionFileEnabled === true;
                    state.positionFilePath = settings.positionFilePath || CONFIG.POSITION_FILE.PATH;
                    state.positionPollIntervalMs = settings.positionPollIntervalMs ||
                        CONFIG.POSITION_FILE.POLL_INTERVAL_MS;
                    state.positionMinMoveNm = typeof settings.positionMinMoveNm === 'number'
                        ? settings.positionMinMoveNm : CONFIG.POSITION_FILE.MIN_MOVE_NM;
                    state.showOwnShip = settings.showOwnShip !== false;
                    state.showLabelDetails = settings.showLabelDetails !== false;
                    if (typeof settings.scopeThemeIndex === 'number' &&
                        settings.scopeThemeIndex >= 0 &&
                        settings.scopeThemeIndex < SCOPE_THEMES.length) {
                        state.scopeThemeIndex = settings.scopeThemeIndex;
                    }

                    // Display and performance settings live on CONFIG, which the
                    // rest of the code reads directly.
                    const d = settings.display || {};
                    if (typeof d.aircraftSymbolSize === 'number') CONFIG.AIRCRAFT_SYMBOL_SIZE = d.aircraftSymbolSize;
                    if (typeof d.headingLineLength === 'number') CONFIG.HEADING_LINE_LENGTH = d.headingLineLength;
                    if (typeof d.vectorMinutes === 'number') CONFIG.VECTOR_MINUTES = d.vectorMinutes;

                    const perf = settings.performance || {};
                    if (typeof perf.sweepDurationS === 'number') CONFIG.SWEEP_DURATION_S = perf.sweepDurationS;
                    if (typeof perf.renderThrottleMs === 'number') CONFIG.CANVAS_RENDER_THROTTLE_MS = perf.renderThrottleMs;
                    if (typeof perf.uiUpdateIntervalMs === 'number') CONFIG.UI_UPDATE_INTERVAL_MS = perf.uiUpdateIntervalMs;
                    if (typeof perf.maxAirportsDisplay === 'number') CONFIG.AIRPORT_DISPLAY.MAX_AIRPORTS_DISPLAY = perf.maxAirportsDisplay;
                    if (typeof perf.smoothingFactor === 'number') CONFIG.SMOOTHING_FACTOR = perf.smoothingFactor;
                }
                
                // Load UI state
                const savedUiState = localStorage.getItem('adsbScope_uiState');
                if (savedUiState) {
                    const uiState = JSON.parse(savedUiState);
                    state.maxRangeNm = uiState.maxRangeNm || CONFIG.DEFAULT_RANGE_NM;
                    state.aircraftSectionExpanded = uiState.aircraftSectionExpanded !== undefined ? uiState.aircraftSectionExpanded : true;
                    state.metricsSectionExpanded = uiState.metricsSectionExpanded !== undefined ? uiState.metricsSectionExpanded : true;
                    state.selectedHex = uiState.selectedHex || null;
                }
                
                // Load UI theme
                const savedTheme = localStorage.getItem('adsbScope_uiTheme');
                if (savedTheme) {
                    state.uiTheme = savedTheme;
                }
            } catch (error) {
                ErrorBoundary.handleError(error, 'Settings Loading');
            }
        },
        
        /**
         * Applies the persisted expanded/collapsed state to the aircraft and
         * metrics side panels, including the rotation of their chevron icons.
         * @returns {void}
         */
        initializeCollapsibleSections() {
            if (elements.aircraftSection) {
                elements.aircraftSection.classList.add(state.aircraftSectionExpanded ? 'section-expanded' : 'section-collapsed');
                const toggleIcon = elements.aircraftToggle?.querySelector('svg');
                if (toggleIcon && !state.aircraftSectionExpanded) {
                    toggleIcon.classList.add('collapsed');
                }
            }
            
            if (elements.metricsSection) {
                elements.metricsSection.classList.add(state.metricsSectionExpanded ? 'section-expanded' : 'section-collapsed');
                const toggleIcon = elements.metricsToggle?.querySelector('svg');
                if (toggleIcon && !state.metricsSectionExpanded) {
                    toggleIcon.classList.add('collapsed');
                }
            }
        },
        
        /**
         * Populates the UI-theme dropdown (grouped by `Dark`/`Light`), the
         * scope-theme dropdown and their mobile `<select>` equivalents from
         * {@link UI_THEMES} and {@link SCOPE_THEMES}.
         * @returns {void}
         */
        initializeThemeMenus() {
            try {
                // UI Theme Menu
                const groupedThemes = UI_THEMES.reduce((acc, theme) => {
                    (acc[theme.group] = acc[theme.group] || []).push(theme);
                    return acc;
                }, {});
                
                if (elements.uiThemeMenu) {
                    elements.uiThemeMenu.innerHTML = Object.entries(groupedThemes)
                        .map(([group, themes]) => `
                            <div class="px-4 py-1 text-xs font-bold" style="color: var(--color-text-muted);">${group}</div>
                            ${themes.map(t => 
                                `<a href="#" class="block px-4 py-2 text-sm hover:bg-opacity-10 hover:bg-white" data-theme="${t.key}">${t.name}</a>`
                            ).join('')}
                        `).join('');
                }
                
                // Scope Theme Menu
                if (elements.scopeThemeMenu) {
                    elements.scopeThemeMenu.innerHTML = SCOPE_THEMES
                        .map((t, i) => 
                            `<a href="#" class="block px-4 py-2 text-sm hover:bg-opacity-10 hover:bg-white" data-theme-id="${i}">${t.name}</a>`
                        ).join('');
                }
                
                // Mobile theme selects
                const mobileUiSelect = document.getElementById('mobile-ui-theme-select');
                const mobileScopeSelect = document.getElementById('mobile-scope-theme-select');
                
                if (mobileUiSelect) {
                    mobileUiSelect.innerHTML = UI_THEMES.map(t => 
                        `<option value="${t.key}">${t.name}</option>`
                    ).join('');
                    mobileUiSelect.value = state.uiTheme;
                }
                
                if (mobileScopeSelect) {
                    mobileScopeSelect.innerHTML = SCOPE_THEMES.map((t, i) => 
                        `<option value="${i}">${t.name}</option>`
                    ).join('');
                    mobileScopeSelect.value = state.scopeThemeIndex;
                }
            } catch (error) {
                ErrorBoundary.handleError(error, 'Theme Menu Initialization');
            }
        },
        
        /**
         * Tears the application down: stops the render loop, removes every
         * registered listener/interval/timeout, empties the object pools and
         * clears the distance and static-scope caches. Bound to `beforeunload`.
         * @returns {void}
         */
        cleanup() {
            ScopeLoop.stop();
            PositionManager.stop();
            EventHandlers.cleanup();
            
            // Clean up object pools
            trailPointPool.pool.length = 0;
            
            // Clear caches
            MathUtils._cache.clear();
            if (canvasRenderer) {
                canvasRenderer.staticElementsCache = null;
            }
        }
    };

    /**
     * Global safety net: routes uncaught exceptions and unhandled promise
     * rejections into the ErrorBoundary so nothing fails silently.
     */
    window.addEventListener('error', (e) => {
        ErrorBoundary.handleError(e.error, 'Global');
    });
    
    window.addEventListener('unhandledrejection', (e) => {
        ErrorBoundary.handleError(e.reason, 'Promise');
    });

    // Start application when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => App.init());
    } else {
        App.init();
    }
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => App.cleanup());
    

})();
