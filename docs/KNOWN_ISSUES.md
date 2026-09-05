# Known Issues

Audit record for the code upstream published as `0.9.2.0837110925`.

Every defect below was found by executing the real source in a DOM environment
and reproducing the failure, not by reading the code. **All twelve are fixed as
of `0.0.2`**; this file is kept as the record of what was wrong, what the fix
was, and how to tell if one comes back.

Nothing is currently open. New findings go at the bottom, under
[Open issues](#open-issues).

| # | Severity | Issue | Fixed in |
|---|---|---|---|
| 1 | Blocking | `config.js` placeholder was not valid JavaScript | 0.0.1 |
| 2 | Critical | One dead data source permanently broke all polling | 0.0.2 |
| 3 | Critical | Unhandled promise rejection on every failed request | 0.0.2 |
| 4 | Major | `showRunways` was inverted when settings reloaded | 0.0.2 |
| 5 | Major | Keyboard shortcuts fired while typing in the settings form | 0.0.2 |
| 6 | Minor | FPS readout was roughly double the real frame rate | 0.0.2 |
| 7 | Minor | Emergency tone repeated once per second | 0.0.2 |
| 8 | Minor | `drawAirportsAndNavaids` threw on its own default argument | 0.0.2 |
| 9 | Latent | Failed-source warning named the wrong source | 0.0.2 |
| 10 | Minor | Airport/navaid cap took the first N in file order | 0.0.2 |
| 11 | — | Nine `CONFIG` settings were read nowhere | 0.0.2 |
| 12 | — | Dead code | 0.0.2 |

---

## 1. `config.js` placeholder was not valid JavaScript

```javascript
DEFAULT_HOME_LAT: 00.0000,     // SyntaxError: Unexpected number
```

A leading `0` followed by further digits is a legacy octal literal, so
`00.0000` cannot be parsed. The browser rejected **the whole of `config.js`**,
leaving `CONFIG` undefined and the page blank — the shipped default could never
run.

**Fixed in 0.0.1:** written as `0.0` / `-0.0`. Users still replace these with
their own coordinates, or enable a `POSITION` file.

## 2. One dead data source permanently broke all polling — CRITICAL

`DataManager.fetchFromSource` kept its attempt counter in
`state.retryAttempts[url]`, reset on success but **never on failure**. Once a
source had failed three times the counter stuck at 3, the `while` body never ran
again, and the function **resolved with `undefined` instead of rejecting**.
`Promise.allSettled` therefore classed it as fulfilled, it landed in
`successfulData`, and `mergeAircraftData` dereferenced `data.messages` on
`undefined` — aborting the whole cycle, healthy sources included.

Two documented behaviours did not exist as a result: `CONN: Partial (n failed)`
was unreachable, and multi-source resilience did not work.

**Fixed in 0.0.2:** the retry budget is per call, so a source that recovers is
picked up on the next poll; the loop always throws on exhaustion;
`mergeAircraftData` skips non-object entries.

Before → after, one reachable and one unreachable source:

```
             fetchFromSource settles as | connectionStatus     | healthy feed
  before     RESOLVED undefined         | Error                | stalled
  after      REJECTED                   | Partial (1 failed)   | still updating
```

## 3. Unhandled promise rejection on every failed request — CRITICAL

`NetworkRequestPool.fetch` attached bookkeeping with `.finally()`, which returns
a **new** promise that nobody handled. The caller's `catch` sat on
`requestPromise`, not on the derived one, so every failed request reached
`window.onunhandledrejection` → `ErrorBoundary` → a red banner, once per poll.

**Fixed in 0.0.2:** `.finally(...).catch(() => {})`. Measured over two fetch
cycles with one failing source: 7 unhandled rejections before, 0 after.

## 4. `showRunways` was inverted when settings reloaded — MAJOR

```javascript
state.showRunways = settings.showRunways !== true;   // "Default to true"
```

The comment described the intent; the expression did the opposite. Saving
runways **on** and reloading turned them **off**, permanently inverting the
setting. Every sibling boolean used the correct form.

**Fixed in 0.0.2:** `settings.showRunways !== false`.

## 5. Keyboard shortcuts fired while typing in the settings form — MAJOR

`handleKeydown` was bound to `window` and inspected no event target, so every
keystroke anywhere was a shortcut. With the caret in `#home-lat`, typing `t`
toggled trails; entering `-33.8688` triggered two range changes.

**Fixed in 0.0.2:** the handler returns early for `INPUT`, `TEXTAREA`, `SELECT`
and `contenteditable` targets.

## 6. FPS readout was roughly double the real frame rate — MINOR

`ScopeLoop.update` incremented `state.frameCount` twice per frame. 50 rendered
frames produced `frameCount === 98`.

**Fixed in 0.0.2:** counted once, inside the render branch, so the figure is
frames actually drawn per second.

## 7. Emergency tone repeated once per second — MINOR

The banner was de-duplicated through `state.activeAlerts`; the tone was not, so
it replayed on every poll — one chirp per second for as long as the aircraft
squawked.

**Fixed in 0.0.2:** `UIManager.createEmergencyAlert` returns whether it raised a
new banner, and the tone is gated on that, so both are de-duplicated on the same
decision. (`activeAlerts` is also keyed consistently now: it stored the raw
lowercase hex while the caller indexed by uppercase.)

## 8. `drawAirportsAndNavaids` threw on its own default argument — MINOR

`airportData` was computed from the `airports = null` fallback and then ignored;
the guard and the draw call both used the raw parameter. Calling it without the
fifth argument threw `Cannot read properties of null`.

**Fixed in 0.0.2:** the computed `airportData` is used.

## 9. Failed-source warning named the wrong source — LATENT

`.filter(...).map((r, i) => ({ source: enabledSources[i] }))` indexed the
**filtered** array against the original list. Unreachable while warnings only
fired when every source failed — but fixing issue 2 made `Partial` reachable and
would have exposed it.

**Fixed in 0.0.2:** each result is paired with its source before filtering.
Warnings are also emitted once per outage rather than once per poll.

## 10. Airport/navaid cap took the first N in file order — MINOR

The `MAX_AIRPORTS_DISPLAY` slice ran in CSV order, so in a dense area the
airports shown were an arbitrary subset rather than the nearest ones.

**Fixed in 0.0.2:** sorted by distance before slicing.

## 11. Nine `CONFIG` settings were read nowhere

Present in `config.js`, referenced nowhere in `app.js`:
`WEAK_REFERENCE_CLEANUP`, `BATCH_NETWORK_REQUESTS`, `RESPONSE_COMPRESSION`,
`PROXY_STATE_DETECTION`, `TRAIL_GRADIENT_SEGMENTS`, `SMOOTHING_FACTOR`,
`HEADING_LINE_LENGTH`. Two more were read but had no effect:
`USE_OFFSCREEN_CANVAS` created a canvas never drawn into, and
`DIRTY_REGION_TRACKING` had no call site.

**Fixed in 0.0.2** — each now does what it says:

| Setting | Implementation |
|---|---|
| `USE_OFFSCREEN_CANVAS` | `cacheStaticElements` rasterises on the `OffscreenCanvas`, falling back to a scratch `<canvas>` |
| `DIRTY_REGION_TRACKING` | Draw calls record bounding boxes; the next frame restores only those bands, falling back to a full blit above 55% coverage |
| `WEAK_REFERENCE_CLEANUP` | Trail screen projections memoised in the `WeakMap`, keyed by the aircraft entry so they are reclaimed with it |
| `BATCH_NETWORK_REQUESTS` | `NetworkRequestPool` gained a real queue honouring its (previously unused) `maxConcurrent` |
| `PROXY_STATE_DETECTION` | When off, `StateManager` returns a plain object instead of a `Proxy` |
| `TRAIL_GRADIENT_SEGMENTS` | Caps the segments stroked; longer trails are resampled |
| `SMOOTHING_FACTOR` | Exponential smoothing of reported positions, snapping on jumps over 2 nm |
| `HEADING_LINE_LENGTH` | Fixed-length heading stub drawn ahead of airborne symbols |

`RESPONSE_COMPRESSION` was **removed** rather than implemented.
`Accept-Encoding` is a forbidden header name in `fetch`; the browser negotiates
transfer encoding itself, so the setting could never have had an effect. Faking
it would have been worse than deleting it.

## 12. Dead code

`_drawRoundedRect`, `markDirty`/`clearDirtyRegions`, `offscreenCtx`, the
`aircraftReferences` WeakMap, `Renderer.lastRenderData`, `state.lastRangeNm`.

**Resolved in 0.0.2:** `markDirty`, `clearDirtyRegions`, `offscreenCtx` and
`aircraftReferences` are now load-bearing (issue 11); `state.lastRangeNm` is
written by the ring-click zoom. `_drawRoundedRect` and `Renderer.lastRenderData`
remain unused — harmless, and left in place rather than removed as unrequested
churn.

---

## Documentation claims that did not match the source

Found in the same audit and corrected in the README rather than the code, except
where noted:

| Claim | Reality | Resolution |
|---|---|---|
| "60+ scope themes" | 51 | README corrected |
| "35+ UI themes" | exactly 35 | README corrected |
| "Click compass rings: quick zoom" | no handler existed | **implemented in 0.0.2** |
| "Clear Storage button in Settings" | did not exist | **implemented in 0.0.2** |
| "`D`: toggle label details" | `D` was the debug overlay | **implemented in 0.0.2**; debug moved to `I` |
| "`R`: reset view", "`W`: runways", "`?`: help" | not bound | **implemented in 0.0.2** |
| Settings panel offers performance, display, theme | none present | **implemented in 0.0.2** |
| "Dirty region tracking for minimal redraws" | dead code | **implemented in 0.0.2** |
| "Offscreen canvas caching" | created, never used | **implemented in 0.0.2** |
| "Trails with gradient fading" | per-segment alpha; the gradient setting was unused | README reworded; setting now caps segments |
| "Mobile support removed" | markup, JS and media queries all present | README corrected |

## Open issues

None. New findings belong here, with the evidence that reproduces them.

---

## How this was verified

The application has no build step and no test suite, so verification means
booting the real `index.html`, `config.js` and `app.js` in a DOM environment
(jsdom) with the 2D canvas context, `fetch`, `AudioContext` and
`requestAnimationFrame` stubbed, then driving frames and feeding synthetic data.

Four suites are used, all against unmodified sources. They live in
[`test/`](../test/README.md) and run with `cd test && npm install && npm test`:

- **`run.js` — 31 boot-and-render checks:** startup, polling, CSV parsing,
  sweep-gated promotion, trails, the static cache, every panel, emergency
  handling, classification, interaction, export, persistence, teardown.
- **`features.js` — 46 feature checks:** the moving receiver end to end
  (including every accepted POSITION format and its rejection cases), each
  previously-inert setting, and each newly implemented UI feature.
- **`multisource.js` — 8 resilience checks:** issues 2 and 3 specifically, since
  those are the ones whose return would be least visible.
- **`bugs.js` — a reproduction suite** for the defects above, which fails to
  reproduce any of them after the fixes.

Each suite exits non-zero on failure. Anyone reopening one of these defects
should be told by `npm test`, not by a user.
