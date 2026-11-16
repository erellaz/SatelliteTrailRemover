# SatelliteTrailRemover: quick start

Removes satellite trails from your light frames, either on frames you open yourself or as a step inside
WeightedBatchPreprocessing (WBPP). Author: Erellaz · License: MIT.

The package contains two scripts that work together:

| File | What it is |
|---|---|
| `SatelliteTrailRemover.js` (2.9) | The standalone script. You use it to test on a few frames and to set the parameters. |
| `SatelliteTrailRemover_WBPP.js` (1.3) | The WBPP step. It cleans every registered light frame during a WBPP run, with the parameters saved by the standalone script. |

Use the two versions together, as shipped.

## 1. Install the standalone script

1. Copy both `.js` files into a folder of your own.
2. In PixInsight: **Script › Feature Scripts…**, click **Add**, select that folder, then **Done**.
3. The script appears as **Script › BlackRig › SatelliteTrailRemover**.

The WBPP file does not appear in the Script menu. That is expected: WBPP loads it directly (step 3).

## 2. Test on a few frames

Start with a handful of frames that show trails, to see what the script does and to adjust it to your data.

**What you need:**
- Some **registered** light frames, for example from WBPP's `registered/<group>` folder.
- A **reference stack** of the same frames: a full-size integration with strong pixel rejection, so that it has no
  trails. For example, use Winsorized sigma clipping with sigma high 2.5. Don't use WBPP's cropped `_autocrop` master.

**Steps:**
1. Open the reference stack and two or three registered frames with visible trails.
2. Run **Script › BlackRig › SatelliteTrailRemover**.
3. Choose the reference stack and select the frames.
4. Open *Diagnostic Outputs* and tick **Removed component**.
5. Click Execute.
6. Check the result:
   - The *Removed component* image should show the trail and nothing else: no stars, no nebula.
   - The cleaned frames should show no trail.
   - Ctrl+Z undoes the change on a frame.
7. Adjust if needed. The main setting is **Line threshold (z)** (default 15):
   - lower it if a faint trail is missed;
   - raise it if frames without a visible trail get modified.
8. Close the dialog with **OK** or **Cancel**. Both save your parameters, and the WBPP step will use them.

The test frames you opened were modified in memory only. Close them without saving.

## 3. Add the step to WBPP

1. Open WBPP **in the same PixInsight instance** where you saved the parameters. Each PixInsight instance keeps its
   own settings.
2. Open the **Pipeline** tab. Under **Pipeline builder**, enable it and select `SatelliteTrailRemover_WBPP.js`.
3. Check the pipeline panel: each light group now shows a **Satellite trail removal** step after *Registration*.
4. Run WBPP as usual.

**What the step does:**
- **Builds a reference per group.** It integrates its own reference stack from the group's registered frames, with
  strong rejection, independent of your WBPP integration settings.
- **Cleans only frames with a trail.** For each frame with a trail, it writes a cleaned copy to
  `<output>/detrailed/<group>/`.
- **Hands the copies to WBPP.** Local normalization, weighting and integration then use the cleaned copies instead
  of the trailed frames.
- **Leaves frames without a trail alone.** They are used as registered.
- **Never modifies your registered frames.** To compare, open the same file name in `registered/<group>/` and
  `detrailed/<group>/`. To go back, disable the pipeline builder.

**After the run, check:**
- the console, one block per group:
  - `Reference rejection: ...`
  - `Cleaning N frames, T at a time`
  - one line per frame (trail found or not);
- `detrailed/<group>/SatelliteTrailRemover_report.csv`: one row per frame, with lines found, detection score and
  pixels modified;
- a few cleaned frames next to their registered version.

Because the trails are removed before integration, you can integrate with gentle pixel rejection (for example sigma
high 3 to 5) and keep more faint signal.

## 4. Options in the WBPP script

Edit these lines at the top of `SatelliteTrailRemover_WBPP.js` with any text editor. WBPP reads the file at each run;
no reinstallation is needed.

| Line | Default | Meaning |
|---|---|---|
| `STRW_REF_SIGMA_HIGH` | `2.5` | Sigma high of the reference stack. Lower (e.g. 2.0) removes faint trails from the reference more completely. |
| `STRW_REF_SIGMA_LOW` | `4.0` | Sigma low of the reference stack. |
| `STRW_REF_REJECTION` | `"winsorized"` | `"sigma"` for plain sigma clipping, or `"wbpp"` to use WBPP's rejection settings for lights. |
| `STRW_THREADS` | `0` | Frames cleaned at the same time. `0` = automatic (up to 8). `1` = one at a time. |

**Speed and memory:**
- **Automatic limits:** the number of frames cleaned at once is always limited by the processors PixInsight may use
  (Edit › Global Preferences) and by the available memory.
- **Memory per frame:** about 32 bytes per pixel and colour channel, about 3 GB for a 100-megapixel monochrome frame.
- **Console:** shows the memory found and the number of frames used.

## 5. Reruns

WBPP's cache keeps the step's results, so a rerun skips what is already done.

| You change | What happens |
|---|---|
| Nothing | Nothing is cleaned again. |
| WBPP's integration settings (rejection, weights, …) | Only WBPP integrates again; the cleaning is reused. |
| Parameters in the standalone script | All frames are cleaned again. |
| `STRW_REF_*` lines | The reference and all frames are redone. |
| New or re-registered frames | Only those frames, plus the group's reference. |

**Purge cache** in WBPP clears everything.

## 6. Limitations

- **Drizzle:** drizzle integration reads the calibrated frames, which are not cleaned.
  - With drizzle on, frames with a cleaned trail are left out of the drizzle master. They are still in the normal
    master, and WBPP lists them as *excluded (drizzle data not updated)*.
  - WBPP's Pipeline builder panel shows a warning about this.
- **Frames per group:** a group needs at least 3 frames, and many more for a good reference.
- **Fast integration groups** are not processed.
- **Older WBPP output folders:** don't use the standalone script's *WBPP mode* (cleaning `registered/` in place, with
  `.sat` originals) on a folder you process with the WBPP step. Run its **Restore originals** first.
- **Very faint or very short trails** can stay below the detection threshold.

Tested with PixInsight 1.9.6 and WBPP 3.2.0 on Windows. Details: `README_WBPP.md` (WBPP step), `README_standalone.md` (standalone script) and
`SatelliteTrailRemover_how_it_works.docx` (method).
