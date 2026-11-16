# Contributing to SatelliteTrailRemover

Thank you for considering a contribution. Bug reports, test data, fixes and new ideas are all welcome. This guide
explains how the code is organised, the rules it must follow to run in PixInsight, how to test a change, and what
to include when you submit one.

By contributing you agree that your contribution is released under the project's MIT license.

## How the project is organised

| File | Role |
|---|---|
| `SatelliteTrailRemover.js` | Standalone script (Script › BlackRig › SatelliteTrailRemover): dialog, interactive, batch and WBPP-folder modes. Saves its parameters in PixInsight's settings. |
| `SatelliteTrailRemover.xsgn` | Code signature of the standalone script, produced by the maintainer. |
| `SatelliteTrailRemover_WBPP.js` | WBPP step, loaded by WeightedBatchPreprocessing as its *pipeline builder*. Reads the parameters saved by the standalone script. |
| `tests/test_builder.js` | End-to-end test of the WBPP step in Node.js (79 checks). |
| `tests/check_core.js` | Checks that both scripts contain the same numerical core. |
| `SatelliteTrailRemover_how_it_works.docx` | The method in full: equations, design choices, validation. Read it before changing the algorithm. |
| `README_standalone.md`, `README_WBPP.md` | User documentation of the two scripts. |

### The numerical core

All image processing lives between the markers `// ==== CORE BEGIN` and `// ==== CORE END`. The core is plain
ECMAScript 5 on `Float32Array` data and uses no PixInsight objects, so it runs unchanged in Node.js. Its entry
point is `STR_processChannel(sub, stack, W, H, P, log, dump)`. It overwrites `sub` with the cleaned data.

**Both scripts carry an identical copy of the core.** The WBPP step wraps it in `function STRW_core() { ... }` so
that its source can be sent to worker threads. If you change the core, make the same change in both files and run:

```
node tests/check_core.js SatelliteTrailRemover.js SatelliteTrailRemover_WBPP.js
```

### Processing stages (in `STR_processChannel`)

1. **Adaptive match** (`STR_adaptiveSubtract`): fits gain × stack + offset to the frame, locally, with a prior on
   the gain and sigma clipping. The residual r = frame − fit keeps noise, star mismatches and trails.
2. **Significance and weight** (`STR_residualWeight`): smoothed residual divided by a noise term that grows on
   structure present in the stack (stars), giving a weight map w between 0 and 1.
3. **Saturation guard** (`STR_saturationProtect`): w = 0 around saturated pixels.
4. **Detection** (`STR_detectTrails`): Radon line search on the binned residual, elongated-blob test, line
   refinement (including double and parallel trails), along-track trail model (`STR_lineModel`).
5. **Correction**: cleaned = frame − (w·r + (1 − w)·T) inside the detected trails only. Frames without a trail
   are not modified.

The manual describes each stage and the reasons behind it.

## Rules the code must follow

PixInsight's JavaScript runtime (PJSR) has constraints that a normal JavaScript syntax check does not catch.

### Both scripts

- **ECMAScript 5 only.** No `let`, `const`, arrow functions, template literals, classes or `for…of`, and no ES2015
  library calls such as `TypedArray.prototype.fill/slice/sort`, `TypedArray.from`, `Math.hypot`, `Object.assign`.
  Typed arrays themselves are fine.
- **Never write a slash followed by an asterisk**, not even inside a `//` comment or a string. The PJSR
  preprocessor reads it as the start of a block comment and fails with "Unterminated block comment". Build such
  strings in pieces, for example `dir + "/" + "*"`. Check with `grep -nE '/\*|\*/' *.js`, which must print
  nothing.
- **The core stays free of PixInsight objects** (no `ImageWindow`, `View`, `File`, `console` calls other than
  the `log` callback it receives).
- Pixels: `getSamples`/`setSamples` with a `Float32Array`, with a plain `Array` fallback.

### Standalone script

- The header must keep `#feature-id    SatelliteTrailRemover : BlackRig > SatelliteTrailRemover`. The part before
  the colon is the script identifier: without it, code signing fails with "No script identifier has been
  specified".
- In-place processing of a user's view uses `UndoFlag_DefaultMode` (so Undo works). `UndoFlag_NoSwapFile` is only
  for new or temporary windows and batch files.
- Any change invalidates `SatelliteTrailRemover.xsgn`. Do not include a signature in your contribution: the
  maintainer signs releases.

### WBPP step

WBPP reads this file as text and evaluates it with `eval`, in strict mode, inside one of its own methods. So:

- **No `#` lines at all** (`#include`, `#define`, `#feature-id`): they are syntax errors in `eval`. Use the
  object forms of constants (`DataType.Double`, `UndoFlag.NoSwapFile`), not the preprocessor names
  (`DataType_Double`).
- **Never code-sign this file.** Signing needs a `#feature-id` line, which would break WBPP, and WBPP does not
  check signatures of the files it evaluates.
- WBPP evaluates the file on nearly every click in its dialog: do no console output, file access or heavy work at
  build time, only when the queued operation runs.
- Check WBPP's API before calling `engine.pipelineManager.buildPipelineForLight()`, and never throw after calling
  it: if the builder throws, WBPP builds the light pipeline a second time itself.
- Thread bodies run in an empty JavaScript context: everything they need must be in the source string the step
  sends (see `STRW_threadSource`). The test runs each body in a fresh context to catch missing pieces.
- Registered frames are never modified. Cleaned frames are written to `detrailed/<group>/`, and WBPP's later
  steps are pointed at them.
