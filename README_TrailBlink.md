# TrailBlink for PixInsight

A PixInsight script for checking the results of Desat frame by frame and recording what you see:
which trails were removed correctly, which removals were not trails, which trails are still visible, and which
were missed. Its Deband QC mode does the same for the banding removed by the DebandDesat_WBPP WBPP builder. The verdicts
go into a JSON file that can be used to measure and improve the methods.

Version 1.2 · Author: Erellaz · License: MIT

Version 1.1 runs in PixInsight. The Deband QC mode added in 1.2 has been tested in Node.js against mocks of the
PixInsight classes, not yet inside PixInsight (see [Testing](#testing)).

## Installation

1. Copy `TrailBlink.js` into the folder that holds `Desat.js`.
2. In PixInsight: **Script › Feature Scripts…**, click **Add**, select that folder, then **Done**.
3. Run it from **Script › BlackRig › TrailBlink**.

## What it works on

The output folder of a WBPP run cleaned by Desat: the folder that holds `registered/` and
`detrailed/`. Either the WBPP step or the standalone script's WBPP mode produces it. The script reads, per group:

- the registered frames, `registered/<group>/*.xisf`;
- the cleaned copies, `detrailed/<group>/*.xisf` (only frames with a trail have one);
- the reference stack, `detrailed/<group>/STR_reference.xisf` (or `master/masterLight_<group>.xisf`), for the
  residual view;
- the report, `detrailed/<group>/Desat_report.csv`, for the script's detections.

For Deband QC, the output folder of a WBPP run with the DebandDesat_WBPP builder (it holds `debanded/`):

- the debanded frames, `debanded/<group>/*.xisf`;
- the report, `debanded/<group>/Deband_report.csv`, which gives each frame's input file (the frame before
  deband, e.g. in `calibrated/` or `cosmetized/`) and the removed RMS.

It never modifies any of these files. It writes only `trail_labels.json` in the folder you open. The last
folder is reopened at the next start. A folder with `debanded/` but no `registered/` opens in Deband QC.

## Modes

- **Review cleaned frames:** every frame the script cleaned, with the registered frame on the left and the
  cleaned frame on the right. Verdicts: **Correct** (C), **False positive** (F), **Incomplete removal** (I),
  **Missed trail** (M), **Unsure** (U).
- **Hunt all frames:** every registered frame in one panel, showing the final frame (the cleaned copy if there is
  one, the registered frame otherwise), to find trails the script missed. Verdicts: **No trail** (C), **Missed
  trail** (M), **Incomplete removal** (I), **Unsure** (U).

- **Deband QC:** every frame DebandDesat_WBPP debanded, with the frame before deband on the left and the debanded
  frame on the right, in sensor coordinates (before registration). Verdicts: **Clean** (C: the banding is gone
  and nothing else changed), **Residual banding** (R), **Artefact** (A: deband removed or added something that is
  not banding, e.g. a streak along the row of a bright star), **Unsure** (U). *Strongest first* lists the frames
  with the strongest removed pattern, relative to their group, first.

**Correct**, **No trail** and **Clean** move to the next frame when *Advance after Correct / No trail / Clean* is
ticked. A verdict that contradicts another (for example Correct after Incomplete removal) asks before removing it.

## Drawing trails

Press **False positive**, **Incomplete removal** or **Missed trail** (or F / I / M), then click both ends of each
trail; draw as many as needed. While drawing, a dashed line follows the mouse from the first end. **Esc** stops
drawing; **Backspace** removes the last trail (or the first end, if only one is set). For a false positive, draw
along the feature the script removed by mistake. In Deband QC, **Residual banding** and **Artefact** (R / A) mark
segments the same way: along a band that is still visible, or along the artefact.

## Views

| Key | View | What it shows |
|---|---|---|
| 1 | Image | The linear frames with an automatic stretch, the same on both panels. Contrast 1–10. |
| 2 | Residual | Frame minus the reference stack matched to it, in noise units. Faint trails stand out. In Deband QC: **Detail**, the frame minus its smooth background (that of the debanded frame, on both panels), in noise units; bands stand out. |
| 3 | Removed | Right panel: registered minus cleaned, i.e. what the script subtracted (Review mode); in Deband QC, before minus debanded, the removed pattern. Not in Hunt mode. |

In Deband QC, single-row bands show best from 1:1 upwards: zoomed out, a screen pixel averages several rows.
Deband keeps bands longer than *Keep structures larger than* (128 px by default) on purpose, as large-scale
signal; zoomed out, the Detail view of the debanded frame can show them as broad waves.

Deband QC also measures the banding of both frames when a frame loads and shows it on the detail line:
`row bands 0.46 -> 0.08, column bands 0.28 -> 0.03 (noise per px)`. Each number is the RMS of the high-passed
row (column) means of the frame minus its smooth background, stars excluded, in units of the noise per pixel.

- **Zoom:** mouse wheel, or + and −. **0** or Home shows the whole frame.
- **Pan:** drag with the mouse.
- **Resolution:** zoomed out, the panels show 4×4-binned means (lower noise, faint trails show better). From 1:1
  upwards they show full-resolution pixels.
- **Script detections (D):** the script's lines (dashed lines on each side, with their score z) and blobs
  (dotted circles). *gap* keeps the dashed lines at least that many screen pixels from the trail, so the trail
  itself stays visible; *centre line* also draws the line's centre.
- **Navigation:** Next / Prev (→ / ←, N / P, Page Down / Page Up), and *Next unlabeled*.

The status line shows the drawing state, how many frames of the list are labelled, the zoom, the noise per pixel
and per bin, and the mouse position in full-resolution pixels.

## The labels file

`<folder>/trail_labels.json` is saved after every change. Its `conventions` entry explains every field. Per frame
(key `<group folder>/<file name>`), it holds the script's action and detections and, for each mode (`review`,
`hunt`, `deband`), the verdicts (`flags`), the drawn segments (`trails`: kind and both ends, in full-resolution
pixels of the registered frame, or for Deband QC of the frame before registration; origin at the top-left pixel),
the note, the time and the labeller version. Deband QC frames have their own keys (the debanded file names).

