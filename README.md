# SatelliteTrailRemover for PixInsight

Removes satellite trails from registered light frames by comparing each frame with a trail-free stack of the same
frames and subtracting only the trail. It runs on frames you open yourself, in batch, or as a step inside
WeightedBatchPreprocessing (WBPP).

SatelliteTrailRemover 2.9 · WBPP step 1.3 · Author: Erellaz · License: MIT

## Start here

Read **`SatelliteTrailRemover_quick_start.pdf`** (also as `.docx` and `QUICK_START.md`). It walks you through
installing the script, testing it on a few frames, and adding it to WBPP. Its last page explains how the method works.

## Contents

| File | What it is |
|---|---|
| `SatelliteTrailRemover.js` | The standalone script (Script › BlackRig › SatelliteTrailRemover). Use it to test and to set the parameters. |
| `SatelliteTrailRemover.xsgn` | Code signature of the standalone script. Keep it next to the `.js` file. |
| `SatelliteTrailRemover_WBPP.js` | The WBPP step, selected in WBPP › Pipeline tab › Pipeline builder. It uses the parameters saved by the standalone script. Not code-signed, by design: WBPP evaluates it as text (see `README_WBPP.md`, Installation). |
| `SatelliteTrailRemover_quick_start.pdf` / `.docx`, `QUICK_START.md` | Quick start guide. |
| `README_standalone.md` | The standalone script: modes, usage, limitations, version history. |
| `README_WBPP.md` | The WBPP step: what it does, settings, speed and memory, reruns, limitations, verification. |
| `SatelliteTrailRemover_how_it_works.docx` | Full description of the method, with equations, figures and validation; section 13 describes other satellite models for single images (ephemeris, star catalogue). |
| `LICENSE` | MIT license. |

The two scripts are a matched pair: use the WBPP step 1.3 with the standalone script 2.9.

## Requirements

Tested with PixInsight 1.9.6 and WBPP 3.2.0 on Windows.
