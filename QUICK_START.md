# Desat: quick start

Removes satellite trails from your light frames, either on frames you open yourself or as a step inside
WeightedBatchPreprocessing (WBPP). Author: Erellaz · License: MIT.

The package contains the trail removal script and its WBPP step, the banding removal script and two WBPP steps that
use it, and a checking tool:

| File | What it is |
|---|---|
| `Desat.js` (3.0) | The standalone script. You use it to test on a few frames and to set the parameters. |
| `Desat_WBPP.js` (1.4) | The WBPP step. It cleans every registered light frame during a WBPP run, with the parameters saved by the standalone script. |
| `Deband.js` (2.1) | The banding removal script (Script › BlackRig › Deband). You use it to test on a few frames and to set the parameters of the deband step (section 6). |
| `DebandDesat_WBPP.js` (1.0) | Alternative WBPP step: removes CMOS banding before registration, then the same trail removal after it (section 6). |
| `Deband_WBPP.js` (1.0) | Alternative WBPP step: removes CMOS banding before registration, without trail removal (section 6). |
| `TrailBlink.js` (1.2) | Optional checking tool (Script › BlackRig › TrailBlink): shows each frame before and after cleaning or debanding and records your verdicts. |

Use the versions together, as shipped.

## 1. Install the standalone script

1. Copy the `.js` files, with the `.xsgn` signature files next to them, into a folder of your own.
2. In PixInsight: **Script › Feature Scripts…**, click **Add**, select that folder, then **Done**.
3. The script appears as **Script › BlackRig › Desat**.

The WBPP files (`Desat_WBPP.js`, `DebandDesat_WBPP.js`, `Deband_WBPP.js`) do not appear in the Script menu. That is expected:
WBPP loads them directly (sections 3 and 6).

## 2. Test on a few frames

Start with a handful of frames that show trails, to see what the script does and to adjust it to your data.

**What you need:**
- Some **registered** light frames, for example from WBPP's `registered/<group>` folder.
- A **reference stack** of the same frames: a full-size integration with strong pixel rejection, so that it has no
  trails. For example, use Winsorized sigma clipping with sigma high 2.5. Don't use WBPP's cropped `_autocrop` master.

**Steps:**
1. Open the reference stack and two or three registered frames with visible trails.
2. Run **Script › BlackRig › Desat**.
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

   **Follow faint trail wings** (default on) widens each trail's corridor until its faint glow drops to the noise, up
   to **Max wing width** (default 120 px). Leave it on; turn it off only to compare with version 2.9.
8. Close the dialog with **OK** or **Cancel**. Both save your parameters, and the WBPP step will use them.

The test frames you opened were modified in memory only. Close them without saving.

## 3. Add the step to WBPP

1. Open WBPP **in the same PixInsight instance** where you saved the parameters. Each PixInsight instance keeps its
   own settings.
2. Open the **Pipeline** tab. Under **Pipeline builder**, enable it and select `Desat_WBPP.js`.
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
- `detrailed/<group>/Desat_report.csv`: one row per frame, with lines found, detection score and
  pixels modified;
- a few cleaned frames next to their registered version.

Because the trails are removed before integration, you can integrate with gentle pixel rejection (for example sigma
high 3 to 5) and keep more faint signal.

## 4. Options in the WBPP script

Edit these lines at the top of `Desat_WBPP.js` with any text editor. WBPP reads the file at each run;
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
| A new version of the scripts | All frames are cleaned again (the results change). |

**Purge cache** in WBPP clears everything.

## 6. Remove banding: DebandDesat_WBPP or Deband_WBPP

CMOS sensors can add faint horizontal and vertical bands to every frame. They show most in short or under-exposed
frames, and the part that repeats from frame to frame does not average out in the stack. `DebandDesat_WBPP.js` replaces
`Desat_WBPP.js` as WBPP's pipeline builder: it adds a **Deband** step before registration, with the
Deband method, and keeps the same **Satellite trail removal** step after registration. `Deband_WBPP.js` adds the
same **Deband** step without trail removal, for banding only.

> **Not yet run inside PixInsight.** DebandDesat_WBPP 1.0 and Deband_WBPP 1.0 were tested outside PixInsight, against WBPP's own pipeline code
> with simulated PixInsight objects. Check the first run carefully (see below).

