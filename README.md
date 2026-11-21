# DebandDesat for PixInsight

Removes CMOS banding and satellite trails from your light frames, on frames you open yourself, in batch, or inside
WeightedBatchPreprocessing (WBPP):

- **Deband** removes row and column banding and periodic pattern noise in the Fourier domain, with star protection.
- **Desat** removes satellite trails from registered frames by comparing each frame with a trail-free stack of the
  same frames and subtracting only the trail.
- **DebandDesat_WBPP** runs both in WBPP: Deband before registration, Desat after it. **Deband_WBPP** runs Deband
  alone, and **Desat_WBPP** Desat alone.
- **AdaptiveSubtraction** removes an unwanted signal from an open image by subtracting a reference image or model of
  it (a star model, a trail, a gradient), matched to the image locally by robust least squares. It is interactive
  only: no batch mode, no WBPP step.

In WBPP (Pipeline tab › Pipeline builder) you select one builder: `Desat_WBPP.js` for trails only,
`Deband_WBPP.js` for banding only, `DebandDesat_WBPP.js` for both.

This folder is the complete release: every script and document of Desat, Deband and AdaptiveSubtraction.

Desat 3.0 · Desat_WBPP 1.4 · Deband 2.1 · DebandDesat_WBPP 1.0 · Deband_WBPP 1.0 · TrailBlink 1.2 · AdaptiveSubtraction 1.2 · Author: Erellaz · License: MIT

## Names

The script names follow one rule: **Deband** removes banding, **Desat** removes satellite trails, **DebandDesat** does
both, and a name ending in **_WBPP** is a WBPP pipeline builder. Former names (until November 2026):
SatelliteTrailRemover → `Desat.js`, SatelliteTrailRemover_WBPP → `Desat_WBPP.js`, DebandDesat → `DebandDesat_WBPP.js`,
FourierDeband → `Deband.js`, TrailLabeler → `TrailBlink.js`. Saved parameters and WBPP caches carry
over. The reports are now `Desat_report.csv` and `Deband_report.csv`; TrailBlink also reads the old names.

## Start here

Read **`Desat_quick_start.pdf`** (also as `.docx` and `QUICK_START.md`). It walks you through
installing the script, testing it on a few frames, and adding it to WBPP. Its last page explains how the method works.

## Contents

| File | What it is |
|---|---|
| `Desat.js` | The standalone script (Script › BlackRig › Desat). Use it to test and to set the parameters. |
| `Desat.xsgn` | Code signature of the standalone script. Keep it next to the `.js` file. |
| `Deband.js` | The standalone banding removal script (Script › BlackRig › Deband): active image or a batch of files. Use it to test and to set the parameters of the deband step. |
| `Deband.xsgn` | Code signature of Deband. Keep it next to the `.js` file. |
| `README_Deband.md`, `Deband_how_it_works.docx` | Deband: overview; user guide and full description of the method. |
| `Desat_WBPP.js` | The WBPP step, selected in WBPP › Pipeline tab › Pipeline builder. It uses the parameters saved by the standalone script. Not code-signed, by design: WBPP evaluates it as text (see `README_Desat_WBPP.md`, Installation). |
| `DebandDesat_WBPP.js` | Alternative WBPP pipeline builder with two steps: banding removal (Deband 2.1) before registration, and the same trail removal step as `Desat_WBPP.js` after it. Select it instead of `Desat_WBPP.js`. Its deband parameters are those saved by `Deband.js` (without saved parameters, Deband's defaults are used). Not code-signed, by design. See `README_DebandDesat_WBPP.md`. |
| `Deband_WBPP.js` | WBPP pipeline builder with the deband step of `DebandDesat_WBPP.js` only, for banding removal without trail removal. Not code-signed, by design. See `README_DebandDesat_WBPP.md`. |
| `README_DebandDesat_WBPP.md` | DebandDesat_WBPP: what it does, settings, disk, speed and memory, checking the result, testing. |
| `Desat_quick_start.pdf` / `.docx`, `QUICK_START.md` | Quick start guide. |
| `README_Desat.md` | The standalone script: modes, usage, limitations, version history. |
| `README_Desat_WBPP.md` | The WBPP step: what it does, settings, speed and memory, reruns, limitations, verification. |
| `Desat_how_it_works.docx` | Full description of the method, with equations, figures and validation; section 13 describes other satellite models for single images (ephemeris, star catalogue). |
| `TrailBlink.js` | Optional checking tool (Script › BlackRig › TrailBlink): shows each frame before and after cleaning and records your verdicts (correct, false positive, incomplete removal, missed trail) in `trail_labels.json`. Its Deband QC mode does the same for the frames debanded by DebandDesat_WBPP. See `README_TrailBlink.md`. |
| `TrailBlink.xsgn` | Code signature of TrailBlink. Keep it next to the `.js` file. |
| `README_TrailBlink.md` | TrailBlink: modes (Review, Hunt, Deband QC), drawing, views, the labels file. |
| `AdaptiveSubtraction.js` | Adaptive subtraction of a reference image or model B from an open image A (Script › BlackRig › AdaptiveSubtraction). See `README_AdaptiveSubtraction.md`. |
| `AdaptiveSubtraction.xsgn` | Code signature of AdaptiveSubtraction. Keep it next to the `.js` file. |
| `README_AdaptiveSubtraction.md`, `AdaptiveSubtraction.png` | AdaptiveSubtraction: modes, parameters, outputs; its dialog. |
| `AdaptiveSubtraction_how_it_works.docx` | AdaptiveSubtraction: user guide and full description of the method, with use cases, equations, figures and validation. |
| `LICENSE.txt` | MIT license. |
| `CONTRIBUTING.md`, `tests/`, `tools/` | For developers: how the code is organised, the PixInsight rules it must follow, and the tests to run before submitting a change. Not needed to use the scripts. |

Use the versions together, as shipped: Desat_WBPP 1.4 or DebandDesat_WBPP 1.0 with Desat 3.0, and DebandDesat_WBPP 1.0
and Deband_WBPP 1.0 with Deband 2.1.

## Requirements

Tested with PixInsight 1.9.6 and WBPP 3.2.0 on Windows. DebandDesat_WBPP and Deband_WBPP have not yet run inside
PixInsight: they were tested in Node.js against WBPP's own pipeline code, with mocks of the PixInsight classes.
