# SatelliteTrailRemover for PixInsight

A PixInsight script (PJSR) that removes satellite trails from **registered sub-exposures** by comparing each sub with a reference stack. That referenced stack should be computed with a high rejection clipping (eg: Windsorized Sigma Clipping with 2.5 sigma, data dependant), so it is clean, with no satellite trails. Then the script cleans the trails out of each affected lights, in a corridor along each trail, performing adaptive subtraction so the underlying data is not affected. Then you can integrate those cleaned lights again, but with no (or a very gentle) pixel rejection and keep the faint signal without trails showing.

Version 2.9 · Author: Erellaz · License: MIT

## How it works

1. **Adaptive match.** The reference stack is fitted to each sub with a smooth local gain and offset, to absorb transparency and sky-background changes. The fit uses windowed least squares with a gain prior and sigma clipping.
2. **Residual.** The sub minus the matched stack. The scene cancels out, and a trail, which is absent from the stack, stands out.
3. **Frame-level detection.** A matched-filter line search (Radon transform of the binned, cleaned residual, z = line sum / √length) finds long trails down to about 0.2σ per pixel. A test for elongated blobs catches short trails, for example across a corner of the frame. Frames without a trail are left untouched.
4. **Removal.** Bright trail cores are replaced pixel by pixel by the matched stack, which also follows flares. Faint trails are removed with a model averaged along the track, which keeps the sub's own noise. The corridor around each line follows the measured cross-profile of the trail, so **double trails** (satellites in formation, aircraft with two lights) are removed whole. Stars, saturated cores, and halos of bright stars are protected by structure, brightness and saturation tolerances.

The full description, with equations, figures and validation, is in [`SatelliteTrailRemover_how_it_works.docx`](SatelliteTrailRemover_how_it_works.docx).

## Features

- **Interactive mode:** processes the selected open images in place, with undo (Ctrl+Z / History Explorer).
- **Batch mode:** processes a folder of FITS/XISF subs against an open stack. Outputs get a suffix (default `_detrailed`), and a CSV report is written.
- **WBPP mode:** cleans a WeightedBatchPreprocessing output folder in place, so that a new integration picks up the cleaned frames.
  - Reference: the full-size master of each group, `master/master<group>.xisf`.
  - For each cleaned frame in `registered/<group>`, the original is kept as `<name>.sat`. Frames without a trail are not touched.
  - A restore option puts the originals back.
- **Reporting:** FITS keywords `STRTRAIL`, `STRNLINE` and `STRZMAX` plus a `HISTORY` line in every processed frame, a console report per frame, and CSV reports.
- **Diagnostics:** residual, weight map, removed component and gain map images, plus an optional dump of every intermediate stage.
- **Collapsible dialog:** fits on laptop screens, and the layout is remembered.

## Installation

1. Copy `SatelliteTrailRemover.js` into a folder of your choice.
2. In PixInsight: **Script › Feature Scripts…**, click **Add**, select the folder, then **Done**.
3. Run it from **Script › BlackRig › SatelliteTrailRemover**.

Alternatively, use **Script › Execute Script File…** without installing.

## Usage

**Data.** Use registered, linear subs. The reference must be a full-size integration of the same frames, same filter and same geometry, ideally with pixel rejection. Don't use a cropped master such as WBPP's `_autocrop` file, and don't use unregistered frames.

**Interactive mode.**
1. Open the stack and the subs.
2. Run the script, choose the reference stack and select the subs.
3. For the first run, open *Diagnostic Outputs* and tick *Removed component*. It should show only the trail.

**After a WBPP run.**
1. Enable *WBPP Mode* (checkbox in its section bar) and select the WBPP output folder, the one that contains `registered` and `master`.
2. Execute.
3. Integrate `registered/<group>/*.xisf` with ImageIntegration. You can now use a gentler rejection. The `.sat` originals are not picked up, and the local-normalization files still match.

Before re-running WBPP itself on the same folder, restore the originals. WBPP re-registers frames whose registered file changed and would overwrite the cleaned frames.

The defaults are a good starting point. The main knob is **Line threshold (z)** (default 15). Lower it to catch fainter trails, raise it if frames get flagged without a visible trail.

## Results on real data

The script ran inside PixInsight (v2.7) in WBPP mode on 140 registered 102-Mpx frames of NGC 6729 in five filters. In one of those frames a double trail was only partly removed; v2.9 fixes this.

- **Cleaned:** 23 frames.
  - **20 frames** had real satellite trails, including faint ones the high-rejection integration did not reject. Nothing else in those frames was modified.
  - **3 Hα frames** were flagged because of a registration edge artifact in the first rows of the frame. The correction there is harmless.
- **Missed trails:** every trail visible in the rejection maps of the WBPP masters was detected.
- **Bright-trail corridors:** they match the surrounding sky level to within 0.001σ.
- **Speed:** about 1 minute per frame in PixInsight.

## Limitations

- **Drizzle:** drizzle integration uses the calibrated frames, which are not cleaned, so trails come back in a drizzled stack.
- **Very faint or very short trails:** they can stay below the detection threshold.
- **Bright light already in the reference:** a trail crossing a bright nebula or galaxy core is partly protected by the brightness tolerance.
- **Replaced pixels:** in fully replaced trail pixels, the frame carries the values of the matched stack, not an independent measurement.

## Requirements

PixInsight with the PJSR runtime. The script is written in ECMAScript 5 and has no external dependencies. Tested with PixInsight 1.9.6 (WBPP 3.1.2) on Windows.

## Changelog

| Version | Changes |
|---|---|
| 2.9 | Double and parallel trails: the corridor is measured on the cross-profile (±96 px), re-centred on the trail and includes parallel components; half-width up to 60 px. |
| 2.8 | Collapsible dialog sections with remembered layout; mode switches in the section bars. Processing unchanged. |
| 2.7 | WBPP mode (originals kept as `.sat`, restore option, CSV report). |
| 2.6 | Frame-level trail detection, removal of faint trails along the track, only detected trails modified, FITS keywords, batch report. |
| 2.5 | Brightness tolerance (halos and spikes of bright stars protected). |
| 2.3 | Noise-scaled gain prior (gain really fitted), saturation guard. |
| 2.0 | Adaptive subtraction of the matched stack, undo. |

## License

MIT. See [`LICENSE`](LICENSE).