The file is plain ASCII (characters such as the degree sign in file names are written as `\u` escapes). It has the
same format as the files of the Python TrailLabeler 1.0, so both tools can work on the same folder; the Python tool
keeps the Deband QC verdicts but does not show them.

## Memory and speed

Each frame is read in full: the registered frame and, in Review mode, its cleaned copy, plus the group's reference
stack (kept while you stay in the group). That is about 1.2 GB for 100-megapixel monochrome frames. Moving to
another frame takes a few seconds (reading plus the statistics of the residual view). The Python tool loaded the
next frame in the background; this version does not. In Deband QC, the two frames (no reference stack) take about
0.8 GB, and measuring their banding adds two passes over the pixels.

## Testing

A Node.js test (not part of this package) ran the script against mocks of the PixInsight classes, with real
11664×8750 frames from a WBPP run cleaned by Desat 3.0 (212 frames, 47 cleaned):

- the folder scan gives the same frames, groups, indices, report columns and references as the Python tool;
- the frame statistics used for display (gain against the reference, noise per pixel and per bin, stretch)
  agree with the Python tool to within 0.4 %;
- every view renders at the zoomed-out and full-resolution levels;
- drag, wheel zoom, keys, drawing a trail with two clicks, verdict conflicts (with confirmation), automatic
  advance, notes and Hunt mode behave as described;
- opening a folder and moving between frames does not rewrite the labels file, and labels written by this script
  are read correctly by the Python tool.

Deband QC (1.2), on a synthetic folder of four banded frames (1536 × 1024) debanded with Deband 2.1's core,
with a DebandDesat_WBPP report:

- a folder with only `debanded/` opens in Deband QC, with its buttons; a folder without it opens in Review again;
- the banding measured on load drops as expected (rows 0.46 → 0.08, columns 0.28 → 0.03 noise per pixel, for
  bands of 0.5σ per row); at full resolution the Detail view shows row-to-row jumps 10× larger before deband than
  after;
- Image, Detail and Removed render without a reference stack, zoomed out and at full resolution;
- Residual banding drawn with two clicks, Clean asking before removing it, Artefact, the labels file (mode
  `deband`, plain ASCII), *Strongest first*, and a frame whose input file is missing (a message, no crash);
- the Python TrailLabeler loads the labels file and keeps the Deband QC verdicts when it saves.

It does not exercise PixInsight's own drawing, file reading or dialog layout.

## Version history

| Version | Changes |
|---|---|
| 1.2 | Renamed TrailBlink (was TrailLabeler). Deband QC mode, for the frames debanded by the DebandDesat_WBPP WBPP builder. |
| 1.1 | PixInsight version of the Python TrailLabeler 1.0, same labels file. Fixed: opening a folder could overwrite the label of the first frame of the list with an empty one (also fixed in the Python tool, 1.0.1). |
| 1.0 | Python tool (Tk), Review and Hunt modes. |

## License

MIT. See `LICENSE.txt`.
