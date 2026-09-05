# Test harness

The application itself has **no dependencies and no build step** — it is four
static files. This directory is the exception: it exists only to verify the
application, and nothing here ships with a release.

## Why it exists

There was no way to check a claim about this codebase without running it. The
README that came with the last source release advertised features the source did
not implement — a compass-ring zoom, a Clear Storage button, dirty-region
tracking — and two critical defects sat in the data path unnoticed. Reading the
code had not caught any of it.

So the suites boot the **real** `index.html`, `config.js` and `app.js` and assert
on what actually happens.

## Running

Needs Node 20.19+, 22.13+ or 24+ — the range jsdom itself requires, mirrored in
`engines`.

```bash
cd test
npm install     # jsdom, once
npm test        # all four suites, ~70 s
```

Individually:

```bash
npm run test:runtime      # boot and render
npm run test:features     # moving receiver, settings, previously-inert flags
npm run test:defects      # the audited defects must not reproduce
npm run test:multisource  # multi-source resilience (slow: real retry backoff)
```

Each suite exits non-zero on failure, so they work as a CI gate.

## The suites

| File | Covers |
|---|---|
| `run.js` | 31 checks: startup, polling, CSV parsing, sweep-gated promotion, trails, the static-layer cache, every panel, emergency handling, classification, interaction, export, persistence, teardown |
| `features.js` | 46 checks: the moving receiver end to end, every accepted `POSITION` format and its rejection cases, each previously-inert `CONFIG` flag, each newly implemented UI feature |
| `bugs.js` | Reproduction attempts for the defects in [KNOWN_ISSUES.md](../KNOWN_ISSUES.md). These *should* all report "not reproduced" — each one is a regression guard |
| `multisource.js` | The two critical data-fetch defects: a dead source must not stop the healthy ones, and failed requests must not leak unhandled rejections |

## How it works

[jsdom](https://github.com/jsdom/jsdom) provides the DOM. Everything Node lacks
is stubbed:

- **2D canvas context** — a dummy that *counts* every call, so a test can assert
  "118 of 120 static-layer restores were partial" rather than just "it drew
  something"
- **`fetch`** — serves synthetic aircraft, CSVs and `POSITION` content. Only
  `localhost:8000` resolves; any other host rejects, which is how a dead feed is
  simulated
- **`requestAnimationFrame`** — a queue the test drains by hand, so eight seconds
  of scope time run instantly and deterministically
- **`AudioContext`**, **`OffscreenCanvas`**

### The probe line

`app.js` is one big IIFE, so none of its modules are reachable from outside. Each
suite appends **a single line** before the closing `})();` exposing `state`,
`DataManager`, `PositionManager` and the rest as `window.__t`.

That happens on an in-memory copy. The file on disk is never modified, and the
rest of the source is injected byte for byte.

## Gotchas when adding tests

- **`config.js` ships placeholders.** `DEFAULT_TAR1090_URL` is
  `[your-ip-path]/aircraft.json`, which `URLValidator` rejects — so if you forget
  to override it after loading `config.js`, nothing is ever fetched and the
  failure looks like a bug in the app.
- **jsdom reports zero for every dimension.** Give `#canvas-container` a real
  `clientWidth`/`clientHeight`, or the render loop returns early every frame and
  nothing is ever drawn.
- **Warning banners self-remove after 7 seconds.** Any suite that waits out the
  retry backoff will find them gone; record them with a `MutationObserver` as
  they appear, as `multisource.js` does.
- **`localStorage` shadows `config.js`.** Seed it deliberately, or clear it, so a
  test is not reading state left by the settings panel.
- **The retry backoff is real** (1 s, 2 s, 4 s). A multi-source test genuinely
  takes ~9 s per poll; do not shorten the waits to make it fast, or you will be
  asserting on a cycle that has not finished.

## What is versioned, and what is not

The harness is a self-contained sub-project: it is the only part of the
repository with dependencies, so it carries its own `package.json` and its own
`.gitignore` rather than being described from the root.

| Path | Versioned? | Why |
|---|---|---|
| `*.js`, `README.md`, `package.json` | yes | the harness itself |
| `package-lock.json` | **yes, deliberately** | these suites assert on real behaviour, so an unpinned jsdom could change a result with no change to the application under test |
| `node_modules/` | no | `test/.gitignore` |
| npm logs, coverage, profiles | no | `test/.gitignore` |

The root `.gitignore` anchors its paths with a leading slash (`/node_modules/`,
not `node_modules/`) precisely so that it does not silently reach in here. The
rule that ignores the harness's dependencies lives beside the code it governs.

`version` in `package.json` tracks the application version it was written
against — `0.0.2` here. It is `private`, never published; the field exists so
that a suite and the source it verifies can be told apart when they drift.

## Limitations

This is jsdom, not a browser. It proves logic, data flow and DOM effects; it does
**not** prove that anything looks right. Pixel output, theme rendering and the
visual result of dirty-region restore need a real browser.