**Set it up:**
1. **Deband** is part of this package and is installed with the other scripts in section 1 (`Deband.js` and
   `Deband.xsgn`). It appears as **Script › BlackRig › Deband**.
2. Open a calibrated light frame (debayered, for a colour camera) and run Deband on it. Adjust the parameters
   if needed, then close the dialog with **OK** or **Cancel**: both save the parameters, and both builders use them.
   Without saved parameters, they use Deband's defaults.
3. Open WBPP in the same PixInsight instance. In the **Pipeline** tab, under **Pipeline builder**, select
   `DebandDesat_WBPP.js` (banding and trails) or `Deband_WBPP.js` (banding only) instead of `Desat_WBPP.js`
   (WBPP takes one builder).
4. For a colour camera, set WBPP's debayer output to **Combined RGB**. With separate RGB channels the frames are not
   debanded; the Pipeline builder panel and the console say so.
5. Check the pipeline panel: each light group shows a **Deband** step after calibration and before *Registration*
   and, with DebandDesat_WBPP, the **Satellite trail removal** step after *Registration*. Run WBPP as usual.

**What the deband step does:**
- **Works along the sensor's rows and columns.** It runs on every light frame after calibration, cosmetic correction
  and debayering, before registration rotates and shifts the frames.
- **Writes a debanded copy** of each frame to `<output>/debanded/<group>/`. The rest of WBPP (measurement,
  registration, local normalization, integration, drizzle) uses it. The calibrated frames are never modified.
- **Keeps large structures.** Patterns longer than 128 px (Deband's *Keep structures larger than*) and the
  background gradient are left alone.
- **Disk and time.** One more copy of every light frame (about 400 MB per 100-megapixel monochrome frame). Measured
  outside PixInsight, a 100-megapixel frame took about 40 s on one core and up to 3.4 GB of memory; frames are
  debanded in parallel as far as memory allows.

**After the run, check:**
- `debanded/<group>/Deband_report.csv`: per frame, the RMS removed and its ratio to the group's median. The
  console warns about frames above 2× the median.
- a few frames in **TrailBlink** (**Script › BlackRig › TrailBlink**, mode **Deband QC**): each frame before
  deband and debanded, side by side. Its *Detail* view (key 2) makes bands stand out.

**Options and reruns:** lines at the top of `DebandDesat_WBPP.js`: `DD_DEBAND` and `DD_DETRAIL` (default `true`) turn each
step on or off; `FDW_THREADS` (default `0`, automatic; also in `Deband_WBPP.js`) sets the number of frames debanded at the same
time; the other lines are those of section 4. For banding only, select `Deband_WBPP.js` rather than set `DD_DETRAIL`
to `false`: an update would replace the edited file. Changing a Deband parameter debands all frames again. Details:
`README_DebandDesat_WBPP.md`.

## 7. Limitations

- **Drizzle:** drizzle integration reads the calibrated frames, which are not cleaned.
  - With drizzle on, frames with a cleaned trail are left out of the drizzle master. They are still in the normal
    master, and WBPP lists them as *excluded (drizzle data not updated)*.
  - WBPP's Pipeline builder panel shows a warning about this.
- **Frames per group:** a group needs at least 3 frames, and many more for a good reference.
- **Fast integration groups** are not processed.
- **Older WBPP output folders:** don't use the standalone script's *WBPP mode* (cleaning `registered/` in place, with
  `.sat` originals) on a folder you process with the WBPP step. Run its **Restore originals** first.
- **Very faint or very short trails** can stay below the detection threshold (on a test set: full-length trails
  below about 0.1σ per pixel, or shorter than about 2000 px). Such faint trails mostly average out in the stack.

Tested with PixInsight 1.9.6 and WBPP 3.2.0 on Windows (DebandDesat_WBPP and Deband_WBPP: not yet, see section 6). Details: `README_Desat_WBPP.md`
(WBPP step), `README_Desat.md` (standalone script), `README_DebandDesat_WBPP.md` (DebandDesat_WBPP and Deband_WBPP), `README_TrailBlink.md`
(TrailBlink) and `Desat_how_it_works.docx` (method).