- **Cache keys:** each frame's result is cached under a key that contains `STR_VERSION`, `STRW_CACHE_VERSION`
  and the parameters. If your change alters the output without a core version change (for example the reference
  stack), bump `STRW_CACHE_VERSION`, or users will keep stale results.

## Testing a change

You need Node.js (tested with 18.4) and, for the WBPP test, a PixInsight installation: the test loads WBPP's own
`OperationQueue`, `ExecutionCache` and `BPPOperationBlock` sources from it.

```
node tests/check_core.js SatelliteTrailRemover.js SatelliteTrailRemover_WBPP.js
node --max-old-space-size=8000 tests/test_builder.js SatelliteTrailRemover_WBPP.js <empty work folder>
```

Both must end with `PASS cores identical` and `ALL PASSED`. If PixInsight is not installed in
`C:/Program Files/PixInsight`, set `WBPP_DIR` to `<PixInsight>/src/scripts/BatchPreprocessing`.

The WBPP test also exercises the core on synthetic frames with single and double trails: 90–96 % of the trail
flux removed, and fewer than 0.1 % of trail-free pixels changed by more than 0.5 σ. `README_WBPP.md` (Testing)
lists everything it checks. To syntax-check the standalone script outside PixInsight, strip its `#` lines and
evaluate it with `new Function(source)`.

### Real data

Synthetic tests do not replace real frames. For any change to the algorithm, run it inside PixInsight on real
registered subs and report:

- the frames used (camera, image size, filter, number of frames, how many with trails);
- a before/after crop of each trail and the `_removed` diagnostic image: it must contain the trail and nothing
  else (no stars, no nebula);
- frames without trails must stay untouched (the console reports it);
- for faint trails, the leftover profile across the trail (mean of cleaned − reference along the track).

The core is deterministic. Running it in Node.js on raw 32-bit exports of a sub and its stack reproduces
PixInsight's output exactly, which is a convenient way to study a frame in detail. The *Debug Dump* section of the
dialog writes every intermediate image of a preview region.

**Default behaviour is protected.** A change that alters the results with the default parameters needs evidence
on real data that it is better, not only different. New behaviour that is not clearly better belongs behind an
option that is off by default.

## Lessons already learned

Please read these before proposing a change in the same area. Each was tried, measured and either fixed or
abandoned.

- **Gain prior scaling:** a prior weighted against unnormalised sums pinned the gain at 1 and left stars on
  trails 18 % too bright. The prior weight is now σ²/τ².
- **Off-trail changes were not stars:** most were sub-only hot pixels and cosmic rays, plus saturated cores. A star
  mask derived from the stack, with bridging of trails across stars, was implemented (2.1 to 2.3) and removed in
  2.4: it did not address those cases and cost most of the run time. Do not reintroduce it without new evidence.
- **Pixel-level detection alone misses faint trails:** they fragment below the weight threshold. The line search
  on the binned residual finds them down to about 0.2 σ per pixel.
- **Clip the residual per pixel before binning** in the line search, or bright stars and clusters create false
  lines.
- **Double trails:** two components 24 px apart were once merged into one corridor too narrow for both. The
  cross-profile is now measured over ±96 px, and a companion must be significant along most of the line.
- **Clamping noise is a bias:** forcing the along-track model to be ≥ 0 in bins without trail signal subtracted
  about 0.035 σ per pixel. Those bins are now set to 0.
- **Edge artefacts:** registration can leave the first row of a frame brighter than the stack. A few frames have
  been flagged as having a "trail" along the border (harmless, but a false detection). Open to improvement.
- **WBPP's drizzle-file check:** after every light integration, drizzle on or off, WBPP checks that each frame's
  `.xdrz` file was updated, and reports frames whose file was not as excluded. The step copies the `.xdrz` next to
  each cleaned frame and points WBPP at the copy when drizzle is off.
- **WBPP's cache works by file date:** modifying files in `registered/` makes WBPP register them again on its next
  run. Hence the separate `detrailed/` folder.
- **The reference rejection must not follow the master's:** a gentle rejection for the master must not weaken
  the reference stack, nor trigger a re-clean of every frame. The reference uses its own settings
  (`STRW_REF_*`).
- **Memory:** about 32 bytes per pixel per channel for each frame being cleaned (measured in Node.js). The number
  of frames cleaned at the same time is limited by the available memory.

## Submitting a change

1. For anything beyond a small fix, open an issue first to discuss the idea.
2. Keep each pull request to one subject.
3. Run the checks of [Rules the code must follow](#rules-the-code-must-follow) and both tests.
4. Bump the version: `STR_VERSION` (`#define` in the standalone script, `var` in the WBPP step) for a core
   change, `STRW_VERSION` for a WBPP-step change. Add a line to the Changelog in `README_standalone.md` or to the
   version history in the header of `SatelliteTrailRemover_WBPP.js`, and update the manual if the method changes.
5. In the pull request, say what the change does and why, show the evidence (test output, real-data results as
   above), and state clearly what was verified where: Node.js tests, inside PixInsight, which data. Do not claim a
   test you did not run.

## Ideas that would be welcome

- Ignoring blobs that run along the frame border (false detections from registration edges).
- A separable along-track model (cross-track profile measured over the whole line × locally fitted amplitude),
  which would lower the noise of the model for faint trails.
- Cleaning single images without a stack, from satellite ephemerides or a star-catalogue render (section 13 of
  the manual).
- Drizzle support. Drizzle currently reads the calibrated frames, so trails come back in a drizzle master.
- Real-data test sets with known trails, especially faint ones, trails crossing bright nebulae, and colour (OSC)
  data.
