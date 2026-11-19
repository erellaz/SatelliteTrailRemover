# SatelliteTrailRemover for WBPP

Satellite trail removal inside PixInsight's WeightedBatchPreprocessing (WBPP), as a WBPP **pipeline builder**.
WBPP runs its standard light pipeline with one extra step per light group, after registration and before
local normalization and integration. That step removes satellite trails from the registered frames, so local
normalization and the master light are computed from cleaned frames.

Version 1.4 · core: SatelliteTrailRemover 3.0 · Author: Erellaz · License: MIT

Run inside PixInsight 1.9.6 with WBPP 3.2.0 (its source files are labelled 3.1.2): version 1.2 in WBPP's automation
mode on 12 real 100-Mpx frames and from the WBPP dialog on 213 frames in four filters, and version 1.3 from the WBPP
dialog on the same 213 frames (see [Verified in PixInsight](#verified-in-pixinsight)). Also tested end to end in
Node.js with mocks.

Version 1.4 carries the SatelliteTrailRemover 3.0 core (wide trails). It passes the Node.js tests below, and its core
was run on 212 real frames in a Node.js harness (see `README_standalone.md`), but 1.4 has not yet run inside PixInsight.

## What the step does

For each registered light group:

1. **Reference.** The group's registered frames are integrated with ImageIntegration, with the step's own pixel
   rejection (see [Reference rejection](#reference-rejection)), equal weights, no local normalization and no drizzle
   data. Pixel rejection removes the trails, so this stack is trail-free. It is
   saved as `<output>/detrailed/<group>/STR_reference.xisf`.
2. **Detection and removal.** Each registered frame is matched to the reference and searched for trails. This is the
   method of SatelliteTrailRemover 3.0, unchanged:
   - adaptive match of the reference to the frame;
   - line and elongated-blob detection;
   - along-track removal, including double or parallel trails;
   - wide trails: each line widened until its faint wings drop to the noise (option *Follow faint trail wings* of
     the standalone script, on by default).
3. **Hand-over to WBPP.** A frame with a trail gets a cleaned copy with the same file name in
   `<output>/detrailed/<group>/`, and WBPP continues with that copy. A frame without a trail is not written, and WBPP keeps
   using its registered file.

The registered frames are never modified. WBPP's registration cache stays valid, and there is nothing to restore: disable the
builder and WBPP uses the registered frames again.

Each group folder also gets `SatelliteTrailRemover_report.csv`, with one row per frame: trail, lines, blobs, max z, modified pixels,
action and line details. Cleaned frames carry `HISTORY`, `STRTRAIL`, `STRNLINE` and `STRZMAX` keywords. Their other
keywords (e.g. `WBPPWGHT`) and image properties are kept.

## Speed

The step cleans several frames at the same time, one frame per thread (PixInsight's `Thread` object, PJSR 1.9.6).
The main thread reads each frame, shares its pixels and the reference's with a thread without copying them, and
writes the result when the thread has finished. The cleaning code inside each thread is the same core, so the
result does not depend on the number of threads.

`STRW_THREADS`, at the top of the file, sets how many frames are cleaned at once:

- `0` (default): automatic, 8 frames.
- `1`: one frame at a time, as in version 1.0.
- Any other number: that many frames.

The step always lowers that number to fit the computer:

- **Processors:** at most the number of processors PixInsight may use (Edit › Global Preferences › Parallel
  processing).
- **Memory:** each frame in progress needs about 32 bytes per pixel and channel, about 3 GB for a 100-Mpx monochrome
  frame. The step uses at most 80 % of the physical memory available when it starts cleaning a group, as PixInsight
  reports it. If not even two frames fit, it cleans one frame at a time.

The console shows what it found, for example:

```
Threads: memory: 22.4 GB available, about 3.0 GB per frame, limited by memory
Cleaning 37 frames, 5 at a time (one thread per frame; a frame's log appears when it is finished)
```

The memory figure was measured in Node.js on the 2.9 core, and the 3.0 core needs the same peak (measured on a frame
with two trails: 29.2 instead of 29.0 bytes per pixel on top of the frame and the reference). Inside PixInsight it has
not been measured separately.

Frame-parallel scaling of the 2.9 core was measured in Node.js (same V8 engine) on an i9-13900KS with 128 GB,
on a real 11664×8750 frame. Every run gave the same modified pixels as the serial run.

| Frames at once | Time per frame | Speed-up |
|---|---|---|
| 1 | 33.4 s | 1.0× |
| 4 | 8.7 s | 3.8× |
| 8 | 5.1 s | 6.6× |
| 12 | 4.3 s | 7.8× |
| 16 | 4.0 s | 8.3× |

Beyond about 8 frames, memory bandwidth limits the gain. With the 3.0 core and wide trails on, a frame with a trail
takes about 50 % longer than with 2.9 (the match is fitted a second time without the trails); frames without a trail
take the same time. Inside PixInsight, reading and writing the frames stays on the
main thread and adds to these times. Measured inside WBPP on 12 frames: 29.1 s per frame one at a time, 6.3 s per
frame with 8 threads (4.7×), with identical results (see [Verified in PixInsight](#verified-in-pixinsight)).

A frame's log appears in the console when that frame is finished, not while it runs. If a thread fails, the frame is
processed again on the main thread and a warning is shown. If the first two threads fail, all remaining frames are
processed one at a time. Without the `Thread` object (older PixInsight), frames are processed one at a time.

On **Cancel**, no new frame is started; the frames in progress finish, and their results are kept for the next run.

## Installation

1. Copy `SatelliteTrailRemover_WBPP.js` to a folder of your own, for example next to the standalone script.
2. In WBPP, open the **Pipeline** tab. Under **Pipeline builder**, enable it and select `SatelliteTrailRemover_WBPP.js`.
3. Check the **Pipeline** panel: each light group now shows a *Satellite trail removal* step after *Registration*.

The file is not a menu script and has no `#feature-id`. WBPP reads it as text and evaluates it (`File.readTextFile`
and `eval` in `BPP-Pipeline.js`). It must not contain preprocessor (`#`) lines.

**Do not code-sign this file.** PixInsight's code signing takes the script identifier from a `#feature-id` line, so
signing this file fails with *No script identifier has been specified*, and adding such a line would break WBPP. No
signature is needed: WBPP does not check one on the files it evaluates. Only the standalone `SatelliteTrailRemover.js`
is signed.

If the builder cannot run, WBPP builds its standard pipeline and shows the reason in the Pipeline builder panel.
This happens, for example, with a WBPP version that lacks what the step relies on.

## Settings

The parameters come from the standalone script **SatelliteTrailRemover** (Script › BlackRig ›
SatelliteTrailRemover):

1. Open the script and set the parameters.
2. Close it with OK or Cancel. Both save the settings.

The WBPP step reads them each time it runs. Without saved settings it uses the 3.0 defaults. Settings saved by
version 2.9 of the standalone script have no wide-trail entries, so the step uses the 3.0 default for those (*Follow
faint trail wings* on, 120 px). The console logs which settings were used.

Two options are always on in WBPP: trail detection, and *modify only detected trails*. Only frames with a
detected trail are rewritten.

## Reference rejection

The reference stack is built by the step itself, before any frame is cleaned. Its pixel rejection is set at the top of
the file and is independent of WBPP's settings for the master light:

```js
var STRW_REF_REJECTION  = "winsorized";   // "winsorized", "sigma" (plain sigma clipping), or "wbpp"
var STRW_REF_SIGMA_LOW  = 4.0;
var STRW_REF_SIGMA_HIGH = 2.5;
```

The reference should reject strongly, so that the trails are absent from it. The master light can use whatever
rejection you choose in WBPP. Changing WBPP's rejection settings therefore never redoes the trail removal.

- A lower `STRW_REF_SIGMA_HIGH` (for example 2.0) rejects faint trails more completely.
- `"wbpp"` restores the behaviour of version 1.2: the reference follows WBPP's rejection settings for lights.
  `STRW_REF_SIGMA_HIGH` then replaces only sigma high (`0` keeps WBPP's value). With linear fit it replaces the high
  clipping limit; with an algorithm that has no sigma high (percentile clipping, ESD, RCR), the reference uses
  Winsorized sigma clipping.
- An unknown value or a sigma that is not positive is replaced by the default, and the console says so.

The console shows what the reference used, for example:

```
Reference rejection: Winsorized Sigma Clipping, sigma low 4, sigma high 2.5 (STRW_REF_*, independent of WBPP's settings)
```

Changing these settings integrates the reference again and processes all frames again.

## Reruns and the cache

Results are kept in WBPP's execution cache, so **Purge cache** in WBPP clears them. On a rerun:

| Situation | What happens |
|---|---|
| Nothing changed | No frame is read; the cleaned copies are reused. |
| Settings changed in the standalone script | All frames are processed again. The reference is reused. |
| WBPP's integration settings changed (rejection, weights, ...) | Nothing is processed again; only WBPP integrates again. |
| `STRW_REF_REJECTION`, `STRW_REF_SIGMA_LOW` or `STRW_REF_SIGMA_HIGH` changed | The reference is integrated again and all frames are processed again. |
| A frame was registered again, or frames were added | The reference is integrated again. Only the new or changed frames are processed. |

After an update to version 1.4, the first run processes all frames again: the results of the 3.0 core differ from
those of 2.9, so the cache of earlier versions is not reused.

Frames processed in an earlier run are not reprocessed when frames are added to the group. The reference changes
only slightly in that case.

An interrupted run keeps the frames already processed and resumes from there.

## Limitations

- **Drizzle is not cleaned.** Drizzle integration reads the calibrated frames through the `.xdrz` files.
  - A cleaned copy gets a copy of its registered frame's `.xdrz`, because WBPP's integration expects one next to each
    file it integrates. Without it, the integration of the master light fails.
  - After integrating the lights, WBPP checks that each frame's drizzle file was updated, even with drizzle off. With
    drizzle off, the step points WBPP at the copy, which ImageIntegration updates (version 1.2 did not, and WBPP
    reported the cleaned frames as *excluded from the integration (drizzle data not updated)* although they were in
    the master).
  - With drizzle on, WBPP keeps checking the registered frame's `.xdrz`, which ImageIntegration does not update. It
    lists the cleaned frames as *excluded from the integration (drizzle data not updated)*: they are in the master
    light and left out of the drizzle master only, whose pixels would come from the trailed calibrated frames.
  - The Pipeline builder panel shows a warning when drizzle is enabled.
- **Reference differences.** The reference has equal weights and no local normalization, unlike the WBPP master
  that the standalone WBPP mode uses. The step matches gain and offset locally, so it does not depend on either.
- **Small groups.** A group needs at least 3 frames, or no reference can be built. With very few frames, rejection
  in the reference is weak.
- **Skipped groups.** Fast-integration groups and recombined RGB groups have no registration step and are not processed.
- **Folders cleaned in place earlier.** If the output folder was cleaned in place by the standalone script's WBPP mode
  (`.sat` originals), run its **Restore originals** first, so that `registered/` holds WBPP's own files again.
- **Disk use.** One reference per group (one frame's size) plus a copy of each trailed frame and its `.xdrz`.

## Verified in PixInsight

WBPP was run in automation mode in a second PixInsight instance, with the builder, on 12 calibrated Blue frames of
11664×8750 pixels (5 with trails, according to an earlier run of the standalone script). Local normalization, subframe weighting
and plate solving were off.

- The step ran after registration, and WBPP integrated the master light from the 5 cleaned copies and the 7 registered
  frames.
- The step found trails in the same 5 frames as the standalone script, with the same numbers of lines and blobs.
  Modified pixel counts differ, because the standalone run used WBPP's master as reference and other registered
  frames.
- With 8 threads, the step took 75 s for 12 frames (6.3 s per frame). One frame at a time (`STRW_THREADS = 1`), on
  the same registered frames, it took 349 s (29.1 s per frame). The cleaned pixels of both runs are bit-identical.
- The first run, before cleaned copies got their `.xdrz`, stopped at the integration of the master light without a
  master and without the rest of its log.

A third and fourth run checked the separate sigma high of version 1.2: with WBPP set to ESD and sigma high 2 for the
reference, the reference used Winsorized sigma clipping (sigma low 4, sigma high 2) and the master light used ESD. The
same 5 frames were cleaned, with slightly more pixels corrected (for example 244 031 instead of 229 992 on a frame with
two trails).

Version 1.2 was then run from the WBPP dialog on a new dataset: 213 frames of 11664×8750 pixels in four filters
(Lum 104, Red 35 after WBPP rejected 2, Blue 37, Green 36), with local normalization, PSF signal weights and
autocrop on, and WBPP's rejection for lights set to Winsorized 2.83 / 2.5.

- The step cleaned 47 frames (Lum 22, Red 12, Blue 5, Green 8), at 4.7–4.9 s per frame with 8 threads, plus about
  55 s per reference.
- The process container shows the cleaned copies, and not their registered versions, in WBPP's local normalization
  and in all four master integrations, with no frame entered twice.
- The run's summary reported 49 frames excluded: the 2 rejected Red frames and the 47 cleaned ones, although drizzle
  was off. The cleaned frames were in the masters; the report came from WBPP's check of the drizzle files after
  integration, which version 1.3 addresses (see [Limitations](#limitations)).
- The Green master had 198 rows of zeros. None of its 36 input frames, cleaned or registered, nor its local
  normalization reference, has missing data there, and its rejection maps are normal in those rows.

Version 1.3 was run from the WBPP dialog on the same 213 frames, with local normalization off and WBPP's rejection
for lights set to Winsorized 5.35 / 5.42:

- Each group logged its reference rejection (Winsorized 4 / 2.5, independent of WBPP's settings) and the memory check
  (about 102 GB available, 3.0 GB per frame, 8 frames at a time). Cleaning took 4.6–5.0 s per frame.
- The same 47 frames were cleaned as with version 1.2, with the same lines and detection scores.
- The masters were integrated with WBPP's settings from the 47 cleaned copies and the other registered frames.
- The run's summary reported 2 frames excluded (the 2 rejected Red frames), not 49: WBPP found the drizzle file of
  every frame updated.
- The Green master again had a block without data: a contiguous run of 412 721 pixels (row 4892, column 7183, to the
  end of row 4927), at 0 before ImageIntegration rescaled its output to [0, 1]. The 36 inputs have no missing data
  there and the rejection maps are normal, so the integration result itself was not written in that block; the
  trail step does not take part in the integration. The cause, inside ImageIntegration or the memory it was given,
  was not found.

Notes for automation runs: WBPP's automation parameter `rejection_4` takes ImageIntegration's own constant
(for example 8 for ESD, 3 for plain sigma clipping), not the numbering of WBPP's automation help. A new PixInsight instance has its own settings, so it does not see the settings saved by the
standalone script in your usual instance, and uses the defaults of its core. In automation mode WBPP's cache is not kept between runs.

## Testing

Besides the PixInsight runs above, the builder was tested end to end in Node.js with a test script (not part of this
package):

- WBPP 3.1.2's own `OperationQueue`, `ExecutionCache` and `BPPOperationBlock` sources are loaded from the PixInsight
  installation.
- The builder is evaluated the way WBPP does it (strict-mode `eval` inside a class method).
- Images, ImageIntegration (a per-pixel median), the file system and the light pipeline are mocked.
- The synthetic data are two groups (mono and RGB) of 6 frames each, 1280×960, with single and double trails.

It checks:

- step placement and indexing;
- trail removal (90–96 % of the trail flux) and untouched trail-free pixels (< 0.1 % changed by more than 0.5 σ);
- which file integration receives;
- keywords;
- the CSV report;
- that registered frames are never modified;
- cache reuse, a settings change, re-registration of one frame, user abort, and fallback when the WBPP API is missing;
- reference rejection: Winsorized 4 / 2.5 by default; a change of WBPP's rejection for the master reuses everything
  from the cache; a changed sigma redoes the reference and the frames; plain sigma clipping; `"wbpp"` (WBPP's
  rejection, sigma high replacing ESD by Winsorized, linear fit's high limit); invalid values replaced by the defaults;
- the thread count with little memory (`System.physicalMemoryStatus` mocked): fewer frames at once, or one at a
  time, logged, with bit-identical results;
- threads: `Thread` is mocked so that each body runs in an empty JavaScript context with only the source the builder
  sends, its data cloned in and its result cloned out. Shared pixels are writable only inside `beginProcess`. The test
  also checks that the shared data are released;
- the cleaned pixels of the threaded run are bit-identical to those of four other paths: no `Thread` object (the 1.0
  code), row-only access to the shared pixels, a failed thread redone on the main thread, and all threads failing;
- every file given to integration has a `.xdrz` next to it, and a cached result whose `.xdrz` copy was deleted is
  redone;
- WBPP's check of the drizzle files after integration (as in `BPP-processing.js`): with drizzle off, no frame is
  reported as excluded; with drizzle on, the cleaned frames are.

The test does not exercise PixInsight's own ImageIntegration, file I/O, `Thread` or the WBPP GUI. Its threads run one
after another, so it does not measure speed. The PixInsight runs described above cover that side, including runs from
the WBPP dialog (version 1.3; version 1.4 has not yet run inside PixInsight).

## License

MIT, see [LICENSE](LICENSE).
