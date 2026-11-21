# DebandDesat_WBPP: banding and satellite trail removal in WBPP

A pipeline builder for WeightedBatchPreprocessing (WBPP) that adds two steps to the standard light pipeline:

1. **Deband**, before registration: CMOS row and column banding is removed from every light frame with the
   Deband 2.1 method.
2. **Satellite trail removal**, after registration: the Desat 3.0 step, unchanged from
   `Desat_WBPP.js` 1.4.

DebandDesat_WBPP 1.0 · Author: Erellaz · License: MIT

Not yet run inside PixInsight. It was tested in Node.js against WBPP 3.1.2's own operation queue and cache, with
mocks of the PixInsight classes (see [Testing](#testing)).

## Banding only: Deband_WBPP

`Deband_WBPP.js` 1.0 is the same builder without the trail removal step: select it instead of
`DebandDesat_WBPP.js` to remove banding only. Its deband step is a verbatim copy (the file is generated from
`DebandDesat_WBPP.js` by `tools/make_Deband_WBPP.py`), so everything below about the deband step applies to it, and
it gives bit-identical debanded frames. Its only setting is `FDW_THREADS`. This is simpler than setting
`DD_DETRAIL = false` in `DebandDesat_WBPP.js`, and nothing is lost when an update replaces the files.

## Installation

1. Copy `DebandDesat_WBPP.js` next to `Desat.js`.
2. In WBPP › Pipeline tab › Pipeline builder: enable it and select `DebandDesat_WBPP.js` (instead of
   `Desat_WBPP.js`; WBPP takes one builder).
3. Do not code-sign it. WBPP reads the file as text and evaluates it; it has no `#feature-id` line, so code signing
   fails, and WBPP does not check a signature.

## Settings

Each step uses the parameters saved by its standalone script:

- **Deband:** Deband (Script › BlackRig › Deband, `Deband.js` in this folder). Run it once, set the parameters, and close the
  dialog with OK or Cancel. Used here: the targets (horizontal and vertical bands, periodic spikes, checkerboard),
  the notch width, *Keep structures larger than*, star protection, refine passes, strength and adaptive amplitude
  matching. Its diagnostic outputs and file options are not used.
- **Trail removal:** Desat (Script › BlackRig › Desat), as with
  `Desat_WBPP.js`.

Without saved settings, the defaults of Deband 2.1 and Desat 3.0 are used. The console
says which.

Constants at the top of `DebandDesat_WBPP.js`:

| Constant | Default | Effect |
|---|---|---|
| `DD_DEBAND` | `true` | Deband step on or off. |
| `DD_DETRAIL` | `true` | Trail removal step on or off (for banding only, select `Deband_WBPP.js` instead). |
| `FDW_THREADS` | `0` | Frames debanded at the same time: 0 = automatic (8), 1 = one at a time; always limited by the processors and the memory. |
| `STRW_THREADS` | `0` | The same for trail removal. |
| `STRW_REF_REJECTION`, `STRW_REF_SIGMA_LOW`, `STRW_REF_SIGMA_HIGH` | `"winsorized"`, 4, 2.5 | Pixel rejection of the trail step's reference stack (see `README_Desat_WBPP.md`). |

## What the deband step does

- **Where:** right after calibration, cosmetic correction and debayering, before measurement, reference frame
  selection and registration. Banding lies along the sensor's rows and columns; registration rotates and shifts
  the frames (by up to 180°, for a meridian flip), after which it no longer does. One step per light group.
- **Output:** a debanded copy of every light frame in `<output>/debanded/<group>/`, with the same file name. WBPP
  continues with it: measurement, weights, registration, local normalization, integration and drizzle see the
  debanded frame. The input file is never modified.
- **Disk:** one copy of every light frame, the size of the calibrated frames (about 400 MB per 100-Mpx
  monochrome frame).
- **Keywords:** HISTORY (Deband version and parameters) and `FDRMS`, the RMS of what was removed. The
  frame's other keywords and properties are kept.
- **Report:** `<output>/debanded/<group>/Deband_report.csv`: per frame, the input file, the removed RMS and
  its ratio to the group's median. The console warns about frames above 2× the median (unusually strong pattern
  noise).
- **Removed RMS:** measured 64 px or more from the frame edges. The first and last rows of calibrated frames
  often differ strongly from the rest (by ±3σ in the NGC1097 frames below); deband flattens them too, but they
  would dominate a whole-frame RMS.
- **Cache:** a rerun skips the frames whose input file and parameters are unchanged. Changing a Deband
  setting reprocesses every frame.
- **Colour (CFA) frames:** debanded after debayering, in RGB, never as a raw mosaic, whose Bayer pattern would be
  taken for a periodic pattern. This needs WBPP's debayer output "Combined RGB"; with separated channels the
  group is not debanded, and both the builder panel and the console say so.
- **Errors:** a frame that fails is used without debanding, with a warning.

## Speed and memory

Measured in Node.js on NGC1097 calibrated frames (11664 × 8750, defaults): about 40 s per frame on one core, and
up to 3.4 GB for the process. The step counts 30 bytes per pixel and channel per frame in progress (3 GB for a
100-Mpx monochrome frame) and runs as many frames at once as fit in 80 % of the available memory, at most 8. The
console shows the number. PixInsight's speed has not been measured yet.

## Checking the result

TrailBlink 1.2 (Script › BlackRig › TrailBlink) has a **Deband QC** mode: open the WBPP output folder. It
shows each frame before deband and debanded, side by side, with a Detail view (bands stand out) and a Removed view
(the removed pattern), the banding before and after, and the removed RMS relative to the group. You record a
verdict per frame (Clean, Residual banding, Artefact, Unsure). See `README_TrailBlink.md`.

## What it removes on real frames

Twelve NGC1097 calibrated frames (CDK14, 300 s, three each of L, R, G and B) were debanded with Deband 2.1's
core in Node.js, with the defaults:

- **Row banding:** about 0.025–0.038σ RMS per 4-row band of the frame interior was removed (σ = noise per pixel).
  The high-passed row profile went from 0.03–0.06σ to 0.02–0.03σ. The removed column pattern was 0.006σ RMS:
  these frames have almost no column banding.
- **Fixed part:** in L, G and B, the removed row patterns of different frames are correlated (+0.3 to +0.4).
  That part does not average out in the stack, whose noise drops by the square root of the number of frames. In R
  they are not correlated.
- **Edges:** the first and last rows (about ±3σ) are flattened.
- **Elsewhere:** what was removed apart from row and column structure is 0.013–0.014σ RMS. Over the whole frame,
  edge rows included, 0.15–0.20σ RMS was removed in L, G and B and 0.05σ in R.

Not yet measured: the effect on the integrated master.

## Testing

Developer tests in `tests/` (Node.js, not part of the release package):

- `test_debanddesat.js` (41 checks): the deband step inside WBPP 3.1.2's operation queue and cache, with a mock
  pipeline (calibration, cosmetic correction, debayer, measurement, registration, trail removal, integration) and
  synthetic banded frames (mono and CFA):
  - position in the pipeline (after cosmetic correction and debayer, before measurement and registration), one
    step per light group;
  - banding reduced (rows 0.84 → 0.17σ, columns 0.42 → 0.08σ, worst frame), a satellite trail left alone (0.1 %
    of its flux changed) and then removed by the trail step (94.5 %);
  - debanded pixels bit-identical to Deband 2.1's core run directly, with and without threads, with
    row-only iterators and with a failing thread;
  - measurement and registration read the debanded frames; HISTORY and `FDRMS` written; report; cache; settings
    changes; CFA with combined and separated debayer output; the two switches; inputs never modified.
- `test_builder.js` (82 checks) run on `DebandDesat_WBPP.js`: the trail step behaves exactly as in
  `Desat_WBPP.js` 1.4.
- `test_debanddesat.js` run on `Deband_WBPP.js` (38 checks): the same checks of the deband step, and no trail
  step in the pipeline, nothing written to `detrailed/`.
- `check_core.js`: both embedded cores are verbatim copies of Deband 2.1's and Desat 3.0's, and the core of
  `Deband_WBPP.js` is Deband 2.1's.

Not covered: PixInsight's own file reading and writing, threads and memory, and WBPP's real operations around the
step.

## Version history

| Version | Changes |
|---|---|
| 1.0 | First version: Deband 2.1 before registration; the Desat WBPP builder 1.4 after it (core 3.0 and cache keys unchanged: with deband off, its cached results are reused). |

## License

MIT. See `LICENSE.txt`.
