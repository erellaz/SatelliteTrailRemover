# Deband for PixInsight

Removes CMOS row/column banding (and optionally checkerboard and periodic interference
patterns) by estimating them in the 2-D Fourier spectrum and subtracting the estimate from
the original image. Stars, halos and saturated cores are protected so they do not leak into
the estimate; optional adaptive amplitude matching handles bands whose strength varies
across the sensor. Single images or batches of calibrated subs.

* `Deband.js` – the script (version 2.1). Install: PixInsight › Script › Feature Scripts › Add
  (folder containing the file), then Script › BlackRig › Deband.
* In WBPP: `Deband_WBPP.js` (banding only) or `DebandDesat_WBPP.js` (banding, then satellite trails)
  debands every light frame before registration, with the parameters saved by this script. See
  `README_DebandDesat_WBPP.md`.
* `Deband_how_it_works.docx` – user guide and technical description: quick start,
  recommended settings, the algorithm step by step with equations, validation, troubleshooting.

The dialog sections are collapsible (click a section bar to open or close it), so the dialog
fits on laptop screens; the script remembers which sections were open.

The numerical core between `// ==== CORE BEGIN` and `// ==== CORE END` is plain ECMAScript 5
without PixInsight objects; the dialog and file handling are tested against the
PixInsight classes.

Author: Erellaz. License: MIT (see [`LICENSE.txt`](LICENSE.txt)).
