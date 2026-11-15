---
name: "pixinsight-satellite-trail-remover"
description: "Continue developing, debugging or tuning SatelliteTrailRemover.js, Erellaz's PixInsight PJSR script that removes satellite trails from registered sub-exposures: adaptive match to a reference stack, frame-level line/blob trail detection, along-track removal (incl. double trails), batch and WBPP modes, MIT license."
---

# SatelliteTrailRemover: PixInsight satellite trail removal script

Use this skill whenever the work touches `SatelliteTrailRemover.js` (PixInsight JavaScript Runtime
script), questions about how it removes satellite trails, adaptive subtraction / matching of the
reference stack, the residual weight map, or batch processing of registered sub-exposures.

## Context

- Owner and author: **Erellaz** (the only author name to use anywhere: script header, README,
  LICENSE, manual byline and metadata; the user's real name must not appear). **License: MIT**
  (`LICENSE` next to the script, "Copyright (c) 2026 Erellaz"). Wants precise technical depth, explicit reasoning,
  honest statements of what was and was not verified.
- Menu: **Script › BlackRig › SatelliteTrailRemover** (`#feature-id    SatelliteTrailRemover : BlackRig > SatelliteTrailRemover`;
  the "Id : " prefix is required for code signing: without it PixInsight codesign fails with
  "No script identifier has been specified". The user signs the script, developerId BlackRig;
  every edit invalidates the .xsgn and needs re-signing).
  All of the user's PixInsight scripts go under Script › BlackRig.
- Runtime: PixInsight 1.9.6 on the user's Windows desktop. Installed copy:
  `D:/Pixinsight/BlackRigScripts/Desat/SatelliteTrailRemover.js`.
- Data: Moravian C5-100 subs (9576 × 6388, IMX455), run on **registered** (star-aligned) subs, one
  filter at a time, with the integrated master for that filter as reference stack.
- Current version: **2.9** (`#define STR_VERSION`). v2.9 = double/parallel trails (corridor from
  the cross-profile, see "Double trails (v2.9)"). v2.8 = collapsible dialog (PJSR `SectionBar`,
  see "Dialog (v2.8)"); CORE byte-identical to 2.7. v2.7 = WBPP compatibility mode (see section).
  Previous: **2.6**. v2.6 = frame-level trail detection, line
  removal with an along-track model, "only modify detected trails" (all default on; detection off =
  bit-identical to v2.5, verified on the real frame). v2.5 = brightness tolerance. v2.4 = star
  exclusion removed. v2.3 = scale-aware gain prior + saturation guard. v2.2 = debug dump.

## Real-data diagnosis (2026-11-14, NGC6729 Blue sub, 11664×8750, full-frame dump)

Dump: `D:\Stack\NGC6729HighRejection\registered\Light_BIN-1_11664x8750_EXPOSURE-120.00s_FILTER-Blue_mono\debug\Blue_20261114-170123`.
Residual σ = 8.2e-5, sky ~8e-4 (sub) / 2.2e-3 (stack). One bright trail (top right).
- **Gain prior bug**: prior weight was 1/τ² against unnormalised ΣRR → ~1e8× too strong, gain
  pinned at 1.0000. True sub/stack star flux ratio 0.83 (aperture and peak alike → transparency,
  not seeing), 0.70–0.93 across the field. Fixed with λ = σ²/τ² (σ from robust sigma of sub−stack,
  then of the residual each clip iteration) → fitted gain 0.77–1.07.
- Star residual after the gain fix: mean −26 % → +0.7 % of star amplitude, but RMS stays 27 %
  (PSF/registration shape mismatch, diffraction spikes) → structTol still needed.
- What "touches stars" really was: (1) **saturated cores** (sub/stack ≥ ~0.95; residual meaningless,
  and with a fitted gain they would be dimmed 17 %) → saturation guard (satLevel 0.95, satGrow 8,
  weight only); (2) the 4 stars on the trail replaced by the stack star at gain 1 → 18 % too
  bright, fixed by the gain prior (0.98 → 0.82 of stack, true 0.83); (3) ~1100 of 1145 off-trail
  weight blobs are **sub-only point sources (hot pixels / cosmics)**, not stars — removing them is
  a beneficial side effect, and why a stack-derived star mask could not help.
- Second dump (v2.4, `debug2\Blue_20261114-173252`): remaining "star signal" in `removed` was
  (a) halos / diffraction spikes / bleed of the saturated stars just outside satGrow (large
  vertical streaks: sub has more halo/spike light than the stack), (b) bright unsaturated stars and
  spikes with flux/shape differences, (c) hot pixels next to stars (the hot pixel is the removal).
  → v2.5 brightness term: σ_eff² = σ² + (β·S)² + (γ·E)², E = boxBlur(max(model − sky, 0), r),
  sky = `STR_skyBackground` (per 64-px block min of 8×8 cell means, min over 5×5 blocks, 2× 3×3
  blur, bilinear). Sweep γ = 0/0.02/0.05/0.1/0.2: halo-zone removal 3.98 → 0.93 → 0.053 → 0.041 →
  0.038; star-px removal 0.52 → 0.31 → 0.20 → 0.17 → 0.17; trail removal 8.283 → 8.281 → 8.274 →
  8.255 → 8.208. Default γ = 0.05.
- Star exclusion: bridge took 190.7 s of 258.7 s in PixInsight (73 s of 101 s in Node) — scattered
  hot-pixel weight makes nearly every masked pixel a bridge candidate.
- v2.3 defaults vs v2.2 on this frame: trail removal unchanged (8.6e-5 removed / px in corridor),
  off-trail star px with w>0 0.84 % → 0.62 %, mean |change| on star px 0.0085 → 0.0001 of star
  amplitude, stars on trail 0.98 → 0.82 (correct). ~24 s total in Node (≈2.5× faster than PJSR).

Analysis toolchain (scratch venv, rebuildable): `mini-racer` (V8), `nodejs-bin`
(`python -m nodejs --max-old-space-size=24000 run_real.js <script> <outdir> '<P json>'`, runs the
CORE on raw .f32 exports of sub_in/stack_in and reproduces PixInsight bit-for-bit), `xisf`,
`numpy`, `scipy`, `pillow`. User verdict on v2.0: "works pretty damn well",
  but touched stars a little → v2.1 added optional star exclusion. **The default path must stay
  bit-identical to v2.0** (user: "do not damage what works already") — check with the output hash.
- Replaces an earlier Python v2 tool (`satellite_trail_detector.py`, OpenCV LSD + Hough + RANSAC).
- Sibling script: FourierDeband.js (same author, same conventions; see `pixinsight-fourier-deband`).

## Project layout

```
SatelliteTrailRemover.js                  the script (single file, ES5)
SatelliteTrailRemover_how_it_works.docx   user guide and technical description
README.md                                 GitHub readme
LICENSE                                   MIT license
SKILL.md                                  this file
```

No test suite in the repo. A synthetic harness was used for v2.0 (see "Testing" below).

## Method (v2.0)

1. **Validity mask**: a pixel is valid only if BOTH sub and stack are > 1e-6 (registration borders
   of sub and stack differ; v1.x only skipped pixels where both were black).
2. **Adaptive match** (`STR_adaptiveSubtract`): `model = gain(x,y)·stack + offset(x,y)`, windowed
   least squares on a block grid with an N(1, τ²) prior on the gain, iterative global sigma-clipping
   (outliers = trails, stars with PSF mismatch excluded from the fit), 2-pass 3×3 box blur of the
   grids, bilinear interpolation. `diff = sub − model` (0 on invalid pixels).
3. **Residual weight** (`STR_residualWeight`):
   - `sm = boxBlur(diff, smoothRadius)` (signed residual, so noise averages to zero)
   - `σ` = robust sigma of `sm` itself (accounts for the noise correlation from smoothing)
   - structure map `S = boxBlur(|model − boxBlur(model, 4)|, smoothRadius) − skyFloor`
   - `z = (sm − mean) / sqrt(σ² + (structTol·S)²)`: residuals on structure already in the reference
     (stars: PSF/registration mismatch) need to be larger; trails are absent from the reference so
     S ≈ 0 along them. This is the key discriminator replacing the old geometric detection.
   - `w0` = linear ramp 0 at `sigmaLow` → 1 at `sigmaHigh` (positive side only)
   - `w = boxBlur(maxFilter(w0, growRadius), featherRadius)`, 0 on invalid pixels
4. **Subtraction**: `corrected = sub − w·diff = (1−w)·sub + w·model`, clamped to [0, 1], written
   in place into the sub. In fully replaced pixels the sub's own noise is replaced by the model's
   (the stack's lower noise).

v1.x trail detection (threshold → connected components → PCA → merge → corridor mask → zero the
pixels) was **removed in v2.0**: it did not work on real data.

## Removed: star exclusion (v2.1–2.3, removed in v2.4)

Star mask from the reference (variable-radius dilation scaled by brightness), detection on the
starless residual by normalised convolution, directional two-sided bridging of trails across masked
stars (an isotropic closing cannot bridge long gaps in a thin band: gap ≲ 2√(R·b)). Worked on
synthetic halos, but on real data the touched "stars" were saturated cores, stars on the trail
(gain bug) and sub-only hot pixels/cosmics, none of which a stack-derived star mask addresses;
bridging cost 190 s of 259 s. Do not reintroduce without new evidence.

## Debug dump (v2.2, interactive mode only)

Dialog group "Debug Dump": checkbox + folder (`dumpEnable`, `dumpDir`). CORE functions take an
optional `dump(name, fullFrameArray)` callback (read-only; verified hash-identical with/without).
PJSR `STR_makeDumper` crops each array to the **first preview of the sub window** (full frame if
none) and writes `NN_name.xisf` (32-bit float, hidden ImageWindow + saveAs) into
`<dumpDir>/<subId>[_chN]_<yyyymmdd-hhmmss>/`, plus `meta.json` (version, ids, region, params,
stats, gain/offset grids, timings incl. dump-writing time, full log). Stages in order:
sub_in, stack_in, valid, residual, model, structure_S, [brightness_E], residual_smoothed, significance_z,
weight_seed, weight_grown, weight_final, [saturation_protect],
weight_final, removed, corrected. Per-stage timings are logged ("time: ...").
Reading on the Python side: scratch venv has `xisf` (`xisf.XISF(path).read_image(0)`) + numpy;
the CORE can be re-run on the dumped sub_in/stack_in crop in the V8 harness.

## CORE functions (all prefixed `STR_`, between `// ==== CORE BEGIN` / `END`, pure ES5)

- `STR_num(v, d)` — numeric param with default (keeps 0; `v || d` turned `clipIter = 0` into 3)
- `STR_validMask(sub, stack, N)` → `{mask, count}`
- `STR_robustSigma(data, n, valid)` — iterative 3σ-clipped mean/sigma, no sorting, optional
  validity mask, convergence test, ×1.0135 clip correction → `{mean, sigma, count}`
- `STR_makeInterp(BW, BH, bs, W)` — row-wise bilinear interpolator from block grid (precomputed x
  tables); `STR_expandGrid(...)` — full-res Float32Array of a grid (gain map output)
- `STR_boxBlur(src, W, H, r)` — separable running-sum box blur, O(N) any radius, edge-normalised
- `STR_maxFilter(src, W, H, r)` — separable dilation, skips zeros (weight map is mostly 0)
- `STR_adaptiveSubtract(sub, stack, valid, W, H, P, log)` →
  `{diff, gainGrid, offsetGrid, BW, BH, blockSize, sigma}`. Offset is re-solved after gain clamping.
- `STR_residualWeight(sub, diff, valid, W, H, P, log, dump)` →
  `{weight, mean, sigma, nSeed, nAny, nFull}`
- `STR_skyBackground(img, valid, W, H)` — robust local sky (v2.5), full-res Float32Array
- `STR_saturationProtect(sub, stack, valid, W, H, P, log)` → Float32Array or null (v2.3)
- v2.6: `STR_median`, `STR_radonDetect`, `STR_chord`, `STR_corridor(L, a0, a1, hw, W, H, fn)`
  (row-scan of a rotated band, fn(idx, a, d)), `STR_refineLine`, `STR_lineModel`,
  `STR_elongatedBlobs`, `STR_detectTrails(sub, stack, diff, valid, w, sp, W, H, P, sigma, log, dump)`
  → `{hasTrail, lines, blobs, lineT, region, nCorr}`; `STR_processChannel` result has `trail`.
- `STR_processChannel(sub, stack, W, H, P, log, dump)` — full pipeline, **overwrites `sub`** with
  the corrected data → `{diff, weight, removed|null, gainGrid, ..., nAny, nFull, removedFlux}`

## PJSR section

- `STR_defaults`, `STR_numKeys/boolKeys/strKeys`; settings under `BlackRig/SatelliteTrailRemover/v2`
  (new namespace so stale v1 values are ignored); `Settings.lastReadOK` checked.
- `STR_readChannel / STR_writeChannel` — Float32Array with Array fallback (FourierDeband pattern).
- `STR_showImage(id, data, W, H)` — diagnostic window (UndoFlag_NoSwapFile).
- `STR_processImage(subView, stackView, P, log)` — per channel; stack channel = min(ch, nChS−1);
  diagnostics `<id>_diff`, `<id>_weight`, `<id>_removed`, `<id>_gainmap` (gain/2); HISTORY.
- `STR_run` — interactive, **in place with undo**: `beginProcess(UndoFlag_DefaultMode)` inside
  try/finally → Ctrl+Z / History Explorer. Skips the stack if selected as a sub.
- `STR_runBatch` — `UndoFlag_NoSwapFile` (originals untouched, outputs saved with suffix, default
  `_detrailed`), diagnostics forced off, per-file try/catch; file scan skips names containing the
  suffix.
- `STR_Dialog` — `numCtrl` helper, `makeSection` (v2.8), `setParams/getParams` (used by Reset and
  main), `setExpanded/getExpanded` (layout), sections: Adaptive Match, Residual Subtraction, Trail
  Detection, Diagnostic Outputs, Debug Dump, WBPP Mode, Batch Mode.

## Parameters (STR_defaults)

| Parameter     | Default | Description                                                       |
|---------------|---------|-------------------------------------------------------------------|
| blockSize     | 64      | Block grid size (px)                                              |
| halfWin       | 4       | Half-window in blocks (effective 64×9 = 576 px)                   |
| tau           | 0.1     | Prior width on gain, N(1, τ²)                                     |
| scaledPrior   | true    | v2.3: prior weight σ²/τ² (false = v2.0–2.2, gain pinned at 1)     |
| satGuard      | true    | v2.3: weight forced to 0 around saturated pixels                  |
| satLevel      | 0.95    | Saturation level (sub or stack)                                   |
| satGrow       | 8       | Dilation around saturated pixels (px)                             |
| clipSigma     | 3.0     | Outlier rejection in the gain/offset fit                          |
| clipIter      | 3       | Clip iterations (0 allowed)                                       |
| smoothRadius  | 2       | Box radius for the residual significance (5×5)                    |
| sigmaLow      | 4.0     | z where w starts (0)                                              |
| sigmaHigh     | 8.0     | z where w is 1                                                    |
| structTol     | 0.5     | Structure tolerance β (0 = off)                                   |
| brightTol     | 0.05    | v2.5 brightness tolerance γ (0 = off, v2.4 behaviour)             |
| detectEnable  | true    | v2.6 frame-level detection (false = v2.5 behaviour)               |
| detectZ       | 15      | Line search threshold z                                           |
| blobMinLen    | 300     | Elongated blob: min length (px)                                   |
| blobMinAspect | 10      | Elongated blob: min length/width                                  |
| lineRemoval   | true    | Along-track model removal of detected lines                       |
| alongWin      | 64      | Along-track half window (px)                                      |
| restrictToTrails | true | Only modify detected trails (trail-free frames untouched)         |
| growRadius    | 3       | Dilation of the weight map (px)                                   |
| featherRadius | 2       | Box blur of the weight map (px); keep ≤ growRadius                |

Dialog: "Scale-aware gain prior" checkbox in Adaptive Match; saturation guard checkbox + level +
grow in Residual Subtraction (controls enabled only when the checkbox is on); Debug Dump group.

## PJSR / ES5 rules and pitfalls

- **ECMAScript 5 only**: no let/const, arrows, template literals, classes, nor ES2015 library calls
  (TypedArray.from/.slice/.sort/.fill, Math.hypot/imul/sign, Object.assign, for-of).
- `Float64Array` has no `.sort()` in PJSR — hence sort-free robust statistics.
- PJSR `GroupBox` does NOT support `checkable` — use a separate `CheckBox`.
- **`UndoFlag_NoSwapFile` disables undo** — v1.x used it on the processed sub, so there was no undo.
  Use `UndoFlag_DefaultMode` for in-place processing of user views; NoSwapFile only for new/temporary
  windows and batch.
- getSamples/setSamples with typed arrays + Array fallback; ImageWindow.open returns an array;
  forceClose; saveAs(path, false, false, false, false); HISTORY in 70-char chunks; ids start with a
  letter/underscore; processEvents + console.abortRequested.
- The IDE TypeScript checker flags the `#feature-info` continuation lines — expected, ignore.
- **Never write the two characters slash-star anywhere** (not even inside a `//` comment or a string,
  e.g. a `dir + "/" + "*"` file pattern must be split): the PJSR preprocessor treats it as a block
  comment start -> "Unterminated block comment" (v2.7 bug, found by the user). The V8/Node syntax
  check does NOT catch it; grep for it before every release.

## Testing

No Node on the desktop. A V8 harness was used: Python venv with `mini-racer`
(`from py_mini_racer import MiniRacer`), CORE section extracted between the markers and evaluated,
synthetic 1024×768 frame: sky gradient + nebula, 400 stars (stack PSF σ=1.6, sub σ=1.4), sub
gain 1.03–1.06 + offset gradient, noise σ_sub=0.006 / σ_stack=0.0015, different registration
borders, trails at 8.3 / 1.0 / 0.5 σ per pixel. Full-file syntax check via `new Function(src)` after
stripping `#` lines. Results with defaults (v2.0):

- bright trail (8σ/px): ~100 % removed, 90–99 % where it crosses stars
- faint trails (1σ, 0.5σ per pixel): only ~5–10 % / ~0 % removed — isotropic 5×5 smoothing gives
  SNR ≈ 2.5 for a 1σ/px trail; `smooth=3, ramp 3→6` gets ~30 %
- off-trail sky touched 0.06 %, star pixels touched 0 % (55 % with structTol = 0)
- registration border pixels: never modified
- ~0.2 s for 0.79 Mpx in V8 → expect order 15–30 s per channel at 61 Mpx

v2.1 scenarios (test params `_psfSub`, `_shift`, `_halo`; fixed seed per run; output hash):
- star exclusion OFF reproduces v2.0 hashes exactly (106227145 mild, 866048291 halo)
- "halo" scenario (sub PSF 1.2 vs 1.6, 0.35 px shift, +30 % flux in a σ=7 px halo in the sub only)
  reproduces the user's star touching: OFF touches 2.9 % of star-region px; ON strict with fixed
  grow 1.8 %; ON strict scale 1 0.0 % but bright trail at crossings only 34 % removed; ON bridged
  scale 1: 0.7 % star px (mean |chg| 0.001σ) and 100 % trail removal at crossings
- bridging costs ~0.7 s on the (very dense, 29 % masked) 0.79 Mpx synthetic field

## Frame-level trail detection study (2026-11-14, 26 Blue subs of NGC6729, v2.5 CORE in Node)

Weight-map blobs alone are not enough: faint trails fragment below w = 0.5 (frame 24: longest blob
45 px while the trail crosses the frame), and frames with bad seeing (06, 07, 25; also 08, 09, 12)
have star-touched blobs everywhere (globular cluster lights up). A density-normalised Hough on the
binarised weight map separated the two obvious trails (z ≈ 97) from the rest (≤ 32) but missed
faint trails that the weight never reached.

**Matched-filter Radon on the residual works** (prototype `batch/radon2.py` in scratch):
residual 16× mean-binned → minus 15-px box blur (halos/cluster) → crop 6 px border → minus row and
column medians (CMOS banding, otherwise θ = 90° lines up to z = 21) → divide by robust σ → clip to
[−2.5, 2.5] (stars, hot pixels, bright trails cannot dominate) → line sums S over (θ step 0.15°,
ρ step 1 binned px) with n ≥ 60 binned px → z = S/√n. Results: trails z = 53.7 (24), 41.5 (21),
38.7 + 18.9 (19, two faint trails), 27.1 (25); all 21 other frames ≤ 11.2 → threshold ≈ 15.
Short edge trail of frame 00 (404 × 20 px) is missed by Radon (too short) but caught by the
weight-blob test (len ≥ 300 px and len/width ≥ 10; no false positive among the 26).
**Frames 19 and 25 have faint trails that v2.5 does NOT remove** (below the per-pixel ramp).

Implemented in v2.6 (user: "do all 3, that was the plan") — see next section.

## Trail detection and line removal (v2.6)

Order in `STR_processChannel`: adaptive match → residual weight → saturation guard →
`STR_detectTrails` → restriction → correction `removed = w·r + lineT`.

1. **Line search** `STR_radonDetect(diff, valid, W, H, zThr, sigma, log)`: residual clipped to ±5σ
   **per pixel** (essential: without it bright-star/cluster mismatches inflated 16×16 bins and gave
   3 false lines through the globular cluster in frame 24), 16× binned (bins ≥ 50 % valid),
   minus normalised 15×15 box mean, 6-bin border + 2-bin erosion of invalid areas dropped, minus row
   and column medians (CMOS banding), / robust σ, clipped ±2.5; line sums for θ step 0.2° (900
   angles) and ρ step 1 bin; z = S/√n with n ≥ 60 bins; local maxima in ρ ≥ 0.5·zThr are candidates;
   non-max suppression (Δθ < 2° and Δρ < 6 bins, with θ wrap); lines z ≥ zThr (default 15), max 8.
   ~3 s per 102 Mpx frame in Node.
2. **Blob test** `STR_elongatedBlobs(w, W, H, minLen, minAspect)`: 8-connected BFS of w ≥ 0.5,
   PCA length (extent along major axis) and width √(12 λ2) + 1; trail if length ≥ 300 px and
   length/width ≥ 10 (frame 00's 404 × 22 px edge segment; no false positive in 26 frames).
3. **Refinement** `STR_refineLine`: cross-profiles of the residual (±48 px, clipped ±5σ, usable
   pixels = valid, not saturated, not a stack star: stack − box4(stack) ≤ 3σ) in segments of 512 px
   (1024/2048/4096 if < 3 segments detected); per-segment peak (window edge excluded), centroid
   offset; median/MAD outlier rejection (stars, nebula knots dominated the first version and pulled
   frame 25's faint line ~50 px off); weights SNR capped at 20; |c0| ≤ 40 px, |c1| ≤ 0.2°; two
   successful passes. Half-width from the mean cross-profile minus its wing level (|d| ≥ 32: removes
   nebula pedestals that gave 30–40 px widths): threshold max(0.25·peak, 3σ_profile) + 3 px,
   clamp [4, 30]; ≥ 16 px if refinement failed. (Replaced in v2.9: asymmetric multi-component
   extent over ±96 px with re-centring, clamp [4, 60]; see "Double trails (v2.9)".)
4. **Line model** `STR_lineModel`: corridor (|d| ≤ hw) + 8 px margin; mean residual per 1-px
   along-track × 1-px distance cell over usable pixels, box-averaged ±alongWin (64) px along track,
   2nd pass rejects |r − T0| > 4σ; pedestal = mean of the margin bins subtracted; T clamped ≥ 0;
   attenuated by saturation protection; **blended with the weight**: lineT += (1 − w)·T, so the
   bright trail core (w = 1) is still replaced per pixel (a pure along-track model left a faint
   ghost of frame 21's bright trail: flares), while faint trails (w = 0) get T. Corridors are
   added to the allowed region.
5. **Restriction** (`restrictToTrails`, default on): no trail → image untouched (not even
   written); trail → w kept only in dilated blob regions + corridors.
6. Reporting: console lines (z, endpoints, half-width, peak σ/px, refinement segments), FITS
   keywords STRTRAIL (T/F), STRNLINE, STRZMAX (previous ones replaced), HISTORY, interactive summary
   table, batch CSV `SatelliteTrailRemover_report.csv` in the batch folder (trail-free frames are
   saved as unchanged copies so the integration set stays complete).

Results on the 26 Blue subs (Node): trails in 00 (blob), 19 (2 faint lines, z 35.9/17.5), 21
(bright, z 41), 24 (z 53), 25 (2 faint lines, z 28/22); all other frames: 0 px modified. Visual
before/after checks: all detected trails gone, no ghost. Remaining risk: a faint trail crossing
the globular cluster / bright nebula may need lower `brightTol` or is partly protected.

## WBPP compatibility mode (v2.7)

User request: clean a WeightedBatchPreprocessing output folder in place so that a new low-rejection
WBPP / ImageIntegration run ingests the cleaned frames. Layout (e.g. `D:\Stack\NGC6729HighRejection`):
`registered/<group>/*.xisf` (+ `.xdrz`, `.xnml` side files referencing frames by name,
`ln_reference_frame_data/` sub-folder), `master/master<group>.xisf` (3 images: `integration`,
`rejection_low`, `rejection_high`), `master/master<group>_autocrop.xisf` (cropped: NOT usable),
`master/LN_Reference_<group>.xisf` (ignored). "Use the unclipped stack" = the non-autocrop master.

`STR_runWBPP(root, P, restore)`: per group, master = `master<group>.xisf` (fallback: name starting
"master", containing the group, without "autocrop"), opened with `STR_openMaster` (keeps the window
whose id contains "integration", closes the rejection maps). Detection and restriction forced on,
diagnostics off. Per frame with trail: save cleaned -> `<name>_STRtmp.xisf`, move original ->
`<name>.sat`, move tmp -> `<name>.xisf` (original never lost if saving fails). No trail: untouched,
not written. `<name>.sat` present -> skipped (already cleaned). Restore mode (dialog checkbox +
confirmation MessageBox): every `.sat` back to `.xisf`, cleaned frame deleted. Report
`<root>/SatelliteTrailRemover_WBPP_report.csv` (group, file, trail, lines, blobs, zmax,
modified_px, action, details). Dialog group "WeightedBatchPreprocessing (WBPP) Mode"; WBPP mode
does not need an open reference stack (main() routes before the stack check). Needs
`#include <pjsr/StdIcon.jsh>` and `<pjsr/StdButton.jsh>`.

Verified: file logic with PJSR mocks in Node (rename sequence, master selection, skip on re-run,
restore, report, no leaked windows). NOT verified in PixInsight: File.move/remove, saveAs of the
cleaned frame (properties/keywords kept), multi-image master open.

## Dialog (v2.8)

User: laptops cannot display the full dialog (all groups expanded ~1100 px high). Every former
GroupBox is now a `SectionBar` (`#include <pjsr/SectionBar.jsh>`, official PJSR control, same pattern
as ImageSolver / AlignByCoordinates) + a `Control` section, created by `makeSection(key, title,
withCheck, tip)` inside `STR_Dialog`. Keys: adapt, subtr, detect, output, dump, wbpp, batch. The
on/off switches of detect / dump / wbpp / batch are the bar checkboxes (`bar.enableCheckBox()`;
`d.detectCheck = d.detectBar.checkBox` etc.; their `onCheck` sets `section.enabled`). Expanded
state tracked in `bar.expandedState` (toggled in `onToggleSection(bar, true)`; `section.visible` is
false while the dialog is hidden, so it cannot be read after `execute()`), saved as string setting
`uiExpanded` (comma list; default "" = all collapsed), written even on Cancel; `setExpanded()` sets
the icons directly (`:/process-interface/contract-vert.png` / `expand-vert.png`). Reset does not
touch the layout. Tested with mocks of the PJSR controls + the real SectionBar.jsh (scratch
`mock_dialog.js`, 17 checks); NOT yet run in PixInsight.

## Real PixInsight run of v2.7 (WBPP mode, 2026-11-14, NGC6729, PixInsight 1.9.6, WBPP 3.1.2)

140 frames (Blue 26, Green 27, Red 28 at 120 s; Halpha 29, SII 30 at 1200 s), 23 cleaned:
20 real trails (25 lines + blobs), 3 Halpha frames (08, 09, 24) flagged by a **7 px wide blob at
y ≈ 2**: row 0 of the registered frame brighter than the master by 2–5 σ over ~500 px
(registration interpolation edge artifact) → harmless correction (rows 0–8 replaced) but a false
"trail". Possible fix: ignore blobs within a few px of the border and parallel to it. Checks
(`.sat` vs `.xisf`): modified px agree with the CSV within 1 % (CSV counts w>0 or lineT≠0);
bright-trail corridor (frame 21) level offset 0.001 σ, noise 0.33× (replaced by the stack);
faint trail via line model (frame 24) offset −0.003 σ, noise 0.97×; keywords 76 → 80 (only STR*
+ HISTORY added), 43 XISF properties kept. No missed trail visible in the masters' rejection_high
maps (every rejected line was detected; the script also found faint trails the high rejection
missed). PixInsight speed from file mtimes: 50–64 s per 102-Mpx frame (median 58 s), ~2.3 h for
140 frames. Node harness reproduces PixInsight exactly (frame 24: z 53.2, 244 099 px).
WBPP facts (read in its source): cache freshness by file mtime only (`BPP-ExecutionCache.js`) →
re-running WBPP after cleaning re-registers and overwrites cleaned frames, and v2.7 then skips them
(.sat exists): restore first. Drizzle reads the calibrated frames (`.xdrz` SourceImage) → trails
return in drizzle. WBPP 3.1.2 has a "Pipeline builder" hook (examples/pipeline-builder-example.js)
usable for an in-WBPP integration (discussed with the user, not implemented).

## Double trails (v2.9)

User report (2026-11-15): Red frame 18 (`CDK14_Red_0_120.00_2026-10-30_21-52-06...`, user kept the
original as `..._c_r_ori.xisf` in the registered folder) only partly cleaned. Line 1 (z 66) is a
DOUBLE trail: two components 24 px apart (20.7 and 17.3 σ/px, dip 6.7 σ). Causes: (1) the Radon
non-max suppression merges lines < 6 bins (96 px) apart; (2) the refinement locks onto one
component; (3) the half-width was measured symmetric around it on a ±48 px window with the wing
level from |d| ≥ 32 (which contained the companion) and clamped to 30 px → corridor d ∈ [−30, 30],
outer flank of the other component (up to 18.8 σ/px, 17 % of the trail flux) left; (4) line 1
crosses line 2, so the w-blob is X-shaped, fails the aspect test, and the restriction zeroes w
outside the corridors. Fix in `STR_refineLine` (end): profile over ±96 px, wing level |d| ≥ 72,
3-px smoothing; main run above max(0.25 peak, 3 nz) around the peak (|d| ≤ 8); companion runs
merged if peak ≥ max(0.25 peak, 5 nz) and width 3–60 bins; wings extended while > max(0.02 peak,
3 nz), ≤ 15 px per side; companion must also be significant (> 3 noise above the segment wing
level) in ≥ max(2, 0.6 × main) of up to 8 along-track segments (≥ 256 px) — `segHits()`; without it
Blue 25 (faint, 0.26 σ/px) got false companions from clipped-mean bumps (hot pixels / star
residuals, clip +50 σ) → hw 49, shift −36 px, −0.03 σ over-subtraction; line re-centred on the extent (`STR_chord` recomputed); hw = half extent
+ 3, clamp [4, 60]; `L.nComp`, `L.shift` logged ("N parallel components", "re-centred by"),
CSV details "hw=.. xN". Result on Red 18 (Node): max left 18.8 → 0.27 σ/px, flux left 17 → 1.4 %.
PixInsight's v2.7 output is bit-identical to the Node run of the old core on this frame.
Also in v2.9 (`STR_lineModel`): T = 0 in distance bins whose whole-line mean profile is below
3 × its noise (`sig_d`). Clamping T ≥ 0 on pure noise subtracted E[max(0, N(0, s))] ≈ 0.4 s ≈
0.035 σ/px (s ≈ 0.09 σ for the ±64 px window); measured −0.04 σ/px in the wings of Red 18 line 2,
gone after the fix. Pre-existing bias, but the wider v2.9 corridors would have enlarged it.
Regression v2.8 vs v2.9 on all 19 frames with lines (25 lines; scratch `regress.py` →
`docbuild/reg/`, metric = max |median-along-track profile of cleaned − master| within 60 px):
leftover decreased > 0.02 σ for 11 lines, within ±0.02 σ for 14 (Red 10: 0.17 → 0.19, short faint
line, profile noise ~0.05 σ); v2.9 half-widths mostly 1.5–2× wider (wings); removed components
still only trails (montage checked). Red 18 line 1: 18.86 → 0.29 σ/px. NOT yet run in PixInsight.

## Documentation

`SatelliteTrailRemover_how_it_works.docx` (house format, skill `pixinsight-script-manual`) and
`README.md` (GitHub) next to the script. Built from scratch scripts in the session scratchpad
(`docbuild/build_doc.js`, numbers injected from JSON produced by `doc_an.py`, `fig_real.py`,
`band.py`, `zbatch.py` + `run_zmap.js`, `fig_z.py`). This machine has no LaTeX/LibreOffice/pandoc:
equations rendered with matplotlib mathtext, docx rendered to PDF with Word COM, pages rasterised
with PyMuPDF.

## Open issues / next steps

- v2.0 tested by the user on real data: works well, slight star touching.
- v2.3/2.4 (gain prior + saturation guard) verified in Node on the real frame, NOT yet run in
  PixInsight; user is testing.
- (Done in v2.6) faint-trail sensitivity: line search + along-track model removes trails down to
  ~0.3σ/px (frames 19, 25).
- v2.6 NOT yet run in PixInsight (verified in Node on 26 real frames). PJSR speed of the Radon
  (~360 M simple ops) expected ~5–10 s per frame.
- (Fixed in v2.3) the gain was pinned at 1 by an unscaled prior; now fitted (0.77–1.07 on the
  NGC6729 Blue sub). Star residual RMS (~27 % of amplitude, PSF/registration shape) remains and is
  handled by structTol.
- Off-trail hot pixels / cosmics are also removed (sub-only sources): beneficial, but worth knowing
  when looking at the weight / removed maps.
- Peak memory at 61 Mpx is roughly 1.5–2 GB per channel (several Float32 full frames).
- User guide written (v2.8). Update it (and README.md) with every user-visible change.
- Edge-row false positives (3/140 frames, see the real-run section).
- Drizzle not supported (trails return); in-WBPP integration via the pipeline builder possible.

## Release checklist for every BlackRig PJSR script (run ALL before delivering a changed script)

1. **Script identifier (code signing):** `grep -n '^#feature-id' SatelliteTrailRemover.js` must show
   `#feature-id    <ScriptName> : BlackRig > <ScriptName>`. Without the `<ScriptName> : ` prefix PixInsight
   code signing fails with "Security.generateScriptSignatureFile(): No script identifier has been specified"
   (hit on SatelliteTrailRemover, 2026-11-15). Never write the old form `#feature-id BlackRig > <ScriptName>`.
2. **Preprocessor:** `grep -nE '/\*|\*/' SatelliteTrailRemover.js` must return nothing. The PJSR preprocessor reads
   slash-star as a block comment even inside `//` comments and strings ("Unterminated block comment");
   build file patterns as `dir + "/" + "*"`. A Node/V8 syntax check does NOT catch this.
3. **ES5 only:** `grep -nE '\blet |\bconst |=>|\.fill\(|\.slice\(|Math\.(hypot|imul)|Object\.assign' SatelliteTrailRemover.js`;
   inspect every hit (the script's own methods named `fill` are fine; TypedArray methods are not), and
   search for template literals (backtick strings) separately.
4. **Syntax:** evaluate the whole file in V8 with the `#` preprocessor lines stripped (`new Function(src)`).
5. **Version:** bump the `#define ..._VERSION` and the version in the header comment, README and manual.
6. **Author and license:** author **Erellaz** only (header, README, LICENSE, manual byline/footer and .docx
   properties); grep every delivered file, including the .docx XML and `docProps/core.xml`, for any other
   personal name. License **MIT**: "License: MIT" in the header and README, `LICENSE` file next to the script.
7. **Code signing:** if `<ScriptName>.xsgn` exists next to the script, any edit invalidates it. Tell the user
   to re-sign in PixInsight (developerId BlackRig); Claude cannot sign.
8. **Report** what was verified in Node / against mocks and what still needs a run inside PixInsight.

## Workflow for any change

0. Preprocessor check: `grep -nE '/\*|\*/' SatelliteTrailRemover.js` must return nothing.
1. ES5 check: `grep -nE '\blet |\bconst |=>|\.fill\(|\.slice\(|Math\.(hypot|imul)' SatelliteTrailRemover.js`
2. Run CORE in the V8 harness (synthetic test) and syntax-check the full file.
3. Bump `STR_VERSION` and the header comment version.
4. State what was verified in V8 vs what needs PixInsight testing.
5. The user tests in PixInsight from `D:/Pixinsight/BlackRigScripts/Desat/SatelliteTrailRemover.js`.
