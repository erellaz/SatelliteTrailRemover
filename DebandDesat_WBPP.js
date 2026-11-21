// ----------------------------------------------------------------------------
// DebandDesat_WBPP.js  -  WBPP pipeline builder for PixInsight
// Banding removal and satellite trail removal inside WeightedBatchPreprocessing
// (WBPP 3.2.0, whose source files are labelled 3.1.2; PixInsight 1.9.6).
//
// WHAT IT DOES
// WBPP runs the standard light pipeline with two extra steps per light group:
//
//   DEBAND (before registration), Deband 2.1
//     Right after calibration, cosmetic correction and debayering, and before
//     measurement and registration, every light frame is debanded: CMOS row and
//     column banding (and, if enabled, periodic pattern noise and the Nyquist
//     checkerboard) is estimated in the Fourier domain with star protection and
//     subtracted.  It must run here, in sensor coordinates: registration rotates
//     and shifts the frames, after which the bands no longer lie along the rows
//     and columns.  The debanded copy is written to
//     <output>/debanded/<group>/ (same file name) and WBPP continues with it:
//     measurement, weights, registration, local normalization, integration and
//     drizzle all see the debanded frame.  Every light frame gets a copy (about
//     the size of the calibrated frames).
//
//   SATELLITE TRAIL REMOVAL (after registration), Desat 3.0
//     Right after registration and before local normalization and integration:
//     a trail-free reference stack is integrated from the registered frames,
//     every frame is matched to it and searched for trails, and frames with a
//     trail get a cleaned copy in <output>/detrailed/<group>/ (see the trail
//     section below).
//
// Either step can be switched off below (DD_DEBAND, DD_DETRAIL).  The input
// files of each step are never modified, so WBPP's caches stay valid: disable
// the builder and WBPP uses the calibrated and registered frames again.
//
// SETTINGS
// Each step reads the parameters saved by its standalone script: run the script
// once (Script > BlackRig > Deband, Script > BlackRig >
// Desat), set the parameters, close it with OK or Cancel (both
// save).  Missing settings fall back to the defaults of Deband 2.1 and
// Desat 3.0.  Read when each step runs.  The standalone
// Deband's diagnostic outputs (spectrum, mask, removed noise, gain maps)
// and its file options are not used here.
//
// DEBAND REPORT
// <output>/debanded/<group>/Deband_report.csv lists, per frame, the input
// file, the RMS of what was removed (64 px or more from the frame edges, whose
// first and last rows are often off and flattened too) and its ratio to the
// group's median.  A ratio above 2 (also shown as a warning in the console)
// marks a frame with unusually strong pattern noise.  The same RMS is written
// to the debanded frame as the FITS keyword FDRMS.  TrailBlink's "Deband QC"
// mode shows the frames before and after, side by side, with the removed
// pattern.
//
// COLOUR (CFA) FRAMES
// Banding is removed from the debayered RGB frames (never from the raw mosaic,
// whose Bayer pattern would be taken for a periodic pattern).  This needs
// WBPP's debayer output "Combined RGB"; with separated channels the deband step
// skips the group and says so.
//
// CACHE
// Results are stored in WBPP's execution cache: a rerun skips frames whose
// input file and parameters are unchanged.  "Purge cache" in WBPP clears it.
//
// SPEED AND MEMORY
// Several frames are processed at the same time, each in its own thread
// (PixInsight's Thread object).  FDW_THREADS and STRW_THREADS below set how
// many: 0 means automatic (8), 1 means one frame at a time.  The number is
// always lowered to the processors PixInsight may use (Edit > Global
// Preferences) and to what fits in 80 % of the available physical memory.
// Deband needs about 30 bytes per pixel and channel per frame in progress
// (about 3 GB for a 100-Mpx monochrome frame), trail removal about 32.  The
// console shows the memory available and the number used.  The results do not
// depend on the number of threads.
//
// TRAIL REMOVAL DETAILS
//   1. Reference: the registered frames of the group are integrated with
//      ImageIntegration (equal weights, no LN).  Pixel rejection removes the
//      trails, so this stack is trail-free.  Saved as
//      <output>/detrailed/<group>/STR_reference.xisf.
//   2. Every registered frame is matched to the reference and searched for
//      trails with the Desat 3.0 method (adaptive match, line
//      and blob detection, along-track removal, double trails, wide trails).
//   3. A frame with a trail gets a cleaned copy in <output>/detrailed/<group>/
//      (same file name) and WBPP continues with that copy: local normalization
//      and integration see the cleaned frame.  Frames without trail are not
//      written; WBPP keeps using the registered file.
//   The reference stack has its own pixel rejection, set below and independent
//   of WBPP's settings for the master light: by default Winsorized sigma
//   clipping, sigma low 4, sigma high 2.5.  STRW_REF_REJECTION = "wbpp" makes
//   it follow WBPP's settings for lights, with STRW_REF_SIGMA_HIGH (> 0)
//   replacing only its sigma high.
//
// NOT CLEANED OF TRAILS: drizzle.  Drizzle integration reads the debanded
// (pre-registration) frames through the .xdrz files, so drizzle gets the
// banding removal but not the trail removal.  A cleaned copy gets a copy of its
// frame's .xdrz (WBPP's integration needs one next to each file).  With drizzle
// off, the trail step points WBPP at the copy, which ImageIntegration updates.
// With drizzle on, WBPP reports the trail-cleaned frames as "excluded (drizzle
// data not updated)" and leaves them out of the drizzle master; they are in the
// master light.
//
// INSTALL
// WBPP > Pipeline tab > Pipeline builder: enable it and select this file.
// This file is evaluated by WBPP, not run from the Script menu: it has no
// #feature-id and must never contain preprocessor lines.
//
// DO NOT CODE-SIGN THIS FILE.  PixInsight's code signing takes the script
// identifier from a #feature-id line, so it fails here with "No script
// identifier has been specified", and adding that line would break WBPP,
// which reads this file as text and evaluates it.  No signature is needed:
// WBPP does not check one on the files it evaluates.
//
// Version 1.0
//   Renamed DebandDesat_WBPP.js (was DebandDesat.js); processing and cache unchanged.
//   1.0  first version: Deband 2.1 before registration, and the
//        Desat WBPP builder 1.4 after it (Desat
//        3.0 core and cache keys unchanged: with deband off, its cached
//        results are reused)
// Author: Erellaz
// License: MIT (see the LICENSE file next to this script)
// ----------------------------------------------------------------------------

var DD_VERSION = "1.0";      // this WBPP builder
var DD_DEBAND  = true;       // remove banding before registration (Deband)
var DD_DETRAIL = true;       // remove satellite trails after registration (Desat)

var FDW_THREADS = 0;        // frames debanded at the same time: 0 = automatic (8), 1 = one at a time; always limited by processors and memory
var STRW_THREADS = 0;       // frames cleaned of trails at the same time: same rules
// Pixel rejection of the trail step's REFERENCE stack only.  Independent of WBPP's settings for the master light.
var STRW_REF_REJECTION  = "winsorized";   // "winsorized", "sigma" (plain sigma clipping), or "wbpp" (follow WBPP's settings for lights)
var STRW_REF_SIGMA_LOW  = 4.0;
var STRW_REF_SIGMA_HIGH = 2.5;            // lower = trails rejected more completely; with "wbpp": 0 keeps WBPP's value

var FD_VERSION   = "2.1";   // Deband core below (verbatim copy of 2.1)
var FDW_CACHE_VERSION = "1.0";    // version of the deband results, part of the cache keys: bump when they change
var STR_VERSION  = "3.0";   // Desat core below (verbatim copy of 3.0)
var STRW_VERSION = "DebandDesat_WBPP " + DD_VERSION;   // shown in the trail step's console output and HISTORY
var STRW_CACHE_VERSION = "1.1";   // version of the trail results, part of the cache keys: bump when they change

// The core is wrapped in a function so that its source text can be sent to the
// threads (STRW_threadSource).  The code between the markers is unchanged.
function STRW_core() {
// ==== CORE BEGIN
// Pure ES5, no PJSR objects.  Testable in Node.
// ============================================================================

var STR_MIN_PIX = 1e-6;   // below this a pixel is treated as registration border

// Numeric parameter with default (unlike `v || d`, keeps legitimate zeros)
function STR_num(v, d) {
   return (typeof v === "number" && v === v) ? v : d;
}

// ---------------------------------------------------------------------------
// Validity mask: a pixel is usable only if BOTH sub and stack are non-black.
// (Registration borders of sub and stack generally differ.)
// ---------------------------------------------------------------------------
function STR_validMask(sub, stack, N) {
   var valid = new Uint8Array(N);
   var i, n = 0;
   for (i = 0; i < N; i++) {
      if (sub[i] > STR_MIN_PIX && stack[i] > STR_MIN_PIX) { valid[i] = 1; n++; }
   }
   return { mask: valid, count: n };
}

// ---------------------------------------------------------------------------
// Iterative 3-sigma-clipped mean / sigma.  No sorting: O(n) per iteration,
// no extra memory.  `valid` (optional Uint8Array) restricts the pixels used.
// Returns {mean, sigma, count}.
// ---------------------------------------------------------------------------
function STR_robustSigma(data, n, valid) {
   var i, v, sum = 0, sum2 = 0, cnt = 0;
   for (i = 0; i < n; i++) {
      if (valid && !valid[i]) continue;
      v = data[i];
      sum += v; sum2 += v * v; cnt++;
   }
   if (cnt < 3) return { mean: 0, sigma: 1e-20, count: cnt };
   var mu = sum / cnt;
   var sig = Math.sqrt(Math.max(sum2 / cnt - mu * mu, 0));
   if (!(sig > 0)) return { mean: mu, sigma: 1e-20, count: cnt };

   var iter, lo, hi, prevSig, clip = 3.0;
   for (iter = 0; iter < 10; iter++) {
      lo = mu - clip * sig;
      hi = mu + clip * sig;
      sum = 0; sum2 = 0; cnt = 0;
      for (i = 0; i < n; i++) {
         if (valid && !valid[i]) continue;
         v = data[i];
         if (v < lo || v > hi) continue;
         sum += v; sum2 += v * v; cnt++;
      }
      if (cnt < 3) break;
      prevSig = sig;
      mu = sum / cnt;
      sig = Math.sqrt(Math.max(sum2 / cnt - mu * mu, 0));
      if (!(sig > 0)) { sig = 1e-20; break; }
      if (Math.abs(sig - prevSig) < 1e-4 * prevSig) break;
   }
   // A 3-sigma clip of a Gaussian underestimates sigma by ~1.3 %
   return { mean: mu, sigma: sig * 1.0135, count: cnt };
}

// ---------------------------------------------------------------------------
// Bilinear interpolator from a block grid (block centres) to pixel rows.
// Returns function(grid, py, outRow) filling outRow[0..W-1].
// ---------------------------------------------------------------------------
function STR_makeInterp(BW, BH, bs, W) {
   var ix0 = new Int32Array(W), ix1 = new Int32Array(W), fxA = new Float64Array(W);
   var px, f, i0;
   for (px = 0; px < W; px++) {
      f = (px + 0.5) / bs - 0.5;
      i0 = Math.floor(f);
      f -= i0;
      if (i0 < 0) { i0 = 0; f = 0; }
      if (i0 > BW - 1) { i0 = BW - 1; f = 0; }
      ix0[px] = i0;
      ix1[px] = (i0 + 1 < BW) ? i0 + 1 : BW - 1;
      fxA[px] = f;
   }
   return function(grid, py, outRow) {
      var fy = (py + 0.5) / bs - 0.5;
      var iy0 = Math.floor(fy);
      fy -= iy0;
      if (iy0 < 0) { iy0 = 0; fy = 0; }
      if (iy0 > BH - 1) { iy0 = BH - 1; fy = 0; }
      var iy1 = (iy0 + 1 < BH) ? iy0 + 1 : BH - 1;
      var r0 = iy0 * BW, r1 = iy1 * BW, x, fx, a, b;
      for (x = 0; x < W; x++) {
         fx = fxA[x];
         a = grid[r0 + ix0[x]] + fx * (grid[r0 + ix1[x]] - grid[r0 + ix0[x]]);
         b = grid[r1 + ix0[x]] + fx * (grid[r1 + ix1[x]] - grid[r1 + ix0[x]]);
         outRow[x] = a + fy * (b - a);
      }
   };
}

// Expand a block grid to a full-resolution Float32Array
function STR_expandGrid(grid, BW, BH, bs, W, H) {
   var out = new Float32Array(W * H);
   var row = new Float64Array(W);
   var interp = STR_makeInterp(BW, BH, bs, W);
   var py, px, o;
   for (py = 0; py < H; py++) {
      interp(grid, py, row);
      o = py * W;
      for (px = 0; px < W; px++) out[o + px] = row[px];
   }
   return out;
}

// ---------------------------------------------------------------------------
// Separable box blur (running sums, O(N) for any radius), edge-normalised.
// Returns a new Float32Array.
// ---------------------------------------------------------------------------
function STR_boxBlur(src, W, H, r) {
   var N = W * H;
   var out = new Float32Array(N);
   var i;
   if (r <= 0) { for (i = 0; i < N; i++) out[i] = src[i]; return out; }
   var tmp = new Float32Array(N);
   var x, y, o, sum, cnt, add, rem;
   // Horizontal
   for (y = 0; y < H; y++) {
      o = y * W; sum = 0; cnt = 0;
      for (x = 0; x <= r && x < W; x++) { sum += src[o + x]; cnt++; }
      for (x = 0; x < W; x++) {
         tmp[o + x] = sum / cnt;
         add = x + r + 1; rem = x - r;
         if (add < W) { sum += src[o + add]; cnt++; }
         if (rem >= 0) { sum -= src[o + rem]; cnt--; }
      }
   }
   // Vertical
   for (x = 0; x < W; x++) {
      sum = 0; cnt = 0;
      for (y = 0; y <= r && y < H; y++) { sum += tmp[y * W + x]; cnt++; }
      for (y = 0; y < H; y++) {
         out[y * W + x] = sum / cnt;
         add = y + r + 1; rem = y - r;
         if (add < H) { sum += tmp[add * W + x]; cnt++; }
         if (rem >= 0) { sum -= tmp[rem * W + x]; cnt--; }
      }
   }
   return out;
}

// ---------------------------------------------------------------------------
// Separable max filter (grey-level dilation, square structuring element).
// Mostly-zero input: zero runs are skipped cheaply.  Returns new Float32Array.
// ---------------------------------------------------------------------------
function STR_maxFilter(src, W, H, r) {
   var N = W * H;
   var out = new Float32Array(N);
   var i;
   if (r <= 0) { for (i = 0; i < N; i++) out[i] = src[i]; return out; }
   var tmp = new Float32Array(N);
   var x, y, o, v, k, k0, k1, idx;
   // Horizontal: scatter each non-zero sample to its neighbourhood
   for (y = 0; y < H; y++) {
      o = y * W;
      for (x = 0; x < W; x++) {
         v = src[o + x];
         if (v <= 0) continue;
         k0 = x - r; if (k0 < 0) k0 = 0;
         k1 = x + r; if (k1 > W - 1) k1 = W - 1;
         for (k = k0; k <= k1; k++) if (tmp[o + k] < v) tmp[o + k] = v;
      }
   }
   // Vertical
   for (y = 0; y < H; y++) {
      o = y * W;
      for (x = 0; x < W; x++) {
         v = tmp[o + x];
         if (v <= 0) continue;
         k0 = y - r; if (k0 < 0) k0 = 0;
         k1 = y + r; if (k1 > H - 1) k1 = H - 1;
         for (k = k0; k <= k1; k++) {
            idx = k * W + x;
            if (out[idx] < v) out[idx] = v;
         }
      }
   }
   return out;
}

// ---------------------------------------------------------------------------
// Adaptive subtraction: windowed robust least-squares with Bayesian shrinkage
//    sub ≈ gain(x,y) * stack + offset(x,y)
// Returns {diff (Float32Array, 0 on invalid pixels), gainGrid, offsetGrid,
//          BW, BH, blockSize, sigma}
// ---------------------------------------------------------------------------
function STR_adaptiveSubtract(sub, stack, valid, W, H, P, log, excl0) {
   var blockSize = Math.round(STR_num(P.blockSize, 64));
   var halfWin   = Math.round(STR_num(P.halfWin, 4));      // in blocks
   var clipSigma = STR_num(P.clipSigma, 3.0);
   var tau       = STR_num(P.tau, 0.1);                    // prior width on gain
   var clipIter  = Math.round(STR_num(P.clipIter, 3));
   // Scale-aware gain prior (v2.3): the prior (g-1)^2/tau^2 is weighed against
   // sum(residual^2)/sigma^2, so its weight in the normal equations is
   // sigma^2/tau^2.  v2.0-2.2 used 1/tau^2, which on real data (sigma ~ 1e-4)
   // is ~1e8 times too strong and pinned the gain at exactly 1.
   var scaled    = P.scaledPrior !== false;
   if (blockSize < 4) blockSize = 4;
   if (halfWin < 0) halfWin = 0;
   if (!(tau > 0)) tau = 1e-3;
   var noise2 = 1.0;   // sigma^2 used by the scaled prior (set below)

   var N = W * H;
   var BW = Math.ceil(W / blockSize);
   var BH = Math.ceil(H / blockSize);
   var nBlocks = BW * BH;

   // -- Per-block sums: S = sub, R = stack (reference) --
   function accumBlocks(excl) {
      var bS = new Float64Array(nBlocks), bR = new Float64Array(nBlocks);
      var bSR = new Float64Array(nBlocks), bRR = new Float64Array(nBlocks);
      var bN = new Float64Array(nBlocks);
      var bx, by, px, py, x0, y0, x1, y1, bi, idx, s, r;
      for (by = 0; by < BH; by++) {
         y0 = by * blockSize; y1 = y0 + blockSize; if (y1 > H) y1 = H;
         for (bx = 0; bx < BW; bx++) {
            x0 = bx * blockSize; x1 = x0 + blockSize; if (x1 > W) x1 = W;
            bi = by * BW + bx;
            for (py = y0; py < y1; py++) {
               idx = py * W + x0;
               for (px = x0; px < x1; px++, idx++) {
                  if (!valid[idx]) continue;
                  if (excl && excl[idx]) continue;
                  if (excl0 && excl0[idx]) continue;   // 3.0: detected trails (re-fit)
                  s = sub[idx]; r = stack[idx];
                  bS[bi] += s; bR[bi] += r; bSR[bi] += s * r; bRR[bi] += r * r; bN[bi] += 1;
               }
            }
         }
      }
      return { sumS: bS, sumR: bR, sumSR: bSR, sumRR: bRR, cnt: bN };
   }

   function prefixSum2D(arr) {
      var ps = new Float64Array(nBlocks), i, r, c;
      for (i = 0; i < nBlocks; i++) ps[i] = arr[i];
      for (r = 0; r < BH; r++) for (c = 1; c < BW; c++) ps[r * BW + c] += ps[r * BW + c - 1];
      for (c = 0; c < BW; c++) for (r = 1; r < BH; r++) ps[r * BW + c] += ps[(r - 1) * BW + c];
      return ps;
   }

   function windowSum(ps, bx, by) {
      var r0 = by - halfWin; if (r0 < 0) r0 = 0;
      var r1 = by + halfWin; if (r1 >= BH) r1 = BH - 1;
      var c0 = bx - halfWin; if (c0 < 0) c0 = 0;
      var c1 = bx + halfWin; if (c1 >= BW) c1 = BW - 1;
      var val = ps[r1 * BW + c1];
      if (r0 > 0) val -= ps[(r0 - 1) * BW + c1];
      if (c0 > 0) val -= ps[r1 * BW + (c0 - 1)];
      if (r0 > 0 && c0 > 0) val += ps[(r0 - 1) * BW + (c0 - 1)];
      return val;
   }

   // Windowed normal equations with N(1, tau^2) prior on the gain:
   //   [ΣRR + λ, ΣR; ΣR, N] [g; o] = [ΣSR + λ; ΣS]
   //   λ = σ²/τ² (scaled prior, default) or 1/τ² (legacy v2.0-2.2)
   function solveGrids(blks) {
      var gGrid = new Float64Array(nBlocks), oGrid = new Float64Array(nBlocks);
      var tauInv2 = scaled ? noise2 / (tau * tau) : 1.0 / (tau * tau);
      var psS = prefixSum2D(blks.sumS), psR = prefixSum2D(blks.sumR);
      var psSR = prefixSum2D(blks.sumSR), psRR = prefixSum2D(blks.sumRR);
      var psC = prefixSum2D(blks.cnt);
      var bx, by, bi, wN, A00, A01, A11, b0, b1, det, g, o;
      for (by = 0; by < BH; by++) {
         for (bx = 0; bx < BW; bx++) {
            bi = by * BW + bx;
            wN = windowSum(psC, bx, by);
            g = 1.0; o = 0.0;
            if (wN >= 64) {
               A00 = windowSum(psRR, bx, by) + tauInv2;
               A01 = windowSum(psR, bx, by);
               A11 = wN;
               b0 = windowSum(psSR, bx, by) + tauInv2;   // prior mean gain = 1
               b1 = windowSum(psS, bx, by);
               det = A00 * A11 - A01 * A01;
               if (det !== 0 && det === det) {
                  g = (A11 * b0 - A01 * b1) / det;
                  if (g < 0.5) g = 0.5;
                  if (g > 2.0) g = 2.0;
                  // Offset re-solved for the clamped gain (exact when unclamped)
                  o = (b1 - A01 * g) / A11;
               }
            }
            gGrid[bi] = g; oGrid[bi] = o;
         }
      }
      return { gain: gGrid, offset: oGrid };
   }

   // Box blur on the block grid (radius 1, 2 passes)
   function boxBlurGrid(grid) {
      var src = grid, dst, pass, bx, by, dx, dy, nx, ny, s, c;
      for (pass = 0; pass < 2; pass++) {
         dst = new Float64Array(nBlocks);
         for (by = 0; by < BH; by++) {
            for (bx = 0; bx < BW; bx++) {
               s = 0; c = 0;
               for (dy = -1; dy <= 1; dy++) {
                  ny = by + dy; if (ny < 0 || ny >= BH) continue;
                  for (dx = -1; dx <= 1; dx++) {
                     nx = bx + dx; if (nx < 0 || nx >= BW) continue;
                     s += src[ny * BW + nx]; c++;
                  }
               }
               dst[by * BW + bx] = s / c;
            }
         }
         src = dst;
      }
      return src;
   }

   var interp = STR_makeInterp(BW, BH, blockSize, W);
   var gRow = new Float64Array(W), oRow = new Float64Array(W);
   function residual(gGrid, oGrid, out) {
      var py, px, idx;
      for (py = 0; py < H; py++) {
         interp(gGrid, py, gRow);
         interp(oGrid, py, oRow);
         idx = py * W;
         for (px = 0; px < W; px++, idx++) {
            out[idx] = valid[idx] ? (sub[idx] - gRow[px] * stack[idx] - oRow[px]) : 0;
         }
      }
   }

   var diff = new Float32Array(N);
   var it, i, rs, lo, hi, nExcl;

   // ---- Initial noise estimate for the scaled prior: robust sigma of sub - stack ----
   if (scaled) {
      for (i = 0; i < N; i++) diff[i] = valid[i] ? sub[i] - stack[i] : 0;
      rs = STR_robustSigma(diff, N, valid);
      noise2 = rs.sigma * rs.sigma;
      if (log) log("  Gain prior: scaled (sigma=" + rs.sigma.toExponential(3)
         + ", tau=" + tau + ")");
   }

   // ---- Initial fit ----
   var sol = solveGrids(accumBlocks(null));
   var gainGrid = sol.gain, offsetGrid = sol.offset;

   // ---- Iterative sigma-clipped refinement (global robust sigma) ----
   var excl = (clipIter > 0) ? new Uint8Array(N) : null;
   for (it = 0; it < clipIter; it++) {
      residual(boxBlurGrid(gainGrid), boxBlurGrid(offsetGrid), diff);
      rs = STR_robustSigma(diff, N, valid);
      if (scaled) noise2 = rs.sigma * rs.sigma;
      lo = rs.mean - clipSigma * rs.sigma;
      hi = rs.mean + clipSigma * rs.sigma;
      nExcl = 0;
      for (i = 0; i < N; i++) {
         if (valid[i] && (diff[i] < lo || diff[i] > hi)) { excl[i] = 1; nExcl++; }
         else excl[i] = 0;
      }
      sol = solveGrids(accumBlocks(excl));
      gainGrid = sol.gain; offsetGrid = sol.offset;
      if (log) log("  Clip iter " + (it + 1) + ": excluded " + nExcl
         + " px, residual sigma=" + rs.sigma.toExponential(3));
   }
   excl = null;

   // ---- Final smoothed grids and residual ----
   gainGrid = boxBlurGrid(gainGrid);
   offsetGrid = boxBlurGrid(offsetGrid);
   residual(gainGrid, offsetGrid, diff);
   rs = STR_robustSigma(diff, N, valid);

   if (log) {
      var gMin = 1e30, gMax = -1e30;
      for (i = 0; i < nBlocks; i++) {
         if (gainGrid[i] < gMin) gMin = gainGrid[i];
         if (gainGrid[i] > gMax) gMax = gainGrid[i];
      }
      log("Adaptive match: " + BW + "x" + BH + " blocks (" + blockSize
         + " px), halfWin=" + halfWin + ", tau=" + tau
         + ", gain range [" + gMin.toFixed(4) + ", " + gMax.toFixed(4) + "]"
         + ", residual sigma=" + rs.sigma.toExponential(3));
   }

   return {
      diff: diff, gainGrid: gainGrid, offsetGrid: offsetGrid,
      BW: BW, BH: BH, blockSize: blockSize, sigma: rs.sigma
   };
}

// ---------------------------------------------------------------------------
// Subtraction weight from the residual.
//  1. smooth the signed residual (box, radius smoothRadius): noise averages
//     down, extended features (trails) keep their amplitude
//  2. z = (smoothed - mean) / sigma_eff, with sigma = robust sigma of the
//     smoothed map itself (accounts for the noise correlation) and
//        sigma_eff^2 = sigma^2 + (structTol * S)^2
//     where S = smoothed |high-pass| of the matched model (gain*stack+offset),
//     minus its sky floor.  Residuals sitting on structure the reference
//     already has (stars: PSF / registration mismatch) need to be larger to
//     count; trails are absent from the reference, so S ~ 0 along them.
//     v2.5 adds a brightness term:  + (brightTol * E)^2, E = smoothed excess of
//     the model over the local sky background (STR_skyBackground).  Smooth
//     bright light already in the reference (halos, spikes and bleed of bright
//     stars, bright nebula/galaxy cores) only counts if the residual exceeds
//     brightTol x that light; on dark sky E ~ 0 and trails are unaffected.
//  3. w0 = linear ramp 0 at sigmaLow -> 1 at sigmaHigh (positive side only)
//  4. grow (max filter, growRadius) to catch the faint trail wings,
//     then feather (box blur, featherRadius) for a seamless blend
// Returns {weight (Float32Array), mean, sigma, nSeed, nAny, nFull}
// ---------------------------------------------------------------------------
var STR_HP_RADIUS = 4;          // box radius of the model high-pass (star scale)

// ---------------------------------------------------------------------------
// Local sky background of `img` (v2.5), robust to stars and their halos:
//  per 64-px block, the minimum of the 8x8-px cell means (valid cells only);
//  then the minimum over 5x5 blocks (excludes halos up to ~150 px); then a
//  2-pass 3x3 box blur of the block grid; bilinear to full resolution.
// Returns Float32Array.
// ---------------------------------------------------------------------------
function STR_skyBackground(img, valid, W, H) {
   var bs = 64, cs = 8, nb = 2, BIG = 1e30;
   var BW = Math.ceil(W / bs), BH = Math.ceil(H / bs), nB = BW * BH;
   var g = new Float64Array(nB);
   var bx, by, cx, cy, x, y, x1, y1, s, n, m, idx, k;
   for (by = 0; by < BH; by++) {
      for (bx = 0; bx < BW; bx++) {
         m = BIG;
         for (cy = by * bs; cy < Math.min(H, (by + 1) * bs); cy += cs) {
            for (cx = bx * bs; cx < Math.min(W, (bx + 1) * bs); cx += cs) {
               y1 = Math.min(H, cy + cs); x1 = Math.min(W, cx + cs);
               s = 0; n = 0;
               for (y = cy; y < y1; y++) {
                  idx = y * W + cx;
                  for (x = cx; x < x1; x++, idx++) if (valid[idx]) { s += img[idx]; n++; }
               }
               if (n >= (cs * cs) / 2 && s / n < m) m = s / n;
            }
         }
         g[by * BW + bx] = m;
      }
   }
   // Minimum over the (2nb+1)^2 neighbourhood
   var g2 = new Float64Array(nB), dx, dy, nx, ny, v;
   for (by = 0; by < BH; by++) {
      for (bx = 0; bx < BW; bx++) {
         m = BIG;
         for (dy = -nb; dy <= nb; dy++) {
            ny = by + dy; if (ny < 0 || ny >= BH) continue;
            for (dx = -nb; dx <= nb; dx++) {
               nx = bx + dx; if (nx < 0 || nx >= BW) continue;
               v = g[ny * BW + nx]; if (v < m) m = v;
            }
         }
         g2[by * BW + bx] = m;
      }
   }
   // Blocks without any valid cell nearby: use the global median-ish (mean of valid blocks)
   s = 0; n = 0;
   for (k = 0; k < nB; k++) if (g2[k] < BIG) { s += g2[k]; n++; }
   for (k = 0; k < nB; k++) if (!(g2[k] < BIG)) g2[k] = n > 0 ? s / n : 0;
   // 2-pass 3x3 box blur
   var src = g2, dst, pass, c;
   for (pass = 0; pass < 2; pass++) {
      dst = new Float64Array(nB);
      for (by = 0; by < BH; by++) {
         for (bx = 0; bx < BW; bx++) {
            s = 0; c = 0;
            for (dy = -1; dy <= 1; dy++) {
               ny = by + dy; if (ny < 0 || ny >= BH) continue;
               for (dx = -1; dx <= 1; dx++) {
                  nx = bx + dx; if (nx < 0 || nx >= BW) continue;
                  s += src[ny * BW + nx]; c++;
               }
            }
            dst[by * BW + bx] = s / c;
         }
      }
      src = dst;
   }
   return STR_expandGrid(src, BW, BH, bs, W, H);
}

function STR_residualWeight(sub, diff, valid, W, H, P, log, dump) {
   var N = W * H;
   var t0 = Date.now();
   var r       = Math.round(STR_num(P.smoothRadius, 2));
   var kLo     = STR_num(P.sigmaLow, 4.0);
   var kHi     = STR_num(P.sigmaHigh, 8.0);
   var grow    = Math.round(STR_num(P.growRadius, 3));
   var feather = Math.round(STR_num(P.featherRadius, 2));
   var beta    = STR_num(P.structTol, 0.5);
   var gamma   = STR_num(P.brightTol, 0.05);
   if (kHi <= kLo) kHi = kLo + 0.1;
   var i, t, nSeed = 0;

   // Matched model (gain*stack + offset = sub - diff)
   var model = null;
   if (beta > 0 || gamma > 0) {
      model = new Float32Array(N);
      for (i = 0; i < N; i++) model[i] = valid[i] ? sub[i] - diff[i] : 0;
      if (dump) dump("model", model);
   }

   // Structure map of the matched model
   var S = null, sFloor = 0;
   if (beta > 0) {
      var hp = STR_boxBlur(model, W, H, STR_HP_RADIUS);
      for (i = 0; i < N; i++) {
         t = model[i] - hp[i];
         hp[i] = valid[i] ? (t < 0 ? -t : t) : 0;
      }
      S = STR_boxBlur(hp, W, H, r);
      hp = null;
      sFloor = STR_robustSigma(S, N, valid).mean;
      if (dump) dump("structure_S", S);
      if (log && dump) log("  structure floor = " + sFloor.toExponential(4));
   }

   // Brightness map: smoothed excess of the model over the local sky (v2.5)
   var E = null;
   if (gamma > 0) {
      var bg = STR_skyBackground(model, valid, W, H);
      for (i = 0; i < N; i++) {
         t = model[i] - bg[i];
         bg[i] = (valid[i] && t > 0) ? t : 0;
      }
      E = STR_boxBlur(bg, W, H, r);
      bg = null;
      if (dump) dump("brightness_E", E);
   }
   model = null;
   var g2b = gamma * gamma, d2, e;

   var w = STR_boxBlur(diff, W, H, r);
   var rs = STR_robustSigma(w, N, valid);
   if (dump) dump("residual_smoothed", w);
   if (log && dump) log("  smoothed residual: mean=" + rs.mean.toExponential(4)
      + " sigma=" + rs.sigma.toExponential(4));
   var zArr = dump ? new Float32Array(N) : null;
   var sig2 = rs.sigma * rs.sigma, b2 = beta * beta;
   var dk = kHi - kLo, s, z;
   for (i = 0; i < N; i++) {
      if (!valid[i]) { w[i] = 0; continue; }
      if (S !== null || E !== null) {
         d2 = sig2;
         if (S !== null) { s = S[i] - sFloor; if (s > 0) d2 = sig2 + b2 * s * s; }
         if (E !== null) { e = E[i]; if (e > 0) d2 += g2b * e * e; }
         z = (w[i] - rs.mean) / Math.sqrt(d2);
      } else {
         z = (w[i] - rs.mean) / rs.sigma;
      }
      if (zArr) zArr[i] = z;
      t = (z - kLo) / dk;
      if (t <= 0) w[i] = 0;
      else { w[i] = (t >= 1) ? 1 : t; nSeed++; }
   }
   S = null; E = null;
   if (dump) { dump("significance_z", zArr); dump("weight_seed", w); }
   zArr = null;
   if (grow > 0) w = STR_maxFilter(w, W, H, grow);
   if (feather > 0) w = STR_boxBlur(w, W, H, feather);

   var nAny = 0, nFull = 0;
   for (i = 0; i < N; i++) {
      if (!valid[i]) { w[i] = 0; continue; }
      if (w[i] > 1e-4) { nAny++; if (w[i] >= 0.999) nFull++; }
      else w[i] = 0;
   }
   if (dump) dump("weight_final", w);
   if (log) log("  time: weight " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
   if (log) log("Residual weight: smooth r=" + r + ", sigma(smoothed)="
      + rs.sigma.toExponential(3) + ", ramp " + kLo + "->" + kHi
      + " sigma, structTol=" + beta + ", brightTol=" + gamma + ", grow=" + grow + ", feather=" + feather
      + "; seeds=" + nSeed + ", w>0: " + nAny
      + " px (" + (100 * nAny / N).toFixed(3) + " %), w=1: " + nFull + " px");
   return { weight: w, mean: rs.mean, sigma: rs.sigma, nSeed: nSeed, nAny: nAny, nFull: nFull };
}

// ---------------------------------------------------------------------------
// Saturation protection map: 1 where sub or stack >= satLevel, dilated by
// satGrow and feathered by featherRadius.  Returns Float32Array, or null if
// no pixel is saturated.
// ---------------------------------------------------------------------------
function STR_saturationProtect(sub, stack, valid, W, H, P, log) {
   var N = W * H;
   var lev  = STR_num(P.satLevel, 0.95);
   var g    = Math.round(STR_num(P.satGrow, 8));
   var f    = Math.round(STR_num(P.featherRadius, 2));
   if (g < 0) g = 0;
   if (f < 0) f = 0;
   var m = new Float32Array(N), i, n = 0;
   for (i = 0; i < N; i++) {
      if (valid[i] && (sub[i] >= lev || stack[i] >= lev)) { m[i] = 1; n++; }
   }
   if (n === 0) { if (log) log("Saturation guard: no pixel >= " + lev); return null; }
   m = STR_maxFilter(m, W, H, g + f);
   if (f > 0) m = STR_boxBlur(m, W, H, f);
   var cnt = 0;
   for (i = 0; i < N; i++) if (m[i] > 0) cnt++;
   if (log) log("Saturation guard: " + n + " px >= " + lev + ", protected " + cnt
      + " px (grow " + g + ")");
   return m;
}

// ===========================================================================
// Frame-level trail detection and line removal (v2.6)
// ===========================================================================
var STR_DET_BIN    = 16;     // residual binning for the line search
var STR_DET_DTHETA = 0.2;    // Radon angle step (degrees)
var STR_DET_MINLEN = 60;     // minimum line length in binned px (~1000 px)
var STR_DET_MAXLINES = 8;

// Running median of a (Float64Array, length n) over +-half samples, evaluated every
// max(1, half/8) samples and linearly interpolated (3.0, robust pedestal).
function STR_runMedian(a, n, half) {
   var st = Math.max(1, Math.floor(half / 8)), nk = Math.floor((n - 1) / st) + 1, k, i, j, lo, hi, buf;
   var knot = new Float64Array(nk + 1), pos = new Float64Array(nk + 1);
   for (k = 0; k < nk; k++) {
      i = k * st; lo = Math.max(0, i - half); hi = Math.min(n - 1, i + half); buf = [];
      for (j = lo; j <= hi; j++) buf.push(a[j]);
      knot[k] = STR_median(buf); pos[k] = i;
   }
   if (pos[nk - 1] < n - 1) {
      i = n - 1; lo = Math.max(0, i - half); buf = [];
      for (j = lo; j <= i; j++) buf.push(a[j]);
      knot[nk] = STR_median(buf); pos[nk] = i; nk++;
   }
   var out = new Float64Array(n);
   for (k = 0; k < nk - 1; k++) {
      for (i = pos[k]; i < pos[k + 1]; i++) out[i] = knot[k] + (knot[k + 1] - knot[k]) * (i - pos[k]) / (pos[k + 1] - pos[k]);
   }
   out[n - 1] = knot[nk - 1];
   if (nk === 1) for (i = 0; i < n; i++) out[i] = knot[0];
   return out;
}

function STR_median(arr) {   // plain Array, sorted in place
   var n = arr.length;
   if (n === 0) return 0;
   arr.sort(function(a, b) { return a - b; });
   return (n % 2) ? arr[(n - 1) / 2] : 0.5 * (arr[n / 2 - 1] + arr[n / 2]);
}

// ---------------------------------------------------------------------------
// Matched-filter line search on the residual.
//  residual clipped to +-5 sigma per pixel, binned 16x (mean of valid px) -> minus normalised 15x15 box mean
//  (halos, clusters) -> bins near borders / invalid areas dropped -> minus row
//  and column medians (CMOS banding) -> / robust sigma -> clipped to +-2.5
//  (stars, hot pixels, bright trails cannot dominate) -> line sums S and
//  counts n for every (theta, rho) -> z = S / sqrt(n).  A trail adds up
//  coherently along its length; compact features do not.
// Returns lines [{z, theta (deg, normal angle), rho (binned px), n,
//                 px, py, ux, uy, nx, ny, a0, a1}] in full-res coordinates:
//  point P = (px, py) on the line, direction u, normal n, chord a in [a0, a1].
// ---------------------------------------------------------------------------
function STR_radonDetect(diff, valid, W, H, zThr, sigma, log) {
   var f = STR_DET_BIN, bw = Math.floor(W / f), bh = Math.floor(H / f), nb = bw * bh;
   var v = new Float32Array(nb), m = new Float32Array(nb);
   var bx, by, b, x, y, idx, s, n, dv, clipV = 5 * sigma;
   for (by = 0; by < bh; by++) {
      for (bx = 0; bx < bw; bx++) {
         s = 0; n = 0;
         for (y = by * f; y < by * f + f; y++) {
            idx = y * W + bx * f;
            for (x = 0; x < f; x++, idx++) {
               if (!valid[idx]) continue;
               // per-pixel clip: hot pixels / bright star mismatches cannot inflate a bin
               dv = diff[idx]; if (dv > clipV) dv = clipV; else if (dv < -clipV) dv = -clipV;
               s += dv; n++;
            }
         }
         b = by * bw + bx;
         if (n >= f * f / 2) { v[b] = s / n; m[b] = 1; }
      }
   }
   var vm = new Float32Array(nb);
   for (b = 0; b < nb; b++) vm[b] = v[b] * m[b];
   var B = STR_boxBlur(vm, bw, bh, 7), Bm = STR_boxBlur(m, bw, bh, 7), mm = STR_boxBlur(m, bw, bh, 2);
   vm = null;
   var a = new Float32Array(nb), ok = new Uint8Array(nb), edge = 6;
   for (by = edge; by < bh - edge; by++) {
      for (bx = edge; bx < bw - edge; bx++) {
         b = by * bw + bx;
         if (m[b] > 0 && mm[b] > 0.999 && Bm[b] > 0) { a[b] = v[b] - B[b] / Bm[b]; ok[b] = 1; }
      }
   }
   B = null; Bm = null; mm = null; v = null; m = null;
   var tmp, med;
   for (by = 0; by < bh; by++) {
      tmp = [];
      for (bx = 0; bx < bw; bx++) { b = by * bw + bx; if (ok[b]) tmp.push(a[b]); }
      if (tmp.length > 10) { med = STR_median(tmp); for (bx = 0; bx < bw; bx++) { b = by * bw + bx; if (ok[b]) a[b] -= med; } }
   }
   for (bx = 0; bx < bw; bx++) {
      tmp = [];
      for (by = 0; by < bh; by++) { b = by * bw + bx; if (ok[b]) tmp.push(a[b]); }
      if (tmp.length > 10) { med = STR_median(tmp); for (by = 0; by < bh; by++) { b = by * bw + bx; if (ok[b]) a[b] -= med; } }
   }
   var rs = STR_robustSigma(a, nb, ok);
   var nv = 0;
   for (b = 0; b < nb; b++) if (ok[b]) nv++;
   var xs = new Float64Array(nv), ys = new Float64Array(nv), vals = new Float64Array(nv), k = 0, t;
   var cxb = bw / 2, cyb = bh / 2;
   for (by = 0; by < bh; by++) {
      for (bx = 0; bx < bw; bx++) {
         b = by * bw + bx;
         if (!ok[b]) continue;
         t = (a[b] - rs.mean) / rs.sigma;
         if (t > 2.5) t = 2.5; else if (t < -2.5) t = -2.5;
         xs[k] = bx - cxb; ys[k] = by - cyb; vals[k] = t; k++;
      }
   }
   a = null; ok = null;

   var nAng = Math.round(180 / STR_DET_DTHETA);
   var D = Math.ceil(Math.sqrt(bw * bw + bh * bh) / 2) + 2, R = 2 * D + 1;
   var S = new Float64Array(R), C = new Int32Array(R), cand = [], zc = 0.5 * zThr;
   var ia, th, c, sn, r, z, zl, zr;
   for (ia = 0; ia < nAng; ia++) {
      th = ia * STR_DET_DTHETA * Math.PI / 180;
      c = Math.cos(th); sn = Math.sin(th);
      for (r = 0; r < R; r++) { S[r] = 0; C[r] = 0; }
      for (k = 0; k < nv; k++) {
         r = Math.floor(xs[k] * c + ys[k] * sn + D + 0.5);
         S[r] += vals[k]; C[r]++;
      }
      for (r = 1; r < R - 1; r++) {
         if (C[r] < STR_DET_MINLEN) continue;
         z = S[r] / Math.sqrt(C[r]);
         if (z < zc) continue;
         zl = (C[r - 1] >= STR_DET_MINLEN) ? S[r - 1] / Math.sqrt(C[r - 1]) : -1e9;
         zr = (C[r + 1] >= STR_DET_MINLEN) ? S[r + 1] / Math.sqrt(C[r + 1]) : -1e9;
         if (z >= zl && z >= zr) cand.push([z, ia * STR_DET_DTHETA, r - D, C[r]]);
      }
   }
   cand.sort(function(p, q) { return q[0] - p[0]; });
   var keep = [], i, j, dth, r2, dup;
   for (i = 0; i < cand.length && keep.length < STR_DET_MAXLINES; i++) {
      if (cand[i][0] < zThr) break;
      dup = false;
      for (j = 0; j < keep.length; j++) {
         dth = Math.abs(cand[i][1] - keep[j][1]); r2 = keep[j][2];
         if (dth > 90) { dth = 180 - dth; r2 = -r2; }
         if (dth < 2 && Math.abs(cand[i][2] - r2) < 6) { dup = true; break; }
      }
      if (!dup) keep.push(cand[i]);
   }
   var lines = [], L, Xc = f * (cxb + 0.5), Yc = f * (cyb + 0.5);
   for (i = 0; i < keep.length; i++) {
      th = keep[i][1] * Math.PI / 180; c = Math.cos(th); sn = Math.sin(th);
      L = { z: keep[i][0], theta: keep[i][1], rho: keep[i][2], n: keep[i][3],
            px: Xc + keep[i][2] * f * c, py: Yc + keep[i][2] * f * sn,
            ux: -sn, uy: c, nx: c, ny: sn };
      STR_chord(L, W, H);
      if (L.a1 > L.a0) lines.push(L);
   }
   if (log) log("Trail search: " + nv + " bins (" + f + "x), " + nAng + " angles, "
      + cand.length + " candidates, " + lines.length + " line(s) with z >= " + zThr);
   return lines;
}

// Chord of line L inside [0, W-1] x [0, H-1]: sets L.a0, L.a1
function STR_chord(L, W, H) {
   var t0 = -1e12, t1 = 1e12, lo, hi, p, d, ta, tb;
   var cs = [[L.px, L.ux, W - 1], [L.py, L.uy, H - 1]], i;
   for (i = 0; i < 2; i++) {
      p = cs[i][0]; d = cs[i][1]; lo = 0; hi = cs[i][2];
      if (Math.abs(d) < 1e-12) { if (p < lo || p > hi) { t0 = 1; t1 = 0; } continue; }
      ta = (lo - p) / d; tb = (hi - p) / d;
      if (ta > tb) { var q = ta; ta = tb; tb = q; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
   }
   L.a0 = t0; L.a1 = t1;
}

// Calls fn(idx, a, d) for every pixel with a in [a0, a1] and |d| <= hw
// (a = along-track coordinate, d = signed distance to line L).
function STR_corridor(L, a0, a1, hw, W, H, fn) {
   var ys = [L.py + a0 * L.uy + hw * L.ny, L.py + a0 * L.uy - hw * L.ny,
             L.py + a1 * L.uy + hw * L.ny, L.py + a1 * L.uy - hw * L.ny];
   var ymin = Math.max(0, Math.floor(Math.min(ys[0], ys[1], ys[2], ys[3])));
   var ymax = Math.min(H - 1, Math.ceil(Math.max(ys[0], ys[1], ys[2], ys[3])));
   var y, x, lo, hi, dy, k, c0, x1, x2, xs, xe, dx, idx, skip, cons, ci;
   for (y = ymin; y <= ymax; y++) {
      dy = y - L.py; lo = -1e12; hi = 1e12; skip = false;
      cons = [[L.nx, dy * L.ny, -hw, hw], [L.ux, dy * L.uy, a0, a1]];
      for (ci = 0; ci < 2; ci++) {
         k = cons[ci][0]; c0 = cons[ci][1];
         if (Math.abs(k) < 1e-9) { if (c0 < cons[ci][2] || c0 > cons[ci][3]) { skip = true; break; } continue; }
         x1 = L.px + (cons[ci][2] - c0) / k; x2 = L.px + (cons[ci][3] - c0) / k;
         if (x1 > x2) { var q = x1; x1 = x2; x2 = q; }
         if (x1 > lo) lo = x1;
         if (x2 < hi) hi = x2;
      }
      if (skip) continue;
      xs = Math.max(0, Math.ceil(lo)); xe = Math.min(W - 1, Math.floor(hi));
      idx = y * W + xs;
      for (x = xs; x <= xe; x++, idx++) {
         dx = x - L.px;
         fn(idx, dx * L.ux + dy * L.uy, dx * L.nx + dy * L.ny);
      }
   }
}

// ---------------------------------------------------------------------------
// Refine a detected line at full resolution: cross-profiles of the residual
// (included pixels only) in 512-px segments (1024 ... 4096 px for faint trails,
// shortest giving >= 3 detected segments) -> centroid offsets -> weighted
// linear fit -> corrected position/direction.  Then the mean cross-profile
// gives the corridor half-width L.hw.  incl: Uint8Array (usable pixels).
// ---------------------------------------------------------------------------
function STR_refineLine(L, diff, incl, W, H, sigma, opt) {
   var dmax = 48, nd = 2 * dmax + 1, it, segs = [512, 1024, 2048, 4096], isg = 0, nOk = 0;
   L.nSeg = 0; L.segLen = 0;
   for (it = 0; it < 6 && isg < segs.length; it++) {
      var seg = segs[isg];
      var nSeg = Math.max(1, Math.floor((L.a1 - L.a0) / seg));
      var segLen = (L.a1 - L.a0) / nSeg;
      var Ss = new Float64Array(nSeg * nd), Cs = new Float64Array(nSeg * nd);
      var vmax = 5 * sigma, vmin = -5 * sigma;     // as in detection: stars cannot dominate
      STR_corridor(L, L.a0, L.a1, dmax + 0.49, W, H, function(idx, a, d) {
         if (!incl[idx]) return;
         var si = Math.floor((a - L.a0) / segLen); if (si >= nSeg) si = nSeg - 1; if (si < 0) si = 0;
         var di = Math.round(d) + dmax; if (di < 0 || di >= nd) return;
         var vv = diff[idx]; if (vv > vmax) vv = vmax; else if (vv < vmin) vv = vmin;
         Ss[si * nd + di] += vv; Cs[si * nd + di] += 1;
      });
      var am = [], off = [], wt = [], si, di, p, pk, pkd, cnt, num, den, q, noise;
      for (si = 0; si < nSeg; si++) {
         p = new Float64Array(nd); cnt = 0;
         for (di = 0; di < nd; di++) { q = Cs[si * nd + di]; p[di] = q > 0 ? Ss[si * nd + di] / q : 0; cnt += q; }
         if (cnt < nd * 20) continue;
         pk = -1e30; pkd = 0;
         for (di = 7; di < nd - 7; di++) {          // ignore peaks at the window edge
            q = (p[di - 1] + p[di] + p[di + 1]) / 3;
            if (q > pk) { pk = q; pkd = di; }
         }
         noise = sigma / Math.sqrt(3 * cnt / nd);
         if (pk < 4 * noise) continue;
         num = 0; den = 0;
         for (di = Math.max(0, pkd - 4); di <= Math.min(nd - 1, pkd + 4); di++) {
            if (p[di] > 0) { num += p[di] * (di - dmax); den += p[di]; }
         }
         if (den <= 0) continue;
         am.push(L.a0 + (si + 0.5) * segLen); off.push(num / den); wt.push(Math.min(20, pk / noise));
      }
      // Robust: reject offsets far from the median (stars, nebula knots)
      if (am.length >= 3) {
         var so2 = off.slice(0), med2, dev = [], mad, kk2, am2 = [], off2 = [], wt2 = [];
         med2 = STR_median(so2);
         for (kk2 = 0; kk2 < off.length; kk2++) dev.push(Math.abs(off[kk2] - med2));
         mad = 1.4826 * STR_median(dev.slice(0));
         for (kk2 = 0; kk2 < off.length; kk2++) {
            if (Math.abs(off[kk2] - med2) <= Math.max(3, 3 * mad)) { am2.push(am[kk2]); off2.push(off[kk2]); wt2.push(wt[kk2]); }
         }
         am = am2; off = off2; wt = wt2;
      }
      // Faint trail: not enough detected segments -> try longer segments
      if (am.length < 3) { isg++; continue; }
      var sw = 0, sa = 0, so = 0, saa = 0, sao = 0, kk;
      for (kk = 0; kk < am.length; kk++) {
         sw += wt[kk]; sa += wt[kk] * am[kk]; so += wt[kk] * off[kk];
         saa += wt[kk] * am[kk] * am[kk]; sao += wt[kk] * am[kk] * off[kk];
      }
      var dd = sw * saa - sa * sa, c1 = 0, c0;
      if (Math.abs(dd) > 1e-9 * sw * saa) c1 = (sw * sao - sa * so) / dd;
      c0 = (so - c1 * sa) / sw;
      if (c1 > 0.0035) c1 = 0.0035; else if (c1 < -0.0035) c1 = -0.0035;   // <= 0.2 deg
      if (c0 > 40) c0 = 40; else if (c0 < -40) c0 = -40;
      // new line: point P + c0 n, direction u + c1 n (normalised)
      L.px += c0 * L.nx; L.py += c0 * L.ny;
      var ux = L.ux + c1 * L.nx, uy = L.uy + c1 * L.ny, nrm = Math.sqrt(ux * ux + uy * uy);
      L.ux = ux / nrm; L.uy = uy / nrm; L.nx = L.uy; L.ny = -L.ux;
      if (L.nx * Math.cos(L.theta * Math.PI / 180) + L.ny * Math.sin(L.theta * Math.PI / 180) < 0) { L.nx = -L.nx; L.ny = -L.ny; }
      STR_chord(L, W, H);
      L.nSeg = am.length; L.segLen = Math.round(segLen);
      if (++nOk >= 2) break;   // two successful passes are enough
   }
   // Mean cross-profile -> extent of the trail (v2.9).  The profile window (+-96 px) is wider
   // than the line-search duplicate distance (6 bins = 96 px), so a parallel companion (double
   // trail: satellite pair, aircraft with two lights) merged by the line search is visible here.
   // The extent is asymmetric and the line is re-centred on it: before 2.9 the corridor was
   // symmetric around whichever component the refinement locked onto, and the outer flank of
   // the other component was left in the frame.
   var dW = 96, nW = 2 * dW + 1;
   var P2 = new Float64Array(nW), C2 = new Float64Array(nW);
   // the same profile per along-track segment (companion test, see below)
   var nS = Math.max(1, Math.min(8, Math.floor((L.a1 - L.a0) / 256))), sLen = (L.a1 - L.a0) / nS;
   var Pseg = new Float64Array(nS * nW), Cseg = new Float64Array(nS * nW);
   STR_corridor(L, L.a0, L.a1, dW + 0.49, W, H, function(idx, a, d) {
      if (!incl[idx]) return;
      var di = Math.round(d) + dW; if (di < 0 || di >= nW) return;
      var vv = diff[idx]; if (vv > 50 * sigma) vv = 50 * sigma; else if (vv < -5 * sigma) vv = -5 * sigma;
      P2[di] += vv; C2[di] += 1;
      var sj = Math.floor((a - L.a0) / sLen); if (sj < 0) sj = 0; if (sj >= nS) sj = nS - 1;
      Pseg[sj * nW + di] += vv; Cseg[sj * nW + di] += 1;
   });
   // number of segments in which bins r0..r1 hold significant signal above the segment's wing level
   function segHits(r0, r1) {
      var s, b, sv, sc, ws, wc2, hits = 0;
      for (s = 0; s < nS; s++) {
         sv = 0; sc = 0; ws = 0; wc2 = 0;
         for (b = 0; b < nW; b++) {
            if (b >= r0 && b <= r1) { sv += Pseg[s * nW + b]; sc += Cseg[s * nW + b]; }
            else if (Math.abs(b - dW) >= 72) { ws += Pseg[s * nW + b]; wc2 += Cseg[s * nW + b]; }
         }
         if (sc < 20 || wc2 < 20) continue;
         if (sv / sc - ws / wc2 > 3 * sigma / Math.sqrt(sc)) hits++;
      }
      return hits;
   }
   var prof = new Float64Array(nW), ps = new Float64Array(nW), i, peak = 0, pkI = dW, tot = 0, wl = 0, wc = 0;
   for (i = 0; i < nW; i++) { prof[i] = C2[i] > 0 ? P2[i] / C2[i] : 0; tot += C2[i]; }
   for (i = 0; i < nW; i++) if (Math.abs(i - dW) >= 72) { wl += prof[i]; wc++; }
   wl /= wc;                                   // wing level (pedestal)
   for (i = 0; i < nW; i++) prof[i] -= wl;
   for (i = 0; i < nW; i++) ps[i] = (prof[Math.max(0, i - 1)] + prof[i] + prof[Math.min(nW - 1, i + 1)]) / 3;
   for (i = dW - 8; i <= dW + 8; i++) if (ps[i] > peak) { peak = ps[i]; pkI = i; }
   var nz = sigma / Math.sqrt(Math.max(1, tot / nW)), thr = Math.max(0.25 * peak, 3 * nz);
   // main run: contiguous bins above the threshold around the peak
   var lo = pkI, hi = pkI;
   while (lo > 0 && ps[lo - 1] > thr) lo--;
   while (hi < nW - 1 && ps[hi + 1] > thr) hi++;
   // companions: separate runs that look like a trail component.  A parallel trail is present
   // all along the track; hot pixels, star residuals or nebula knots raise the mean profile
   // locally, so a companion must be significant in at least 60 % as many along-track
   // segments as the main trail (and in at least 2).
   var cThr = Math.max(0.25 * peak, 5 * nz), nComp = 1, r0, r1, rp;
   var mainHits = segHits(lo, hi), needHits = Math.max(2, Math.ceil(0.6 * mainHits));
   for (i = 0; i < nW; i++) {
      if (ps[i] <= thr || (i >= lo && i <= hi)) continue;
      r0 = i; rp = 0;
      while (i < nW && ps[i] > thr && !(i >= lo && i <= hi)) { if (ps[i] > rp) rp = ps[i]; i++; }
      r1 = i - 1;
      if (rp >= cThr && r1 - r0 + 1 >= 3 && r1 - r0 + 1 <= 60 && segHits(r0, r1) >= needHits) {
         if (r0 < lo) lo = r0;
         if (r1 > hi) hi = r1;
         nComp++;
      }
   }
   for (i = lo; i <= hi; i++) if (ps[i] > peak) peak = ps[i];
   // wings of bright trails: extend while above 2 % of the peak (at most 15 px per side).
   // 3.0: with wingMode "noise" this is only provisional; STR_extendWings follows the wings further.
   var wThr = Math.max(0.02 * peak, 3 * nz), ext;
   for (ext = 0; ext < 15 && lo > 0 && ps[lo - 1] > wThr; ext++) lo--;
   for (ext = 0; ext < 15 && hi < nW - 1 && ps[hi + 1] > wThr; ext++) hi++;
   var dL = lo - dW, dR = hi - dW, cOff = 0.5 * (dL + dR), hw = Math.ceil(0.5 * (dR - dL)) + 3;
   if (peak > 0 && Math.abs(cOff) >= 1) {      // re-centre the line on the extent
      L.px += cOff * L.nx; L.py += cOff * L.ny;
      STR_chord(L, W, H);
   }
   if (hw < 4) hw = 4; if (hw > 60) hw = 60;
   if (nOk === 0 && hw < 16) hw = 16;   // not refined: cover the line-search position uncertainty
   L.hw = hw; L.peak = peak; L.peakSNR = peak / nz; L.nComp = nComp; L.shift = cOff;
}

// ---------------------------------------------------------------------------
// 3.0 "noise" wings.  The mean profile over the whole line has a tiny noise (sigma / sqrt(n)), so the
// PSF wings of a bright trail are measurable far below the 2 %-of-peak rule of STR_refineLine.  Wide
// profile (+-dX px) of the residual, baseline = its median beyond 100 px, 5-bin smoothing; from the current
// extent (+-(hw - 3)), each side is extended while the profile stays above 3 x its noise, at most
// wingMax px.  The line is re-centred on the new extent.  Call it on the residual of the re-fitted
// match: the first fit's offset is raised by the trail and hides the outer wings.
// ---------------------------------------------------------------------------
function STR_extendWings(L, diff, incl, W, H, sigma, wingMax) {
   if (L.hwCore === undefined) L.hwCore = L.hw;
   var dX = wingMax + 80, nX = 2 * dX + 1, i, ext, k5, s5, c5;
   var PX = new Float64Array(nX), CX = new Float64Array(nX);
   STR_corridor(L, L.a0, L.a1, dX + 0.49, W, H, function(idx, a, d) {
      if (!incl[idx]) return;
      var di = Math.round(d) + dX; if (di < 0 || di >= nX) return;
      var vv = diff[idx]; if (vv > 50 * sigma) vv = 50 * sigma; else if (vv < -5 * sigma) vv = -5 * sigma;
      PX[di] += vv; CX[di] += 1;
   });
   // baseline: median of the profile over 100 px <= |d| <= dX (robust to another feature in the band)
   var totX = 0, pX = new Float64Array(nX), sX = new Float64Array(nX), far = [];
   for (i = 0; i < nX; i++) {
      pX[i] = CX[i] > 0 ? PX[i] / CX[i] : 0; totX += CX[i];
      if (Math.abs(i - dX) >= 100 && CX[i] > 0) far.push(pX[i]);
   }
   var bX = far.length > 0 ? STR_median(far) : 0;
   for (i = 0; i < nX; i++) {
      s5 = 0; c5 = 0;
      for (k5 = Math.max(0, i - 2); k5 <= Math.min(nX - 1, i + 2); k5++) { s5 += pX[k5] - bX; c5++; }
      sX[i] = s5 / c5;
   }
   var nzX = sigma / Math.sqrt(Math.max(1, 5 * totX / nX)), xThr = 3 * nzX;
   var h0 = Math.max(1, L.hw - 3), loX = dX - h0, hiX = dX + h0;
   for (ext = 0; ext < wingMax && loX > 0 && sX[loX - 1] > xThr; ext++) loX--;
   for (ext = 0; ext < wingMax && hiX < nX - 1 && sX[hiX + 1] > xThr; ext++) hiX++;
   var dL = loX - dX, dR = hiX - dX, cOff = 0.5 * (dL + dR), hw = Math.ceil(0.5 * (dR - dL)) + 3;
   if (Math.abs(cOff) >= 1) {
      L.px += cOff * L.nx; L.py += cOff * L.ny;
      STR_chord(L, W, H);
      L.shift = (L.shift || 0) + cOff;
   }
   L.wingShift = (L.wingShift || 0) + (Math.abs(cOff) >= 1 ? cOff : 0);
   if (hw > wingMax + 40) hw = wingMax + 40;
   if (hw > L.hw) L.hw = hw;
   L.wingNoise = nzX; L.wingL = dL; L.wingR = dR;
}

// ---------------------------------------------------------------------------
// Along-track trail model T(a, d) inside the corridor of line L (estimated
// over the corridor + 8 px margin, minus the margin level = pedestal): mean residual
// of included pixels in 1-px along-track bins and 1-px distance bins, box-
// averaged along track over +-Lw px; two passes (2nd rejects |r - T0| > 4 sigma:
// hot pixels, residual star mismatch).  T is added to lineT (linear in d),
// attenuated by the saturation protection and blended with the per-pixel
// weight (removed = w*r + (1-w)*T); corridor pixels are marked in corr.
// Returns the number of newly marked corridor pixels.
// ---------------------------------------------------------------------------
function STR_lineModel(L, diff, incl, W, H, sigma, Lw, lineT, w, sp, corr, opt) {
   var hwT = L.hw, mg = 8, hw = hwT + mg, nd = 2 * hw + 1, a0 = L.a0, La = Math.floor(L.a1 - a0) + 1;
   var S = new Float64Array(La * nd), C = new Float64Array(La * nd);
   var T0 = null, T = null, pass, rej = 4 * sigma, Cb = null;
   function boxAlong(wantC) {
      var out = new Float32Array(La * nd), di, ai, s, c, add, rem;
      if (wantC) Cb = new Float32Array(La * nd);
      for (di = 0; di < nd; di++) {
         s = 0; c = 0;
         for (ai = 0; ai <= Lw && ai < La; ai++) { s += S[ai * nd + di]; c += C[ai * nd + di]; }
         for (ai = 0; ai < La; ai++) {
            out[ai * nd + di] = (c >= 3) ? s / c : 0;
            if (wantC) Cb[ai * nd + di] = c;
            add = ai + Lw + 1; rem = ai - Lw;
            if (add < La) { s += S[add * nd + di]; c += C[add * nd + di]; }
            if (rem >= 0) { s -= S[rem * nd + di]; c -= C[rem * nd + di]; }
         }
      }
      return out;
   }
   for (pass = 0; pass < 2; pass++) {
      if (pass === 1) { for (var q = 0; q < La * nd; q++) { S[q] = 0; C[q] = 0; } }
      STR_corridor(L, a0, L.a1, hw + 0.49, W, H, function(idx, a, d) {
         if (!incl[idx]) return;
         var ai = Math.floor(a - a0); if (ai < 0) ai = 0; if (ai >= La) ai = La - 1;
         var di = Math.round(d) + hw; if (di < 0 || di >= nd) return;
         var vv = diff[idx];
         if (T0 !== null) { var e = vv - T0[ai * nd + di]; if (e > rej || e < -rej) return; }
         S[ai * nd + di] += vv; C[ai * nd + di] += 1;
      });
      if (pass === 0) T0 = boxAlong(false); else T = boxAlong(opt && opt.wingGuard);
   }
   // Distance bins where the line's mean profile (whole length) is not significant carry no
   // trail: their model is set to 0 (v2.9).  Clamping noise at 0 there would subtract
   // E[max(0, noise)] ~ 0.4 x the bin noise (~0.035 sigma/px with a 129 px window).
   var sig_d = new Uint8Array(nd), gS, gC, gp = 0, gpc = 0, dj, aj;
   var gm = new Float64Array(nd), gn = new Float64Array(nd);
   for (dj = 0; dj < nd; dj++) {
      gS = 0; gC = 0;
      for (aj = 0; aj < La; aj++) { gS += S[aj * nd + dj]; gC += C[aj * nd + dj]; }
      gm[dj] = gC > 0 ? gS / gC : 0; gn[dj] = gC;
      if (dj < mg || dj >= nd - mg) { gp += gm[dj]; gpc++; }
   }
   gp /= Math.max(1, gpc);
   for (dj = 0; dj < nd; dj++) sig_d[dj] = (gn[dj] > 0 && gm[dj] - gp > 3 * sigma / Math.sqrt(gn[dj])) ? 1 : 0;
   S = null; C = null; T0 = null;
   // Pedestal: mean of the outer margin bins (hwT < |d| <= hw) at each along-track
   // position; only the trail profile above it is removed (no smooth residual
   // structure such as nebula mismatch is subtracted).
   // 3.0 (opt.robustPedestal): each side's margin level is compared with its own along-track
   // running median (+-4 Lw).  Where the two sides depart differently, the side departing by more
   // than its noise is contaminated (a star's mismatch ring falling in the margin made the mean
   // pedestal 3 sigma low over the +-Lw window, i.e. +3 sigma of model on both sides of the
   // trail: a black spot) and is replaced by its running median.
   var ai2, di2, pb, pc, pedA = null;
   if (opt && opt.robustPedestal) {
      var pL = new Float64Array(La), pR = new Float64Array(La);
      for (ai2 = 0; ai2 < La; ai2++) {
         pb = 0; pc = 0;
         for (di2 = 0; di2 < mg; di2++) { pb += T[ai2 * nd + di2]; pc += T[ai2 * nd + nd - 1 - di2]; }
         pL[ai2] = pb / mg; pR[ai2] = pc / mg;
      }
      var mL = STR_runMedian(pL, La, 4 * Lw), mR = STR_runMedian(pR, La, 4 * Lw);
      var pTol = 4 * sigma / Math.sqrt(mg * (2 * Lw + 1)) + 0.05 * sigma, okL, okR, nBad = 0;
      pedA = new Float64Array(La);
      // Only a departure on ONE side is a contamination: a feature crossing the whole corridor
      // (another trail, a galaxy arm) raises both margins and is correctly cancelled by the mean.
      var eL, eR;
      for (ai2 = 0; ai2 < La; ai2++) {
         eL = pL[ai2] - mL[ai2]; eR = pR[ai2] - mR[ai2];
         var vl = pL[ai2], vr = pR[ai2];
         if (Math.abs(eL - eR) > 1.41 * pTol) {
            okL = Math.abs(eL) <= pTol; okR = Math.abs(eR) <= pTol;
            if (!okL) vl = mL[ai2];
            if (!okR) vr = mR[ai2];
            if (!okL || !okR) nBad++;
         }
         pedA[ai2] = 0.5 * (vl + vr);
      }
      L.pedReplaced = nBad;
   }
   for (ai2 = 0; ai2 < La; ai2++) {
      if (pedA !== null) pb = pedA[ai2];
      else {
         pb = 0; pc = 0;
         for (di2 = 0; di2 < mg; di2++) { pb += T[ai2 * nd + di2] + T[ai2 * nd + nd - 1 - di2]; pc += 2; }
         pb /= pc;
      }
      for (di2 = 0; di2 < nd; di2++) {
         var tv = T[ai2 * nd + di2] - pb;
         T[ai2 * nd + di2] = (tv > 0 && sig_d[di2]) ? tv : 0;   // a trail only adds light
      }
   }
   // 3.0 (opt.wingGuard): outside the core (|d| > L.hwCore, the width before the wing extension)
   // the model is held to the trail's own shape: E(a, d) = A(a) g(d), g = the line's whole-length
   // mean profile above its margin, A(a) = least-squares amplitude of the local core on g.  T may
   // exceed E by at most 3 x its bin noise + 25 % of E (it is only lowered, never raised: raising it
   // would over-subtract where the real wing is fainter than the mean shape).  A star's mismatch
   // ring in a few wing bins was otherwise spread over +-Lw along the track (thin dark streaks
   // beside bright stars).  The core zone stays centred on the core: the wing extension re-centres
   // the line on its wings (by L.wingShift), the core is then at d = -L.wingShift.
   var hc = (opt && opt.wingGuard && L.hwCore !== undefined) ? L.hwCore : -1;
   var cC = hw - Math.round(L.wingShift || 0), cLo = Math.max(0, cC - hc), cHi = Math.min(nd - 1, cC + hc);
   if (hc >= 0 && hc < hwT && Cb !== null) {
      var gpr = new Float64Array(nd), sgg = 0, nG = 0;
      for (dj = 0; dj < nd; dj++) {
         gpr[dj] = sig_d[dj] ? Math.max(0, gm[dj] - gp) : 0;
         if (dj >= cLo && dj <= cHi) sgg += gpr[dj] * gpr[dj];
      }
      if (sgg > 0) {
         for (ai2 = 0; ai2 < La; ai2++) {
            var sgt = 0, Aa, base = ai2 * nd;
            for (dj = cLo; dj <= cHi; dj++) sgt += gpr[dj] * T[base + dj];
            Aa = sgt > 0 ? sgt / sgg : 0;
            for (dj = 0; dj < nd; dj++) {
               if (dj >= cLo && dj <= cHi) continue;
               var Ev = Aa * gpr[dj], tl = 3 * sigma / Math.sqrt(Math.max(1, Cb[base + dj])) + 0.25 * Ev;
               if (T[base + dj] > Ev + tl) { T[base + dj] = Ev + tl; nG++; }
            }
         }
      }
      L.wingGuarded = nG;
   }
   var n = 0;
   STR_corridor(L, a0, L.a1, hwT + 0.49, W, H, function(idx, a, d) {
      var ai = Math.floor(a - a0); if (ai < 0) ai = 0; if (ai >= La) ai = La - 1;
      var fd = d + hw, d0 = Math.floor(fd), t = fd - d0, v0, v1;
      if (d0 < 0) { d0 = 0; t = 0; }
      if (d0 >= nd - 1) { d0 = nd - 1; t = 0; }
      v0 = T[ai * nd + d0]; v1 = (d0 + 1 < nd) ? T[ai * nd + d0 + 1] : v0;
      var val = v0 + t * (v1 - v0);
      if (sp) val *= 1 - sp[idx];
      // Blend with the per-pixel weight: where w = 1 (bright trail core) the
      // pixel is replaced as before (follows flares exactly); where w = 0
      // (faint trail) the along-track model is subtracted.
      lineT[idx] += (1 - w[idx]) * val;
      if (!corr[idx]) { corr[idx] = 1; n++; }
   });
   return n;
}

// ---------------------------------------------------------------------------
// Elongated blobs of the weight map (w >= 0.5, 8-connected): PCA length (extent
// along the major axis) and width sqrt(12 lambda2) + 1.  A blob is a trail if
// length >= minLen and length / width >= minAspect (catches short or bright
// trails, e.g. a segment at the frame edge, that the line search misses).
// Returns [{len, wid, cx, cy, n, pix (Int32Array)}].
// ---------------------------------------------------------------------------
function STR_elongatedBlobs(w, W, H, minLen, minAspect) {
   var N = W * H, vis = new Uint8Array(N), out = [];
   var cap = 1 << 16, buf = new Int32Array(cap), head, tail, i, j, p, x, y, nx2, ny2, q, dxx, dyy;
   function push(v) {
      if (tail >= cap) {
         var nb = new Int32Array(cap * 2), k;
         for (k = 0; k < cap; k++) nb[k] = buf[k];
         buf = nb; cap *= 2;
      }
      buf[tail++] = v;
   }
   for (i = 0; i < N; i++) {
      if (vis[i] || !(w[i] >= 0.5)) continue;
      head = 0; tail = 0; vis[i] = 1; push(i);
      var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      while (head < tail) {
         p = buf[head++]; x = p % W; y = (p - x) / W;
         sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
         for (dyy = -1; dyy <= 1; dyy++) {
            ny2 = y + dyy; if (ny2 < 0 || ny2 >= H) continue;
            for (dxx = -1; dxx <= 1; dxx++) {
               nx2 = x + dxx; if (nx2 < 0 || nx2 >= W) continue;
               q = ny2 * W + nx2;
               if (!vis[q] && w[q] >= 0.5) { vis[q] = 1; push(q); }
            }
         }
      }
      var n = tail;
      if (n < 50) continue;
      var mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
      var tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      var l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
      var ex = (Math.abs(cxy) > 1e-12) ? l1 - cyy : (cxx >= cyy ? 1 : 0), ey = (Math.abs(cxy) > 1e-12) ? cxy : (cxx >= cyy ? 0 : 1);
      var en = Math.sqrt(ex * ex + ey * ey); ex /= en; ey /= en;
      var pmin = 1e30, pmax = -1e30, pr;
      for (j = 0; j < n; j++) {
         p = buf[j]; x = p % W; y = (p - x) / W;
         pr = (x - mx) * ex + (y - my) * ey;
         if (pr < pmin) pmin = pr; if (pr > pmax) pmax = pr;
      }
      var len = pmax - pmin, wid = Math.sqrt(12 * l2) + 1;
      if (len >= minLen && len / wid >= minAspect) {
         var pix = new Int32Array(n);
         for (j = 0; j < n; j++) pix[j] = buf[j];
         out.push({ len: len, wid: wid, cx: mx, cy: my, n: n, pix: pix });
      }
   }
   return out;
}

// ---------------------------------------------------------------------------
// Frame-level detection + line removal.
// Returns {hasTrail, lines, blobs, lineT (Float32Array or null: (1-w)*T),
//          region (Float32Array or null: dilated blob regions + corridors), nCorr}
// ---------------------------------------------------------------------------
function STR_detectTrails(sub, stack, diff, valid, w, sp, W, H, P, sigma, log, dump, refit) {
   var N = W * H, t0 = Date.now(), i;
   var zThr   = STR_num(P.detectZ, 15);
   var minLen = STR_num(P.blobMinLen, 300), minAsp = STR_num(P.blobMinAspect, 10);
   var Lw     = Math.round(STR_num(P.alongWin, 64));
   var grow   = Math.round(STR_num(P.growRadius, 3)), feather = Math.round(STR_num(P.featherRadius, 2));
   var lines = STR_radonDetect(diff, valid, W, H, zThr, sigma, log);
   var tR = Date.now() - t0;
   var blobs = STR_elongatedBlobs(w, W, H, minLen, minAsp);

   // Blob regions (for "only modify detected trails")
   var region = null;
   if (blobs.length > 0) {
      region = new Float32Array(N);
      for (i = 0; i < blobs.length; i++) {
         var px = blobs[i].pix;
         for (var j = 0; j < px.length; j++) region[px[j]] = 1;
      }
      region = STR_maxFilter(region, W, H, grow + feather + 2);
   }

   // Lines: usable-pixel mask (valid, not saturated, not a star in the stack),
   // refinement, along-track model
   var lineT = null, nCorr = 0, corr = null;
   if (lines.length > 0) {
      var incl = new Uint8Array(N), hp = STR_boxBlur(stack, W, H, STR_HP_RADIUS), thr = 3 * sigma;
      for (i = 0; i < N; i++) {
         incl[i] = (valid[i] && !(sp && sp[i] > 0) && (stack[i] - hp[i]) <= thr) ? 1 : 0;
      }
      hp = null;
      for (i = 0; i < lines.length; i++) STR_refineLine(lines[i], diff, incl, W, H, sigma, null);
   }
   // 3.0: re-fit the gain/offset match with the trails excluded.  The first fit sees the trail
   // wings (below the 3-sigma clip) and raises the offset of every window the trail crosses,
   // so the replaced core (w = 1 -> gain*stack + offset) stayed slightly bright.
   var newDiff = null;
   if (refit && (lines.length > 0 || blobs.length > 0)) {
      var ex = new Float32Array(N), xmg = 48;   // provisional corridor + the outer wings
      for (i = 0; i < lines.length; i++) {
         STR_corridor(lines[i], lines[i].a0, lines[i].a1, lines[i].hw + xmg + 0.49, W, H, function(idx) { ex[idx] = 1; });
      }
      if (region !== null) for (i = 0; i < N; i++) if (region[i] > 0) ex[i] = 1;
      ex = STR_maxFilter(ex, W, H, 8);
      var exu = new Uint8Array(N), nEx = 0;
      for (i = 0; i < N; i++) if (ex[i] > 0) { exu[i] = 1; nEx++; }
      ex = null;
      if (log) log("Re-fitting the adaptive match with " + nEx + " trail px excluded");
      newDiff = refit(exu);
      exu = null;
      diff = newDiff;
   }
   if (lines.length > 0 && P.wingMode === "noise") {
      var wingMax = Math.round(STR_num(P.wingMax, 120));
      for (i = 0; i < lines.length; i++) STR_extendWings(lines[i], diff, incl, W, H, sigma, wingMax);
   }
   if (lines.length > 0) {
      if (P.lineRemoval !== false) {
         corr = new Uint8Array(N);
         lineT = new Float32Array(N);
         var lopt = { robustPedestal: P.robustPedestal === true, wingGuard: P.wingGuard === true };
         // 3.0 (robustPedestal): the other detected lines are excluded from each line's model
         // (a crossing trail entered the margins at different along-track positions on the two
         // sides and the wing bins; each line's own model removes it)
         var inclX = null, setOff = function(idx) { inclX[idx] = 0; };
         for (i = 0; i < lines.length; i++) {
            var inc_i = incl;
            if (lopt.robustPedestal && lines.length > 1) {
               inclX = new Uint8Array(incl);
               for (var o = 0; o < lines.length; o++) {
                  if (o !== i) STR_corridor(lines[o], lines[o].a0, lines[o].a1, lines[o].hw + 8.49, W, H, setOff);
               }
               inc_i = inclX;
            }
            nCorr += STR_lineModel(lines[i], diff, inc_i, W, H, sigma, Lw, lineT, w, sp, corr, lopt);
            inclX = null;
         }
      }
      incl = null;
   }
   // Allowed region for "only modify detected trails" = blob regions + corridors
   if (corr !== null) {
      if (region === null) region = new Float32Array(N);
      for (i = 0; i < N; i++) if (corr[i]) region[i] = 1;
      corr = null;
   }
   var hasTrail = lines.length > 0 || blobs.length > 0;
   if (log) {
      log("Trail detection: " + (hasTrail ? "TRAIL" : "no trail") + " (" + lines.length + " line(s), "
         + blobs.length + " elongated blob(s)); search " + (tR / 1000).toFixed(1) + " s, total "
         + ((Date.now() - t0) / 1000).toFixed(1) + " s");
      for (i = 0; i < lines.length; i++) {
         var L = lines[i];
         log("  line " + (i + 1) + ": z=" + L.z.toFixed(1) + ", from (" + Math.round(L.px + L.a0 * L.ux) + ","
            + Math.round(L.py + L.a0 * L.uy) + ") to (" + Math.round(L.px + L.a1 * L.ux) + ","
            + Math.round(L.py + L.a1 * L.uy) + "), half-width " + L.hw + " px, peak "
            + (L.peak / sigma).toFixed(2) + " sigma/px, refined on " + L.nSeg + " x " + L.segLen + " px"
            + (L.nComp > 1 ? ", " + L.nComp + " parallel components" : "")
            + (Math.abs(L.shift) >= 1 ? ", re-centred by " + L.shift.toFixed(1) + " px" : "")
            + (L.pedReplaced ? ", one-sided pedestal fixed at " + L.pedReplaced + " px" : "")
            + (L.wingGuarded ? ", wing model held to the profile in " + L.wingGuarded + " bins" : ""));
      }
      for (i = 0; i < blobs.length; i++) {
         log("  blob " + (i + 1) + ": length " + Math.round(blobs[i].len) + " px, width "
            + blobs[i].wid.toFixed(1) + " px, centre (" + Math.round(blobs[i].cx) + "," + Math.round(blobs[i].cy) + ")");
      }
      if (lineT) log("  line removal: " + nCorr + " corridor px, along-track window +-" + Lw + " px");
   }
   if (dump) { if (lineT) dump("trail_line_model", lineT); if (region) dump("trail_blob_region", region); }
   var outLines = [], outBlobs = [];
   for (i = 0; i < lines.length; i++) {
      L = lines[i];
      outLines.push({ z: L.z, x0: L.px + L.a0 * L.ux, y0: L.py + L.a0 * L.uy, x1: L.px + L.a1 * L.ux,
                      y1: L.py + L.a1 * L.uy, hw: L.hw, peakSigma: L.peak / sigma, nComp: L.nComp || 1 });
   }
   for (i = 0; i < blobs.length; i++) outBlobs.push({ len: blobs[i].len, wid: blobs[i].wid, cx: blobs[i].cx, cy: blobs[i].cy });
   return { hasTrail: hasTrail, lines: outLines, blobs: outBlobs, lineT: lineT, region: region, nCorr: nCorr,
            diff: newDiff };
}

// ---------------------------------------------------------------------------
// Full pipeline for one channel.
// `sub` is OVERWRITTEN in place with the corrected data.
// Returns {diff, weight, removed (or null), gainGrid, offsetGrid, BW, BH,
//          blockSize, nAny, nFull, removedFlux}
// ---------------------------------------------------------------------------
// `dump` (optional): function(name, fullFrameArray) called with intermediate
// images, read-only (debugging; does not change the result).
// 3.0: P.wideTrails switches on the wide-trail removal as one option: wings followed down to the
// noise (wingMode "noise", up to P.wingMax px), adaptive match re-fitted with the trails excluded,
// one-sided pedestal repair and the wing guard of STR_lineModel.  Each of the four can still be
// set on its own (an explicit value wins).  Returns P itself when the option is off.
function STR_trailOptions(P) {
   if (P.wideTrails !== true) return P;
   var Q = {}, k;
   for (k in P) if (P.hasOwnProperty(k)) Q[k] = P[k];
   if (Q.wingMode === undefined) Q.wingMode = "noise";
   if (Q.refitOffset === undefined) Q.refitOffset = true;
   if (Q.robustPedestal === undefined) Q.robustPedestal = true;
   if (Q.wingGuard === undefined) Q.wingGuard = true;
   return Q;
}

function STR_processChannel(sub, stack, W, H, P, log, dump) {
   var N = W * H;
   P = STR_trailOptions(P);
   if (dump) { dump("sub_in", sub); dump("stack_in", stack); }
   var vm = STR_validMask(sub, stack, N);
   if (log) log("Valid pixels: " + vm.count + " / " + N
      + " (" + (100 * vm.count / N).toFixed(2) + " %)");
   if (vm.count < 1000) throw new Error("Too few valid (non-black) pixels in sub/stack overlap.");
   if (dump) dump("valid", vm.mask);

   var tA = Date.now();
   var as = STR_adaptiveSubtract(sub, stack, vm.mask, W, H, P, log);
   if (log) log("  time: adaptive match " + ((Date.now() - tA) / 1000).toFixed(1) + " s");
   if (dump) dump("residual", as.diff);
   var rw = STR_residualWeight(sub, as.diff, vm.mask, W, H, P, log, dump);
   var w = rw.weight, diff = as.diff;

   // Saturation guard (v2.3): saturated pixels carry no information (a trail
   // cannot add to a clipped pixel) and their residual is meaningless, so the
   // weight is forced to 0 there.  Only the weight changes.
   if (P.satGuard !== false) {
      var sp = STR_saturationProtect(sub, stack, vm.mask, W, H, P, log);
      if (sp !== null) {
         if (dump) dump("saturation_protect", sp);
         rw.nAny = 0; rw.nFull = 0;
         for (var j = 0; j < N; j++) {
            if (sp[j] > 0) w[j] *= 1 - sp[j];
            if (w[j] > 1e-4) { rw.nAny++; if (w[j] >= 0.999) rw.nFull++; }
            else w[j] = 0;
         }
         if (log) log("After saturation guard: w>0: " + rw.nAny + " px, w=1: " + rw.nFull + " px");
      }
   }

   // Frame-level trail detection, line removal, restriction (v2.6)
   var det = null, lineT = null, i;
   if (P.detectEnable === true) {
      var refit = (P.refitOffset === true) ? function(ex) {
         return STR_adaptiveSubtract(sub, stack, vm.mask, W, H, P, log, ex).diff;
      } : null;
      det = STR_detectTrails(sub, stack, diff, vm.mask, w, (typeof sp !== "undefined") ? sp : null,
                             W, H, P, as.sigma, log, dump, refit);
      if (det.diff) diff = det.diff;
      lineT = det.lineT;
      if (P.restrictToTrails !== false) {
         var reg = det.region;
         for (i = 0; i < N; i++) if (!(reg !== null && reg[i] > 0)) w[i] = 0;
         if (log) log(det.hasTrail ? "Correction restricted to the detected trail(s)."
                                   : "No trail detected: image left unchanged.");
      }
      rw.nAny = 0; rw.nFull = 0;
      for (i = 0; i < N; i++) {
         if (w[i] > 1e-4 || (lineT !== null && lineT[i] !== 0)) { rw.nAny++; if (w[i] >= 0.999) rw.nFull++; }
      }
   }

   var removed = (P.wantRemoved || dump) ? new Float32Array(N) : null;
   var rv, c, flux = 0;
   for (i = 0; i < N; i++) {
      if (w[i] === 0 && (lineT === null || lineT[i] === 0)) continue;
      rv = w[i] * diff[i];
      if (lineT !== null) rv += lineT[i];
      c = sub[i] - rv;
      if (c < 0) c = 0; else if (c > 1) c = 1;
      rv = sub[i] - c;
      sub[i] = c;
      flux += rv;
      if (removed) removed[i] = rv;
   }
   if (log) log("Removed flux: " + flux.toExponential(4)
      + (rw.nAny > 0 ? " (mean " + (flux / rw.nAny).toExponential(3) + " over w>0 px)" : ""));
   if (dump) { dump("removed", removed); dump("corrected", sub); }

   return {
      diff: diff, weight: w, removed: removed,
      gainGrid: as.gainGrid, offsetGrid: as.offsetGrid,
      BW: as.BW, BH: as.BH, blockSize: as.blockSize,
      nAny: rw.nAny, nFull: rw.nFull, removedFlux: flux,
      trail: det ? { hasTrail: det.hasTrail, lines: det.lines, blobs: det.blobs } : null
   };
}

// ==== CORE END
return STR_processChannel;
}
var STR_processChannel = STRW_core();

// Deband's core, wrapped in a function like the trail core so that its source
// text can be sent to the threads (FDW_threadSource).  The code between the markers
// is unchanged.
function FDW_core() {
// ==== CORE BEGIN ====
// Pure ECMAScript 5 numerical core (no PJSR dependencies) so it can be
// unit-tested outside PixInsight.

// ---------------------------------------------------------------------
// 1-D complex FFT: mixed radix (4, 2, generic small primes), KISS-FFT
// structure; Bluestein chirp-z for lengths with a prime factor > 31.
// Only the forward transform is implemented; inverse = conj(F(conj(x))).
// ---------------------------------------------------------------------
function FD_factorize(n)
{
   var f = [], p = 4, fl = Math.floor(Math.sqrt(n));
   do
   {
      while (n % p)
      {
         switch (p)
         {
            case 4: p = 2; break;
            case 2: p = 3; break;
            default: p += 2; break;
         }
         if (p > fl) p = n;
      }
      n /= p;
      f.push(p);
      f.push(n);
   }
   while (n > 1);
   return f;
}

function FD_FFTPlan(n)
{
   this.n = n;
   this.bluestein = false;
   if (n < 2)
   {
      this.factors = [1, 1];
      return;
   }
   var f = FD_factorize(n), maxp = 1, i;
   for (i = 0; i < f.length; i += 2)
      if (f[i] > maxp) maxp = f[i];
   if (maxp > 31)
   {
      // Bluestein
      this.bluestein = true;
      var m = 1;
      while (m < 2 * n - 1) m *= 2;
      this.m = m;
      this.sub = new FD_FFTPlan(m);
      this.wRe = new Float64Array(n);
      this.wIm = new Float64Array(n);
      var twoN = 2 * n;
      for (i = 0; i < n; ++i)
      {
         var kk = (i * i) % twoN;           // exact for n < ~6.7e7
         var a = Math.PI * kk / n;
         this.wRe[i] = Math.cos(a);
         this.wIm[i] = -Math.sin(a);        // w_k = exp(-i*pi*k^2/n)
      }
      var bRe = new Float64Array(m), bIm = new Float64Array(m);
      bRe[0] = this.wRe[0]; bIm[0] = -this.wIm[0];
      for (i = 1; i < n; ++i)
      {
         bRe[i] = bRe[m - i] = this.wRe[i];
         bIm[i] = bIm[m - i] = -this.wIm[i];   // conj(w)
      }
      this.BRe = new Float64Array(m);
      this.BIm = new Float64Array(m);
      this.sub.transform(bRe, bIm, this.BRe, this.BIm);
      this.aRe = new Float64Array(m); this.aIm = new Float64Array(m);
      this.cRe = new Float64Array(m); this.cIm = new Float64Array(m);
      return;
   }
   this.factors = f;
   this.twRe = new Float64Array(n);
   this.twIm = new Float64Array(n);
   for (i = 0; i < n; ++i)
   {
      var ang = -2 * Math.PI * i / n;
      this.twRe[i] = Math.cos(ang);
      this.twIm[i] = Math.sin(ang);
   }
   this.scRe = new Float64Array(maxp);
   this.scIm = new Float64Array(maxp);
}

FD_FFTPlan.prototype.transform = function(iRe, iIm, oRe, oIm)
{
   var n = this.n;
   if (n < 2) { oRe[0] = iRe[0]; oIm[0] = iIm[0]; return; }
   if (!this.bluestein)
   {
      this.work(oRe, oIm, 0, iRe, iIm, 0, 1, 0);
      return;
   }
   var m = this.m, i, wr, wi, xr, xi;
   var aRe = this.aRe, aIm = this.aIm, cRe = this.cRe, cIm = this.cIm;
   for (i = 0; i < n; ++i)
   {
      wr = this.wRe[i]; wi = this.wIm[i]; xr = iRe[i]; xi = iIm[i];
      aRe[i] = xr * wr - xi * wi;
      aIm[i] = xr * wi + xi * wr;
   }
   for (i = n; i < m; ++i) { aRe[i] = 0; aIm[i] = 0; }
   this.sub.transform(aRe, aIm, cRe, cIm);
   // multiply by B, then inverse via conj trick
   var BRe = this.BRe, BIm = this.BIm;
   for (i = 0; i < m; ++i)
   {
      xr = cRe[i]; xi = cIm[i];
      aRe[i] = xr * BRe[i] - xi * BIm[i];
      aIm[i] = -(xr * BIm[i] + xi * BRe[i]);     // conjugate
   }
   this.sub.transform(aRe, aIm, cRe, cIm);
   var inv = 1 / m;
   for (i = 0; i < n; ++i)
   {
      xr = cRe[i] * inv; xi = -cIm[i] * inv;     // conj back, normalize
      wr = this.wRe[i]; wi = this.wIm[i];
      oRe[i] = xr * wr - xi * wi;
      oIm[i] = xr * wi + xi * wr;
   }
};

FD_FFTPlan.prototype.work = function(oRe, oIm, oo, iRe, iIm, fi, fstride, fidx)
{
   var p = this.factors[fidx], m = this.factors[fidx + 1];
   var oend = oo + p * m, o;
   if (m == 1)
   {
      for (o = oo; o < oend; ++o)
      {
         oRe[o] = iRe[fi]; oIm[o] = iIm[fi];
         fi += fstride;
      }
   }
   else
   {
      for (o = oo; o < oend; o += m)
      {
         this.work(oRe, oIm, o, iRe, iIm, fi, fstride * p, fidx + 2);
         fi += fstride;
      }
   }
   var twRe = this.twRe, twIm = this.twIm, k, t;
   if (p == 2)
   {
      for (k = 0; k < m; ++k)
      {
         var a = oo + k, b = a + m;
         t = k * fstride;
         var wr = twRe[t], wi = twIm[t];
         var tr = oRe[b] * wr - oIm[b] * wi, ti = oRe[b] * wi + oIm[b] * wr;
         oRe[b] = oRe[a] - tr; oIm[b] = oIm[a] - ti;
         oRe[a] += tr; oIm[a] += ti;
      }
   }
   else if (p == 4)
   {
      var m2 = 2 * m, m3 = 3 * m;
      for (k = 0; k < m; ++k)
      {
         var i0 = oo + k, i1 = i0 + m, i2 = i0 + m2, i3 = i0 + m3;
         var t1 = k * fstride, t2 = 2 * t1, t3 = 3 * t1;
         var s0r = oRe[i1] * twRe[t1] - oIm[i1] * twIm[t1], s0i = oRe[i1] * twIm[t1] + oIm[i1] * twRe[t1];
         var s1r = oRe[i2] * twRe[t2] - oIm[i2] * twIm[t2], s1i = oRe[i2] * twIm[t2] + oIm[i2] * twRe[t2];
         var s2r = oRe[i3] * twRe[t3] - oIm[i3] * twIm[t3], s2i = oRe[i3] * twIm[t3] + oIm[i3] * twRe[t3];
         var f0r = oRe[i0], f0i = oIm[i0];
         var s5r = f0r - s1r, s5i = f0i - s1i;
         f0r += s1r; f0i += s1i;
         var s3r = s0r + s2r, s3i = s0i + s2i;
         var s4r = s0r - s2r, s4i = s0i - s2i;
         oRe[i2] = f0r - s3r; oIm[i2] = f0i - s3i;
         oRe[i0] = f0r + s3r; oIm[i0] = f0i + s3i;
         oRe[i1] = s5r + s4i; oIm[i1] = s5i - s4r;
         oRe[i3] = s5r - s4i; oIm[i3] = s5i + s4r;
      }
   }
   else
   {
      var n = this.n, scRe = this.scRe, scIm = this.scIm, u, q1, q, kk, twidx;
      for (u = 0; u < m; ++u)
      {
         kk = oo + u;
         for (q1 = 0; q1 < p; ++q1) { scRe[q1] = oRe[kk]; scIm[q1] = oIm[kk]; kk += m; }
         kk = oo + u;
         var kidx = u;                     // logical output index inside this block
         for (q1 = 0; q1 < p; ++q1)
         {
            twidx = 0;
            var accR = scRe[0], accI = scIm[0];
            for (q = 1; q < p; ++q)
            {
               twidx += fstride * kidx;
               if (twidx >= n) twidx -= n;
               accR += scRe[q] * twRe[twidx] - scIm[q] * twIm[twidx];
               accI += scRe[q] * twIm[twidx] + scIm[q] * twRe[twidx];
            }
            oRe[kk] = accR; oIm[kk] = accI;
            kk += m; kidx += m;
         }
      }
   }
};

var FD_planCache = {};
function FD_plan(n)
{
   if (!FD_planCache[n]) FD_planCache[n] = new FD_FFTPlan(n);
   return FD_planCache[n];
}

// ---------------------------------------------------------------------
// Real 2-D FFT to half spectrum.  Storage: index = kx*H + ky,
// kx in [0, W/2], ky in [0, H).  Two real rows packed per complex FFT.
// ---------------------------------------------------------------------
function FD_forward2D(data, W, H, progress)
{
   var Wh = Math.floor(W / 2) + 1;
   var Sre = new Float64Array(Wh * H), Sim = new Float64Array(Wh * H);
   var pW = FD_plan(W), pH = FD_plan(H);
   var n = Math.max(W, H);
   var bRe = new Float64Array(n), bIm = new Float64Array(n);
   var oRe = new Float64Array(n), oIm = new Float64Array(n);
   var x, y, k;
   for (y = 0; y < H; y += 2)
   {
      var two = (y + 1 < H), r1 = y * W, r2 = r1 + W;
      for (x = 0; x < W; ++x)
      {
         bRe[x] = data[r1 + x];
         bIm[x] = two ? data[r2 + x] : 0;
      }
      pW.transform(bRe, bIm, oRe, oIm);
      for (k = 0; k < Wh; ++k)
      {
         var nk = (k == 0) ? 0 : W - k;
         var zr = oRe[k], zi = oIm[k], cr = oRe[nk], ci = -oIm[nk];
         var idx = k * H + y;
         Sre[idx] = 0.5 * (zr + cr); Sim[idx] = 0.5 * (zi + ci);
         if (two)
         {
            Sre[idx + 1] = 0.5 * (zi - ci);
            Sim[idx + 1] = -0.5 * (zr - cr);
         }
      }
      if (progress && (y & 511) == 0) progress("FFT rows", y / H);
   }
   for (k = 0; k < Wh; ++k)
   {
      var base = k * H;
      for (y = 0; y < H; ++y) { bRe[y] = Sre[base + y]; bIm[y] = Sim[base + y]; }
      pH.transform(bRe, bIm, oRe, oIm);
      for (y = 0; y < H; ++y) { Sre[base + y] = oRe[y]; Sim[base + y] = oIm[y]; }
      if (progress && (k & 511) == 0) progress("FFT columns", k / Wh);
   }
   return { re: Sre, im: Sim, Wh: Wh };
}

// Inverse of FD_forward2D (destroys S). Returns Float32Array W*H.
function FD_inverse2D(S, W, H, progress)
{
   var Wh = S.Wh, Sre = S.re, Sim = S.im;
   var pW = FD_plan(W), pH = FD_plan(H);
   var n = Math.max(W, H);
   var bRe = new Float64Array(n), bIm = new Float64Array(n);
   var oRe = new Float64Array(n), oIm = new Float64Array(n);
   var x, y, k;
   for (k = 0; k < Wh; ++k)
   {
      var base = k * H;
      for (y = 0; y < H; ++y) { bRe[y] = Sre[base + y]; bIm[y] = -Sim[base + y]; }
      pH.transform(bRe, bIm, oRe, oIm);
      for (y = 0; y < H; ++y) { Sre[base + y] = oRe[y]; Sim[base + y] = -oIm[y]; }
      if (progress && (k & 511) == 0) progress("IFFT columns", k / Wh);
   }
   var out = new Float32Array(W * H), norm = 1 / (W * H);
   for (y = 0; y < H; y += 2)
   {
      var two = (y + 1 < H);
      for (k = 0; k < Wh; ++k)
      {
         var i1 = k * H + y;
         var x1r = Sre[i1], x1i = Sim[i1];
         var x2r = two ? Sre[i1 + 1] : 0, x2i = two ? Sim[i1 + 1] : 0;
         // Z = X1 + i X2, conjugated for inverse-via-forward
         bRe[k] = x1r - x2i; bIm[k] = -(x1i + x2r);
      }
      for (k = Wh; k < W; ++k)
      {
         var j = W - k, i2 = j * H + y;
         var a1r = Sre[i2], a1i = Sim[i2];
         var a2r = two ? Sre[i2 + 1] : 0, a2i = two ? Sim[i2 + 1] : 0;
         bRe[k] = a1r + a2i; bIm[k] = -(-a1i + a2r);
      }
      pW.transform(bRe, bIm, oRe, oIm);
      var r1 = y * W, r2 = r1 + W;
      for (x = 0; x < W; ++x)
      {
         out[r1 + x] = oRe[x] * norm;
         if (two) out[r2 + x] = -oIm[x] * norm;
      }
      if (progress && (y & 511) == 0) progress("IFFT rows", y / H);
   }
   return out;
}

// ---------------------------------------------------------------------
// Moisan periodic + smooth decomposition, done in the Fourier domain:
// subtracts S_hat (smooth part) from U_hat so the edge-discontinuity
// cross disappears from the spectrum axes (exactly where the banding
// notches act).  Reference: L. Moisan, "Periodic plus smooth image
// decomposition", J. Math. Imaging Vis. 39 (2011) 161-179.
// ---------------------------------------------------------------------
function FD_periodicPart(S, data, W, H)
{
   var Wh = S.Wh, x, y, q, r;
   var aRe = new Float64Array(H), aIm = new Float64Array(H);
   var ARe = new Float64Array(H), AIm = new Float64Array(H);
   for (y = 0; y < H; ++y) aRe[y] = data[y * W + W - 1] - data[y * W];
   FD_plan(H).transform(aRe, aIm, ARe, AIm);
   var bRe = new Float64Array(W), bIm = new Float64Array(W);
   var BRe = new Float64Array(W), BIm = new Float64Array(W);
   for (x = 0; x < W; ++x) bRe[x] = data[(H - 1) * W + x] - data[x];
   FD_plan(W).transform(bRe, bIm, BRe, BIm);
   var cyR = new Float64Array(H), cyI = new Float64Array(H), cosy = new Float64Array(H);
   for (r = 0; r < H; ++r)
   {
      var ay = 2 * Math.PI * r / H;
      cyR[r] = 1 - Math.cos(ay); cyI[r] = -Math.sin(ay);   // 1 - e^{i ay}
      cosy[r] = 2 * Math.cos(ay);
   }
   for (q = 0; q < Wh; ++q)
   {
      var ax = 2 * Math.PI * q / W;
      var cxR = 1 - Math.cos(ax), cxI = -Math.sin(ax);
      var cosx = 2 * Math.cos(ax), bqR = BRe[q], bqI = BIm[q], base = q * H;
      for (r = 0; r < H; ++r)
      {
         if (q == 0 && r == 0) continue;
         var vr = ARe[r] * cxR - AIm[r] * cxI + bqR * cyR[r] - bqI * cyI[r];
         var vi = ARe[r] * cxI + AIm[r] * cxR + bqR * cyI[r] + bqI * cyR[r];
         var den = cosx + cosy[r] - 4;
         S.re[base + r] -= vr / den;
         S.im[base + r] -= vi / den;
      }
   }
}

// ---------------------------------------------------------------------
// Robust helpers
// ---------------------------------------------------------------------
function FD_select(a, n, k)
{
   // quickselect on first n entries of a (modified)
   var l = 0, r = n - 1;
   while (r > l)
   {
      var pv = a[(l + r) >> 1], i = l, j = r;
      do
      {
         while (a[i] < pv) ++i;
         while (pv < a[j]) --j;
         if (i <= j) { var t = a[i]; a[i] = a[j]; a[j] = t; ++i; --j; }
      }
      while (i <= j);
      if (j < k) l = i;
      if (k < i) r = j;
   }
   return a[k];
}
function FD_median(a, n) { return FD_select(a, n, n >> 1); }

// Large-scale background by block medians + bilinear interpolation.
// get(ix, iy) returns sample; returns {bg: function(ix,iy), grid...}
function FD_blockBackground(get, nx, ny, B, step)
{
   var gw = Math.ceil(nx / B), gh = Math.ceil(ny / B);
   var grid = new Float64Array(gw * gh), buf = new Float64Array(B * B), i, j;
   for (j = 0; j < gh; ++j)
      for (i = 0; i < gw; ++i)
      {
         var n = 0, x0 = i * B, y0 = j * B;
         var x1 = Math.min(nx, x0 + B), y1 = Math.min(ny, y0 + B);
         for (var y = y0; y < y1; y += step)
            for (var x = x0; x < x1; x += step)
            {
               var gv = get(x, y);
               if (gv === gv) buf[n++] = gv;           // NaN = masked sample
            }
         grid[j * gw + i] = n >= 8 ? FD_median(buf, n) : NaN;
      }
   // blocks with too few unmasked samples: fill from valid neighbours (outward)
   for (var pass = 0; pass < gw + gh; ++pass)
   {
      var holes = 0, nxt = new Float64Array(grid);      // copy (TypedArray.slice is ES2015)
      for (j = 0; j < gh; ++j)
         for (i = 0; i < gw; ++i)
         {
            if (grid[j * gw + i] === grid[j * gw + i]) continue;
            var sm = 0, cnt = 0;
            for (var dj = -1; dj <= 1; ++dj)
               for (var di = -1; di <= 1; ++di)
               {
                  var ii = i + di, jj = j + dj;
                  if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
                  var q = grid[jj * gw + ii];
                  if (q === q) { sm += q; ++cnt; }
               }
            if (cnt > 0) nxt[j * gw + i] = sm / cnt; else ++holes;
         }
      grid = nxt;
      if (holes == 0) break;
   }
   for (i = 0; i < grid.length; ++i) if (grid[i] !== grid[i]) grid[i] = 0;
   var f = function(x, y)
   {
      var fx = (x + 0.5) / B - 0.5, fy = (y + 0.5) / B - 0.5;
      if (fx < 0) fx = 0; if (fx > gw - 1) fx = gw - 1;
      if (fy < 0) fy = 0; if (fy > gh - 1) fy = gh - 1;
      var ix = Math.floor(fx), iy = Math.floor(fy);
      var ix1 = Math.min(ix + 1, gw - 1), iy1 = Math.min(iy + 1, gh - 1);
      var tx = fx - ix, ty = fy - iy;
      var a = grid[iy * gw + ix], b = grid[iy * gw + ix1];
      var c = grid[iy1 * gw + ix], d = grid[iy1 * gw + ix1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
   };
   // Fast dense evaluation. rowOf(y) maps output row y to a grid-space row;
   // dstIndex(x, y) gives the destination index.
   f.fill = function(dst, rowOf, dstIndex)
   {
      var ix0 = new Int32Array(nx), ix1 = new Int32Array(nx), txs = new Float64Array(nx), line = new Float64Array(gw), x, y, k;
      for (x = 0; x < nx; ++x)
      {
         var fx = (x + 0.5) / B - 0.5;
         if (fx < 0) fx = 0; if (fx > gw - 1) fx = gw - 1;
         ix0[x] = Math.floor(fx); ix1[x] = Math.min(ix0[x] + 1, gw - 1); txs[x] = fx - ix0[x];
      }
      for (y = 0; y < ny; ++y)
      {
         var gy = rowOf(y), fy = (gy + 0.5) / B - 0.5;
         if (fy < 0) fy = 0; if (fy > gh - 1) fy = gh - 1;
         var iy = Math.floor(fy), iy1 = Math.min(iy + 1, gh - 1), ty = fy - iy;
         for (k = 0; k < gw; ++k) line[k] = grid[iy * gw + k] * (1 - ty) + grid[iy1 * gw + k] * ty;
         for (x = 0; x < nx; ++x)
            dst[dstIndex(x, y)] = line[ix0[x]] * (1 - txs[x]) + line[ix1[x]] * txs[x];
      }
   };
   return f;
}

// ---------------------------------------------------------------------
// Separable helpers for the protection mask
// ---------------------------------------------------------------------
function FD_boxBlur(src, dst, W, H, r)
{
   // (2r+1)^2 box mean, edge-clamped, two running-sum passes; tmp row/col buffers
   var x, y, k, n = 2 * r + 1, line = new Float64Array(Math.max(W, H) + 2 * r);
   var tmp = new Float32Array(W * H);
   for (y = 0; y < H; ++y)
   {
      var o = y * W;
      for (k = 0; k < W + 2 * r; ++k) { var xx = k - r; xx = xx < 0 ? 0 : (xx >= W ? W - 1 : xx); line[k] = src[o + xx]; }
      var acc = 0;
      for (k = 0; k < n; ++k) acc += line[k];
      for (x = 0; x < W; ++x) { tmp[o + x] = acc / n; acc += line[x + n] - line[x]; }
   }
   for (x = 0; x < W; ++x)
   {
      for (k = 0; k < H + 2 * r; ++k) { var yy = k - r; yy = yy < 0 ? 0 : (yy >= H ? H - 1 : yy); line[k] = tmp[yy * W + x]; }
      var acc2 = 0;
      for (k = 0; k < n; ++k) acc2 += line[k];
      for (y = 0; y < H; ++y) { dst[y * W + x] = acc2 / n; acc2 += line[y + n] - line[y]; }
   }
}

function FD_dilate(mask, W, H, r)
{
   // square dilation by r px (separable, run-length counting)
   if (r < 1) return;
   var x, y, cnt, tmp = new Uint8Array(W * H);
   for (y = 0; y < H; ++y)
   {
      var o = y * W; cnt = 0;
      for (x = 0; x < Math.min(r, W); ++x) cnt += mask[o + x];
      for (x = 0; x < W; ++x)
      {
         if (x + r < W) cnt += mask[o + x + r];
         if (x - r - 1 >= 0) cnt -= mask[o + x - r - 1];
         tmp[o + x] = cnt > 0 ? 1 : 0;
      }
   }
   for (x = 0; x < W; ++x)
   {
      cnt = 0;
      for (y = 0; y < Math.min(r, H); ++y) cnt += tmp[y * W + x];
      for (y = 0; y < H; ++y)
      {
         if (y + r < H) cnt += tmp[(y + r) * W + x];
         if (y - r - 1 >= 0) cnt -= tmp[(y - r - 1) * W + x];
         mask[y * W + x] = cnt > 0 ? 1 : 0;
      }
   }
}

// Subtract the HIGH-PASSED part of robust row and column medians (over unmasked
// pixels).  Only the band-like component is removed: a smooth bias (halo tail,
// gradient) in the medians must not be pushed back into whole rows/columns.
function FD_hpOffsets(med, n, half)
{
   var out = new Float64Array(n), buf = new Float64Array(2 * half + 1), i, k, m;
   for (i = 0; i < n; ++i)
   {
      if (med[i] !== med[i]) { out[i] = 0; continue; }
      m = 0;
      for (k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); ++k) if (med[k] === med[k]) buf[m++] = med[k];
      out[i] = med[i] - FD_median(buf, m);
   }
   return out;
}

function FD_removeRowColMedians(a, mask, W, H)
{
   var x, y, n, buf = new Float64Array(Math.max(W, H)), sx = Math.max(1, Math.floor(W / 2000)), sy = Math.max(1, Math.floor(H / 2000));
   // No minimum unmasked fraction: only the high-passed (band-like) part of the
   // medians is removed, so a smooth bias from masked halos cannot leak in, and a
   // heavily masked row MUST still have its band removed, otherwise the band stays
   // in the residual and the hysteresis mask grows along the whole row (1.3 bug).
   var rm = new Float64Array(H), cm = new Float64Array(W), need = 16;
   for (y = 0; y < H; ++y)
   {
      var o = y * W; n = 0;
      for (x = 0; x < W; x += sx) if (!mask || !mask[o + x]) buf[n++] = a[o + x];
      rm[y] = n >= need ? FD_median(buf, n) : NaN;
   }
   rm = FD_hpOffsets(rm, H, 32);
   for (y = 0; y < H; ++y) { var o2 = y * W, r = rm[y]; if (r) for (x = 0; x < W; ++x) a[o2 + x] -= r; }
   for (x = 0; x < W; ++x)
   {
      n = 0;
      for (y = 0; y < H; y += sy) if (!mask || !mask[y * W + x]) buf[n++] = a[y * W + x];
      cm[x] = n >= need ? FD_median(buf, n) : NaN;
   }
   cm = FD_hpOffsets(cm, W, 32);
   for (x = 0; x < W; ++x) { var c = cm[x]; if (c) for (y = 0; y < H; ++y) a[y * W + x] -= c; }
}

// Per-pixel noise sigma from horizontal first differences (insensitive to smooth structure and row bands).
function FD_diffSigma(d, W, H)
{
   var n = Math.min(400000, (W - 1) * H), st = Math.max(1, Math.floor((W - 1) * H / n)), buf = new Float64Array(n + 1), k = 0, i;
   for (i = 0; i < W * H - 1 && k < n; i += st) if ((i + 1) % W) buf[k++] = d[i + 1] - d[i];
   var m = FD_median(buf, k);
   for (i = 0; i < k; ++i) buf[i] = Math.abs(buf[i] - m);
   return 1.4826 * FD_median(buf, k) / Math.SQRT2;
}

function FD_robustSigma(a, mask, N)
{
   var ns = Math.min(N, 400000), stride = Math.max(1, Math.floor(N / ns));
   var rs = new Float64Array(Math.ceil(N / stride) + 1), nr = 0, i;
   for (i = 0; i < N; i += stride) if (!mask || !mask[i]) rs[nr++] = a[i];
   if (nr < 100) for (nr = 0, i = 0; i < N; i += stride) rs[nr++] = a[i];
   var med = FD_median(rs, nr);
   for (i = 0; i < nr; ++i) rs[i] = Math.abs(rs[i] - med);
   return { med: med, sigma: 1.4826 * FD_median(rs, nr) };
}

// ---------------------------------------------------------------------
// Protection mask.  Stars, their halos, diffraction spikes, bleed columns,
// compact bright nebulae and dark defects: anything localized that would
// otherwise leak into the row/column means the band notches estimate.
//  1. background: 64-px block medians of UNMASKED pixels, iterated 3x, so
//     a bright star (saturated or not) cannot drag it up with it;
//  2. seeds: 5x5-smoothed |residual| > detectK * sigma_s, plus saturated pixels;
//  3. hysteresis growth over smoothed |residual| > maskLow * sigma_s
//     (follows a halo down to the noise floor);
//  4. square dilation by maskGrow px.
// ---------------------------------------------------------------------
function FD_buildMask(data, W, H, P, log)
{
   var N = W * H, i, x, y, it;
   var mask = new Uint8Array(N), bg = new Float32Array(N), res = new Float32Array(N), sm = new Float32Array(N);
   var B = 64, st, sigS = 0;
   // saturation level: the data maximum, if a meaningful number of pixels sit there
   var vmax = 0, nsat = 0;
   for (i = 0; i < N; ++i) if (data[i] > vmax) vmax = data[i];
   var satLevel = vmax * (1 - 1e-4);
   for (i = 0; i < N; ++i) if (data[i] >= satLevel) ++nsat;
   var useSat = nsat >= 9 && vmax > 0;
   if (useSat) log("  " + nsat + " saturated pixels (>= " + satLevel.toPrecision(5) + ") always protected");
   for (it = 0; it < 3; ++it)
   {
      var bgf = FD_blockBackground(function(x, y) { var j = y * W + x; return mask[j] ? NaN : data[j]; }, W, H, B, 4);
      bgf.fill(bg, function(y) { return y; }, function(x, y) { return y * W + x; });
      for (i = 0; i < N; ++i) res[i] = data[i] - bg[i];
      FD_removeRowColMedians(res, it > 0 ? mask : null, W, H);   // banding must not be "structure"
      FD_boxBlur(res, sm, W, H, 2);
      st = FD_robustSigma(sm, it > 0 ? mask : null, N);
      sigS = st.sigma;
      var hi = P.detectK * sigS, lo = P.maskLow * sigS, m0 = st.med;
      // seeds
      for (i = 0; i < N; ++i) { var d = sm[i] - m0; mask[i] = (d > hi || d < -hi || (useSat && data[i] >= satLevel)) ? 1 : 0; }
      // hysteresis: flood fill from the seeds through 4-connected pixels whose
      // smoothed |residual| exceeds the halo threshold (cost ~ masked pixels)
      var cap = 1 << 20, stack = new Int32Array(cap), sp = 0;
      for (i = 0; i < N; ++i)
         if (mask[i])
         {
            if (sp == cap) { var ns2 = new Int32Array(cap *= 2); ns2.set(stack); stack = ns2; }
            stack[sp++] = i;
         }
      while (sp > 0)
      {
         var j0 = stack[--sp], x0 = j0 % W;
         for (var nbk = 0; nbk < 4; ++nbk)
         {
            var j;
            if (nbk == 0) { if (x0 == 0) continue; j = j0 - 1; }
            else if (nbk == 1) { if (x0 == W - 1) continue; j = j0 + 1; }
            else if (nbk == 2) { if (j0 < W) continue; j = j0 - W; }
            else { j = j0 + W; if (j >= N) continue; }
            if (mask[j]) continue;
            var dd = sm[j] - m0;
            if (dd <= lo && dd >= -lo && !(useSat && data[j] >= satLevel)) continue;
            mask[j] = 1;
            if (sp == cap) { var ns3 = new Int32Array(cap *= 2); ns3.set(stack); stack = ns3; }
            stack[sp++] = j;
         }
      }
      stack = null;
      FD_dilate(mask, W, H, Math.round(P.maskGrow));
   }
   // smooth the background used as FILL: bilinear block interpolation has kinks
   // along every block row/column, which the band notches would read as bands
   var tmpb = new Float32Array(N);
   FD_boxBlur(bg, tmpb, W, H, B >> 1);
   FD_boxBlur(tmpb, bg, W, H, B >> 1);
   tmpb = null;
   var sig = FD_robustSigma(res, mask, N);
   var cnt = 0;
   for (i = 0; i < N; ++i) cnt += mask[i];
   res = null; sm = null;
   log("  noise sigma = " + sig.sigma.toExponential(3) + ", protection mask covers " + (100 * cnt / N).toFixed(2) + "% of pixels");
   return { mask: mask, bg: bg, sigma: sig.sigma, frac: cnt / N };
}

// ---------------------------------------------------------------------
// Fourier noise model of one estimation image (steps 2-5).
// Returns { noise, diag, spikes }
// ---------------------------------------------------------------------
function FD_noiseModel(est, W, H, P, progress, wantDiag, wantComps)
{
   var N = W * H, i, x, y;
   var log = progress ? function(s) { progress(s, -1); } : function() {};
   // ---- 2. Spectrum of the periodic component
   var S = FD_forward2D(est, W, H, progress);
   FD_periodicPart(S, est, W, H);
   var Wh = S.Wh, M = Wh * H, Sre = S.re, Sim = S.im;
   var halfH = Math.floor(H / 2);

   // frequency helpers
   var f0 = 1 / Math.max(2, P.protectScale);
   function ramp(f) { f = Math.abs(f); if (f <= f0) return 0; if (f >= 2 * f0) return 1; return 0.5 - 0.5 * Math.cos(Math.PI * (f - f0) / f0); }
   var rampY = new Float32Array(H), gaussY = new Float32Array(H), nyqY = new Float32Array(H), kyc = new Int32Array(H);
   var sl = P.lineSigma, sn = P.nyquistSigma;
   for (y = 0; y < H; ++y)
   {
      var c = (y <= halfH) ? y : y - H;
      kyc[y] = c;
      rampY[y] = ramp(c / H);
      gaussY[y] = Math.exp(-c * c / (2 * sl * sl));
      var d = H / 2 - Math.abs(c);
      nyqY[y] = Math.exp(-d * d / (2 * sn * sn));
   }

   // ---- 3. Periodic spike detection (log magnitude vs local robust bg)
   var spikeGain = null, nSpikes = 0;
   var L = null;
   if (P.spikes || wantDiag)
   {
      log("Log-magnitude spectrum");
      L = new Float32Array(M);
      for (i = 0; i < M; ++i) L[i] = 0.5 * Math.log(Sre[i] * Sre[i] + Sim[i] * Sim[i] + 1e-30);
   }
   var excl = 2 * f0;
   function excluded(kx, ky)
   {
      var c = kyc[ky];
      if (kx <= 1 || c <= 1 && c >= -1) return true;         // axes (banding territory)
      var fx = kx / W, fy = c / H;
      return fx * fx + fy * fy < excl * excl;
   }
   if (P.spikes)
   {
      log("Periodic spike detection");
      // centered-ky accessor for block background
      var Lget = function(kx, cy) { var ky = (cy - halfH + H) % H; return L[kx * H + ky]; };
      var bgL = FD_blockBackground(Lget, Wh, H, 16, 1);
      // robust sigma of (L - bg) outside exclusions
      var smp = new Float64Array(300000), ns2 = 0;
      var st = Math.max(1, Math.floor(M / 300000));
      for (i = 0; i < M && ns2 < 300000; i += st)
      {
         var kx = Math.floor(i / H), ky = i - kx * H;
         if (excluded(kx, ky)) continue;
         smp[ns2++] = L[i] - bgL(kx, (ky + halfH) % H);
      }
      var m0 = FD_median(smp, ns2);
      for (i = 0; i < ns2; ++i) smp[i] = Math.abs(smp[i] - m0);
      var sL = 1.4826 * FD_median(smp, ns2);
      log("  log-spectrum robust sigma = " + sL.toFixed(3));
      spikeGain = new Float32Array(M);
      for (i = 0; i < M; ++i) spikeGain[i] = 1;
      var bgArr = new Float32Array(M);
      // grid axes are (kx, centered cy); here the output "row" is ky
      bgL.fill(bgArr, function(ky) { return (ky + halfH) % H; }, function(kx, ky) { return kx * H + ky; });
      for (i = 0; i < M; ++i) bgArr[i] += m0;
      var thr = P.spikeK * sL, dl = Math.round(P.spikeDilate), hits = [];
      for (kx = 0; kx < Wh; ++kx)
         for (ky = 0; ky < H; ++ky)
         {
            i = kx * H + ky;
            if (excluded(kx, ky)) continue;
            if (L[i] - bgArr[i] > thr) hits.push(i);
         }
      nSpikes = hits.length;
      for (var h = 0; h < hits.length; ++h)
      {
         var hx = Math.floor(hits[h] / H), hy = hits[h] - hx * H;
         for (var dy = -dl; dy <= dl; ++dy)
            for (var dx = -dl; dx <= dl; ++dx)
            {
               var qx = hx + dx, qy = hy + dy;
               if (qx < 0) { qx = -qx; qy = -qy; }            // Hermitian mirror
               if (qx >= Wh) continue;
               qy = ((qy % H) + H) % H;
               if (excluded(qx, qy)) continue;
               var j = qx * H + qy, e = L[j] - bgArr[j];
               if (e > 0)
               {
                  var g = Math.exp(-e);
                  if (g < spikeGain[j]) spikeGain[j] = g;
               }
            }
      }
      bgArr = null;
      // Hermitian consistency on self-conjugate columns (kx=0, kx=W/2)
      var selfCols = [0];
      if (W % 2 == 0) selfCols.push(Wh - 1);
      for (var sc = 0; sc < selfCols.length; ++sc)
      {
         var b0 = selfCols[sc] * H;
         for (ky = 1; ky < H; ++ky)
         {
            var jj = H - ky, g2 = Math.min(spikeGain[b0 + ky], spikeGain[b0 + jj]);
            spikeGain[b0 + ky] = spikeGain[b0 + jj] = g2;
         }
      }
      log("  " + nSpikes + " spectral spike bins above " + P.spikeK + " sigma");
   }

   // ---- 4. Build total gain, form noise spectrum = (1-G) * P_hat
   var s = P.strength;
   var gainOut = wantDiag ? new Float32Array(M) : null;
   // for adaptive amplitude matching: keep the periodic spectrum (float32) to synthesize the
   // row-band and column-band components separately after the total model
   var keepRe = wantComps ? new Float32Array(M) : null, keepIm = wantComps ? new Float32Array(M) : null;
   if (wantComps) for (i = 0; i < M; ++i) { keepRe[i] = Sre[i]; keepIm[i] = Sim[i]; }
   for (kx = 0; kx < Wh; ++kx)
   {
      var gx = Math.exp(-kx * kx / (2 * sl * sl));
      var rx = ramp(kx / W);
      var dnx = W / 2 - kx, nyx = Math.exp(-dnx * dnx / (2 * sn * sn));
      var base = kx * H;
      for (ky = 0; ky < H; ++ky)
      {
         var G = 1;
         if (P.horizontal) G *= 1 - s * gx * rampY[ky];      // row offsets -> fx ~ 0
         if (P.vertical)   G *= 1 - s * gaussY[ky] * rx;     // column offsets -> fy ~ 0
         if (P.nyquist)    G *= 1 - s * (1 - (1 - nyx) * (1 - nyqY[ky]));
         if (spikeGain)    G *= 1 - s * (1 - spikeGain[base + ky]);
         if (kx == 0 && ky == 0) G = 1;                       // never touch DC
         var idx = base + ky, rem = 1 - G;
         Sre[idx] *= rem; Sim[idx] *= rem;
         if (gainOut) gainOut[idx] = G;
      }
   }
   spikeGain = null;

   // ---- 5. Diagnostic spectrum image (centered, log |P|, removed part in red)
   var diag = null;
   if (wantDiag)
   {
      log("Building spectrum diagnostic");
      var smpD = new Float64Array(200000), nd = 0, sd = Math.max(1, Math.floor(M / 200000)), Lmax = -1e30;
      for (i = 0; i < M; ++i) if (L[i] > Lmax && i != 0) Lmax = L[i];
      for (i = 1; i < M && nd < 200000; i += sd) smpD[nd++] = L[i];
      var Llo = FD_median(smpD, nd) - 1.0;
      var span = Math.max(1e-6, Lmax - Llo);
      var dR = new Float32Array(N), dG = new Float32Array(N);
      var cx = Math.floor(W / 2), cyy = Math.floor(H / 2);
      for (y = 0; y < H; ++y)
         for (x = 0; x < W; ++x)
         {
            var kxs = x - cx, kys = y - cyy;
            if (kxs < 0) { kxs = -kxs; kys = -kys; }
            if (kxs >= Wh) kxs = Wh - 1;
            var idd = kxs * H + ((kys % H) + H) % H;
            var v = (L[idd] - Llo) / span; if (v < 0) v = 0; if (v > 1) v = 1;
            var o = y * W + x;
            dR[o] = v; dG[o] = v * gainOut[idd];
         }
      diag = { r: dR, g: dG };
      gainOut = null;
   }
   L = null;

   var noise = FD_inverse2D(S, W, H, progress);
   var comps = null;
   if (wantComps)
   {
      // n_h = F^-1{ s A_h p^ },  n_v = F^-1{ s A_v p^ }; the rest (spikes, Nyquist, cross terms) is
      // n - n_h - n_v and is subtracted with unit gain
      comps = {};
      var which = [];
      if (P.horizontal) which.push("h");
      if (P.vertical) which.push("v");
      for (var c2 = 0; c2 < which.length; ++c2)
      {
         log("Band component " + (which[c2] == "h" ? "rows" : "columns"));
         for (kx = 0; kx < Wh; ++kx)
         {
            var gx2 = Math.exp(-kx * kx / (2 * sl * sl)), rx2 = ramp(kx / W), base2 = kx * H;
            for (ky = 0; ky < H; ++ky)
            {
               var A = (which[c2] == "h") ? s * gx2 * rampY[ky] : s * gaussY[ky] * rx2;
               if (kx == 0 && ky == 0) A = 0;
               Sre[base2 + ky] = keepRe[base2 + ky] * A;
               Sim[base2 + ky] = keepIm[base2 + ky] * A;
            }
         }
         comps[which[c2]] = FD_inverse2D(S, W, H, progress);
      }
      keepRe = keepIm = null;
   }
   S = null;
   return { noise: noise, diag: diag, spikes: nSpikes, comps: comps };
}

// ---------------------------------------------------------------------
// Adaptive amplitude matching.  For each band component c (rows, columns) a smoothly
// varying gain a_c(x,y) is fitted by windowed least squares over the UNMASKED pixels:
//    y = d - b~  ~  offset + sum_c a_c n_c        (offset = nuisance, never subtracted)
// with a Gaussian prior a_c ~ N(1, tau^2) (posterior mean): a window with little band
// energy keeps a ~ 1, a window with strong bands follows the data.  Gains are clamped
// to [0, 2] and smoothed.  Computed on a grid of Bk x Bk blocks (memory ~ N / Bk^2).
// Returns { h: Float32Array|null, v: Float32Array|null, stats }  (per-pixel gains)
// ---------------------------------------------------------------------
function FD_adaptiveGains(d, bg, mask, comps, W, H, halfWin, sigma, tau, log)
{
   var Bk = 8, gw = Math.ceil(W / Bk), gh = Math.ceil(H / Bk), G2 = gw * gh, x, y, i, j;
   var nh = comps.h || null, nv = comps.v || null;
   // per-block sums: w, h, v, y, hh, vv, hv, hy, vy
   var K = 9, sums = [];
   for (i = 0; i < K; ++i) sums.push(new Float64Array(G2));
   for (y = 0; y < H; ++y)
   {
      var by = (y / Bk) | 0, o = y * W;
      for (x = 0; x < W; ++x)
      {
         var p = o + x;
         if (mask && mask[p]) continue;
         var b = by * gw + ((x / Bk) | 0), yy = d[p] - (bg ? bg[p] : 0), hh = nh ? nh[p] : 0, vv = nv ? nv[p] : 0;
         sums[0][b] += 1; sums[1][b] += hh; sums[2][b] += vv; sums[3][b] += yy;
         sums[4][b] += hh * hh; sums[5][b] += vv * vv; sums[6][b] += hh * vv; sums[7][b] += hh * yy; sums[8][b] += vv * yy;
      }
   }
   // window sums over (2 rb + 1)^2 blocks: separable running sums
   var rb = Math.max(1, Math.round(halfWin / Bk));
   function boxGrid(a)
   {
      var t = new Float64Array(G2), out = new Float64Array(G2), xx, yy2, acc;
      for (yy2 = 0; yy2 < gh; ++yy2)
      {
         acc = 0;
         for (xx = -rb; xx < gw + rb; ++xx)
         {
            if (xx + rb < gw && xx + rb >= 0) acc += a[yy2 * gw + xx + rb];
            if (xx - rb - 1 >= 0 && xx - rb - 1 < gw) acc -= a[yy2 * gw + xx - rb - 1];
            if (xx >= 0 && xx < gw) t[yy2 * gw + xx] = acc;
         }
      }
      for (xx = 0; xx < gw; ++xx)
      {
         acc = 0;
         for (yy2 = -rb; yy2 < gh + rb; ++yy2)
         {
            if (yy2 + rb < gh && yy2 + rb >= 0) acc += t[(yy2 + rb) * gw + xx];
            if (yy2 - rb - 1 >= 0 && yy2 - rb - 1 < gh) acc -= t[(yy2 - rb - 1) * gw + xx];
            if (yy2 >= 0 && yy2 < gh) out[yy2 * gw + xx] = acc;
         }
      }
      return out;
   }
   for (i = 0; i < K; ++i) sums[i] = boxGrid(sums[i]);
   var full = (2 * rb + 1) * (2 * rb + 1) * Bk * Bk, s2 = sigma * sigma, t2 = tau * tau;
   var ah = new Float64Array(G2), av = new Float64Array(G2);
   for (j = 0; j < G2; ++j)
   {
      var n = sums[0][j];
      ah[j] = av[j] = 1;
      if (n < 0.2 * full) continue;                     // window mostly masked: keep the model as is
      var mh = sums[1][j] / n, mv = sums[2][j] / n, my = sums[3][j] / n;
      var chh = sums[4][j] / n - mh * mh, cvv = sums[5][j] / n - mv * mv, chv = sums[6][j] / n - mh * mv;
      var chy = sums[7][j] / n - mh * my, cvy = sums[8][j] / n - mv * my;
      var q = s2 / (n * t2);                            // prior precision relative to the data term
      if (nh && nv)
      {
         var A11 = chh + q, A22 = cvv + q, det = A11 * A22 - chv * chv;
         if (Math.abs(det) > 1e-300) { ah[j] = ((chy + q) * A22 - (cvy + q) * chv) / det; av[j] = (A11 * (cvy + q) - chv * (chy + q)) / det; }
      }
      else if (nh) ah[j] = (chy + q) / (chh + q);
      else av[j] = (cvy + q) / (cvv + q);
      ah[j] = Math.min(2, Math.max(0, ah[j])); av[j] = Math.min(2, Math.max(0, av[j]));
   }
   // smooth the gain fields with the same window (normalized)
   var ones = new Float64Array(G2); for (j = 0; j < G2; ++j) ones[j] = 1;
   var nrm = boxGrid(ones), sh = boxGrid(ah), sv = boxGrid(av);
   for (j = 0; j < G2; ++j) { ah[j] = sh[j] / nrm[j]; av[j] = sv[j] / nrm[j]; }
   // statistics for the console
   function pct(a) { var c = new Float64Array(a); return [FD_select(c, G2, Math.floor(0.05 * (G2 - 1))), FD_select(c, G2, Math.floor(0.5 * (G2 - 1))), FD_select(c, G2, Math.floor(0.95 * (G2 - 1)))]; }
   var stats = { h: nh ? pct(ah) : null, v: nv ? pct(av) : null };
   // bilinear interpolation of the block grid to pixels
   function expand(g)
   {
      var out = new Float32Array(W * H), ix0 = new Int32Array(W), ix1 = new Int32Array(W), tx = new Float64Array(W), xx2;
      for (xx2 = 0; xx2 < W; ++xx2)
      {
         var fx = (xx2 + 0.5) / Bk - 0.5; if (fx < 0) fx = 0; if (fx > gw - 1) fx = gw - 1;
         ix0[xx2] = Math.floor(fx); ix1[xx2] = Math.min(ix0[xx2] + 1, gw - 1); tx[xx2] = fx - ix0[xx2];
      }
      for (var yy3 = 0; yy3 < H; ++yy3)
      {
         var fy = (yy3 + 0.5) / Bk - 0.5; if (fy < 0) fy = 0; if (fy > gh - 1) fy = gh - 1;
         var iy0 = Math.floor(fy), iy1 = Math.min(iy0 + 1, gh - 1), ty = fy - iy0, o3 = yy3 * W;
         for (xx2 = 0; xx2 < W; ++xx2)
         {
            var a0 = g[iy0 * gw + ix0[xx2]] * (1 - tx[xx2]) + g[iy0 * gw + ix1[xx2]] * tx[xx2];
            var a1 = g[iy1 * gw + ix0[xx2]] * (1 - tx[xx2]) + g[iy1 * gw + ix1[xx2]] * tx[xx2];
            out[o3 + xx2] = a0 * (1 - ty) + a1 * ty;
         }
      }
      return out;
   }
   return { h: nh ? expand(ah) : null, v: nv ? expand(av) : null, stats: stats };
}

// ---------------------------------------------------------------------
// Main processing of one channel.
// Returns { out, noise, diag, mask, spikes, rms }
// ---------------------------------------------------------------------
function FD_processChannel(data, W, H, P, progress)
{
   var N = W * H, i;
   var log = progress ? function(s) { progress(s, -1); } : function() {};
   var est = data, M = null;
   if (P.protectStars)
   {
      log("Protection mask");
      M = FD_buildMask(data, W, H, P, log);
      est = new Float32Array(N);
      for (i = 0; i < N; ++i) est[i] = M.mask[i] ? M.bg[i] : data[i];
   }
   // Masked pixels are filled with background + current band model and the
   // model re-estimated (POCS / Gerchberg-Papoulis).  The band estimate then
   // converges to the mean over UNMASKED pixels of each row/column; the bias
   // after n passes scales as (masked fraction of that row)^(n+1).
   var passes = 1 + (M ? Math.round(P.refine) : 0), R = null;
   var adapt = !!P.adaptive && (P.horizontal || P.vertical);
   for (var pass = 0; pass < passes; ++pass)
   {
      var last = (pass == passes - 1);
      if (passes > 1) log("Pass " + (pass + 1) + "/" + passes);
      R = FD_noiseModel(est, W, H, P, progress, last && P.wantDiag, last && adapt);
      if (!last)
         for (i = 0; i < N; ++i) if (M.mask[i]) est[i] = M.bg[i] + R.noise[i];
   }
   est = null;
   var noise = R.noise, gains = null;
   if (adapt)
   {
      log("Adaptive amplitude matching");
      var sig = M ? M.sigma : FD_diffSigma(data, W, H);
      gains = FD_adaptiveGains(data, M ? M.bg : null, M ? M.mask : null, R.comps, W, H, Math.round(P.adaptWindow / 2), sig, 0.1, log);
      var fmt3 = function(t) { return t ? "median " + t[1].toFixed(2) + " (5-95%: " + t[0].toFixed(2) + "-" + t[2].toFixed(2) + ")" : ""; };
      if (gains.h) log("  row-band gain " + fmt3(gains.stats.h));
      if (gains.v) log("  column-band gain " + fmt3(gains.stats.v));
      // n_adapted = n + (a_h - 1) n_h + (a_v - 1) n_v
      for (i = 0; i < N; ++i)
      {
         var dn = 0;
         if (gains.h) dn += (gains.h[i] - 1) * R.comps.h[i];
         if (gains.v) dn += (gains.v[i] - 1) * R.comps.v[i];
         noise[i] += dn;
      }
      R.comps = null;
   }
   var out = new Float32Array(N), ss = 0;
   for (i = 0; i < N; ++i)
   {
      var nv = noise[i], v2 = data[i] - nv;
      ss += nv * nv;
      out[i] = v2 < 0 ? 0 : (v2 > 1 ? 1 : v2);
   }
   return { out: out, noise: P.wantNoise ? noise : null, diag: R.diag,
            mask: (M && P.wantMask) ? M.mask : null, spikes: R.spikes, rms: Math.sqrt(ss / N),
            gains: (gains && P.wantGains) ? gains : null };
}
// ==== CORE END ====
return FD_processChannel;
}
var FD_processChannel = FDW_core();
// ============================================================================


// ============================================================================
// ==== WBPP STEP
// Runs inside WBPP: uses PixInsight objects and WBPP's engine.  No preprocessor:
// the constants of the pjsr include files do not exist here (WBPP uses DataType.Double,
// UndoFlag.NoSwapFile, ...).
// ============================================================================

// Settings written by the standalone Desat dialog
var STRW_SETTINGS = "BlackRig/SatelliteTrailRemover/v2/";   // old script name, kept: saved settings and caches carry over

// Processing defaults of Desat 3.0 (its STR_defaults)
var STRW_defaults = {
   blockSize: 64, halfWin: 4, tau: 0.1, clipSigma: 3.0, clipIter: 3, scaledPrior: true,
   satGuard: true, satLevel: 0.95, satGrow: 8,
   smoothRadius: 2, sigmaLow: 4.0, sigmaHigh: 8.0, structTol: 0.5, brightTol: 0.05,
   growRadius: 3, featherRadius: 2,
   detectEnable: true, detectZ: 15, blobMinLen: 300, blobMinAspect: 10,
   lineRemoval: true, alongWin: 64, restrictToTrails: true,
   wideTrails: true, wingMax: 120
};
var STRW_numKeys = [
   "blockSize", "halfWin", "tau", "clipSigma", "clipIter",
   "smoothRadius", "sigmaLow", "sigmaHigh", "structTol", "brightTol", "growRadius", "featherRadius",
   "detectZ", "blobMinLen", "blobMinAspect", "alongWin",
   "satLevel", "satGrow", "wingMax"
];
var STRW_boolKeys = ["scaledPrior", "satGuard", "detectEnable", "lineRemoval", "restrictToTrails", "wideTrails"];

var STRW_NAME = "Satellite trail removal";
var STRW_DIR  = "detrailed";
var STRW_REF  = "STR_reference.xisf";

function STRW_const(obj, name, fallback) {
   return (obj !== undefined && obj !== null && obj[name] !== undefined) ? obj[name] : fallback;
}

// Parameters: 3.0 defaults, overridden by the standalone script's saved settings
function STRW_loadParams() {
   var P = {}, k, i, v, nRead = 0;
   for (k in STRW_defaults) if (STRW_defaults.hasOwnProperty(k)) P[k] = STRW_defaults[k];
   var DT = (typeof DataType !== "undefined") ? DataType : null;
   var tD = STRW_const(DT, "Double", 10), tB = STRW_const(DT, "Boolean", 0);
   for (i = 0; i < STRW_numKeys.length; i++) {
      v = Settings.read(STRW_SETTINGS + STRW_numKeys[i], tD);
      if (Settings.lastReadOK && v !== null && v === v) { P[STRW_numKeys[i]] = v; nRead++; }
   }
   for (i = 0; i < STRW_boolKeys.length; i++) {
      v = Settings.read(STRW_SETTINGS + STRW_boolKeys[i], tB);
      if (Settings.lastReadOK && v !== null) { P[STRW_boolKeys[i]] = v; nRead++; }
   }
   var forced = [];
   if (!P.detectEnable) forced.push("trail detection");
   if (!P.restrictToTrails) forced.push("modify only detected trails");
   // A pipeline step rewrites only frames with a detected trail, as the WBPP mode of the standalone
   P.detectEnable = true;
   P.restrictToTrails = true;
   P.wantDiff = P.wantWeight = P.wantRemoved = P.wantGainMap = false;
   return { P: P, nRead: nRead, forced: forced };
}

// Parameter signature: part of the cache key, so changed settings reprocess the frames
function STRW_paramString(P) {
   var keys = STRW_numKeys.concat(STRW_boolKeys).sort(), s = [], i;
   for (i = 0; i < keys.length; i++) s.push(keys[i] + "=" + P[keys[i]]);
   return s.join(" ");
}

function STRW_readChannel(image, c) {
   var W = image.width, H = image.height, r = new Rect(0, 0, W, H);
   var a = new Float32Array(W * H);
   try { image.getSamples(a, r, c); return a; }
   catch (e) {
      var t = [];
      image.getSamples(t, r, c);
      for (var i = 0; i < t.length; ++i) a[i] = t[i];
      return a;
   }
}

function STRW_writeChannel(image, a, c) {
   var r = new Rect(0, 0, image.width, image.height);
   try { image.setSamples(a, r, c); }
   catch (e) {
      var t = new Array(a.length);
      for (var i = 0; i < a.length; ++i) t[i] = a[i];
      image.setSamples(t, r, c);
   }
}

function STRW_trailSummary(tr) {
   if (!tr) return "";
   var s = [], i, L, B;
   for (i = 0; i < tr.lines.length; i++) {
      L = tr.lines[i];
      s.push("line z=" + L.z.toFixed(1) + " (" + Math.round(L.x0) + "," + Math.round(L.y0) + ")-("
         + Math.round(L.x1) + "," + Math.round(L.y1) + ") hw=" + L.hw + (L.nComp > 1 ? " x" + L.nComp : ""));
   }
   for (i = 0; i < tr.blobs.length; i++) {
      B = tr.blobs[i];
      s.push("blob " + Math.round(B.len) + "x" + B.wid.toFixed(0) + " at (" + Math.round(B.cx) + "," + Math.round(B.cy) + ")");
   }
   return s.join("; ");
}

// Statistics of one frame: those of Desat's processImage (2.9)
// without its diagnostics.  STRW_addChannel adds the result of STR_processChannel
// for channel ch of nCh.  Both also run inside the threads.
function STRW_newStats() {
   return { nAny: 0, nFull: 0, detected: false, hasTrail: false, nLines: 0, nBlobs: 0, zMax: 0, details: "" };
}

function STRW_addChannel(st, res, ch, nCh) {
   var i, dsc;
   st.nAny += res.nAny;
   st.nFull += res.nFull;
   if (res.trail) {
      st.detected = true;
      if (res.trail.hasTrail) st.hasTrail = true;
      st.nLines += res.trail.lines.length; st.nBlobs += res.trail.blobs.length;
      for (i = 0; i < res.trail.lines.length; i++) if (res.trail.lines[i].z > st.zMax) st.zMax = res.trail.lines[i].z;
      dsc = STRW_trailSummary(res.trail);
      if (dsc.length > 0) st.details += (st.details.length > 0 ? " | " : "") + (nCh > 1 ? "ch" + ch + ": " : "") + dsc;
   }
}

// CoreApplication.processEvents(); the global processEvents() is deprecated in PixInsight 1.9.6
function STRW_processEvents() {
   if (typeof CoreApplication !== "undefined" && typeof CoreApplication.processEvents === "function") CoreApplication.processEvents();
   else processEvents();
}

function STRW_noSwapFile() {
   return STRW_const((typeof UndoFlag !== "undefined") ? UndoFlag : null, "NoSwapFile", 0xFFFFFFFF);
}

// Cleans the image of `win` in place against the reference window, on the main
// thread (one frame at a time).  Returns the frame statistics.
function STRW_processWindow(win, refWin, P, log) {
   var view = win.mainView, img = view.image, ref = refWin.mainView.image;
   var W = img.width, H = img.height, nCh = img.numberOfChannels, nChR = ref.numberOfChannels;
   if (ref.width !== W || ref.height !== H)
      throw new Error("Reference and frame sizes differ: " + ref.width + "x" + ref.height + " vs " + W + "x" + H);
   var st = STRW_newStats();
   var ch, sub, stack, res;
   view.beginProcess(STRW_noSwapFile());
   try {
      for (ch = 0; ch < nCh; ch++) {
         if (nCh > 1) log("--- Channel " + ch + " ---");
         sub = STRW_readChannel(img, ch);
         stack = STRW_readChannel(ref, (ch < nChR) ? ch : nChR - 1);
         res = STR_processChannel(sub, stack, W, H, P, log, null);
         stack = null;
         if (res.nAny > 0) STRW_writeChannel(img, sub, ch);
         sub = null;
         STRW_addChannel(st, res, ch, nCh);
         STRW_processEvents();
      }
   } finally {
      view.endProcess();
   }
   return st;
}

// ---------------------------------------------------------------------------
// Threads.  A thread runs in a JavaScript runtime of its own, where nothing of
// this file exists: its code is the source text of the functions listed in
// STRW_threadSource, and its data (d) is cloned into it.  The pixels are not
// copied: d.sub[c] and d.ref[c] describe the channels of the frame and of the
// reference, shared with ImageIterator.share().  The thread cleans the frame's
// pixels in place and returns the frame statistics.
// ---------------------------------------------------------------------------

// Channel samples as a Float32Array.  Registered frames are 32-bit float, and
// then the array IS the image's memory (no copy).  Other formats are copied
// and converted to [0,1]; STRW_putSamples writes such a copy back.
function STRW_samples(it, W, H) {
   var a = it.data, x, y, row, out, real;
   if (a instanceof Float32Array && a.length === W * H) return a;
   out = new Float32Array(W * H);
   real = it.isReal;
   for (y = 0; y < H; y++) {
      row = it[y];
      for (x = 0; x < W; x++) out[y * W + x] = real ? row[x] : it.toReal(row[x]);
   }
   return out;
}

function STRW_putSamples(it, a, W, H) {
   var x, y, row, real = it.isReal;
   for (y = 0; y < H; y++) {
      row = it[y];
      for (x = 0; x < W; x++) row[x] = real ? a[y * W + x] : it.toSample(a[y * W + x]);
   }
}

// d = { title, W, H, P, sub: [descriptor per channel], ref: [descriptor per channel] }
function STRW_threadBody(d) {
   var log = function(m) { console.writeln(m); };
   var nCh = d.sub.length, st = STRW_newStats(), ch, itS, itR, a, b, res;
   log("");
   if (typeof console.noteln === "function") console.noteln(d.title); else log(d.title);
   for (ch = 0; ch < nCh; ch++) {
      if (nCh > 1) log("--- Channel " + ch + " ---");
      itS = new ImageIterator(d.sub[ch]);
      itR = new ImageIterator(d.ref[ch]);
      try {
         a = STRW_samples(itS, d.W, d.H);
         b = STRW_samples(itR, d.W, d.H);
         res = STR_processChannel(a, b, d.W, d.H, d.P, log, null);
         if (res.nAny > 0 && a !== itS.data) STRW_putSamples(itS, a, d.W, d.H);
      } finally {
         itS.free();
         itR.free();
      }
      a = b = null;
      STRW_addChannel(st, res, ch, nCh);
      res = null;
   }
   return st;
}

// The thread's program: the core, the helpers, and the body as its value
function STRW_threadSource() {
   return "var STR_processChannel = (" + STRW_core.toString() + ")();\n"
      + [STRW_trailSummary, STRW_newStats, STRW_addChannel, STRW_samples, STRW_putSamples]
           .map(function(f) { return f.toString(); }).join("\n")
      + "\n;(" + STRW_threadBody.toString() + ")\n";
}

// Number of frames cleaned at the same time (1: no threads)
// Memory of one frame in progress: about 30 bytes per pixel and channel (frame,
// reference match, weights, detection maps), measured in Node.js on the 2.9 core;
// the same with the 3.0 core (wide trails on: 29.2 instead of 29.0 bytes per pixel).
var STRW_BYTES_PER_SAMPLE = 32;
var STRW_MEMORY_FRACTION = 0.8;   // share of the available physical memory the frames in progress may use

// Available physical memory in bytes, or 0 when PixInsight does not report it.
function STRW_availableMemory() {
   try {
      if (typeof System === "object" && System && typeof System.physicalMemoryStatus === "function") {
         var st = System.physicalMemoryStatus();
         if (st && st.availableBytes > 0) return st.availableBytes;
      }
   } catch (x) {}
   return 0;
}

// Frames cleaned at the same time: STRW_THREADS (0 = 8), at most the processors
// PixInsight may use, the number of frames, and what fits in STRW_MEMORY_FRACTION
// of the available physical memory.  Returns { n, note } (note: why it was limited).
function STRW_threadCount(nFrames, bytesPerFrame) {
   if (typeof Thread !== "function" || typeof ImageIterator !== "function" || typeof ImageIterator.share !== "function")
      return { n: 1, note: "" };
   var n = (STRW_THREADS > 0) ? Math.floor(STRW_THREADS) : 8, note = "";
   var cpu = Thread.numberOfProcessors;
   if (cpu > 0 && n > cpu) n = cpu;
   if (n > nFrames) n = nFrames;
   var mem = STRW_availableMemory();
   if (mem > 0 && bytesPerFrame > 0) {
      var fit = Math.floor(STRW_MEMORY_FRACTION * mem / bytesPerFrame);
      note = "memory: " + (mem / 1073741824).toFixed(1) + " GB available, about "
         + (bytesPerFrame / 1073741824).toFixed(1) + " GB per frame";
      if (fit < n) {
         n = fit;
         note += ", limited by memory";
      }
   }
   return { n: (n > 1) ? n : 1, note: note };
}

// HISTORY + STRTRAIL/STRNLINE/STRZMAX keywords (as the standalone, 70-char chunks)
function STRW_writeHistory(win, P, st) {
   var full = "Desat v" + STR_VERSION + " (WBPP builder " + STRW_VERSION + ")"
      + " block=" + P.blockSize + " win=" + P.halfWin
      + " tau=" + P.tau + (P.scaledPrior ? "s" : "L") + " clip=" + P.clipSigma + "x" + P.clipIter
      + (P.satGuard ? " sat=" + P.satLevel + "/" + P.satGrow : " sat=off")
      + " smooth=" + P.smoothRadius + " ramp=" + P.sigmaLow + "-" + P.sigmaHigh
      + " struct=" + P.structTol + " bright=" + P.brightTol + " grow=" + P.growRadius + " feather=" + P.featherRadius
      + " detect=z" + P.detectZ + "/blob" + P.blobMinLen + "x" + P.blobMinAspect
      + (P.lineRemoval ? "/lines" + P.alongWin : "") + (P.wideTrails ? "/wings" + P.wingMax : "") + "/restrict"
      + " trail=" + (st.hasTrail ? "yes" : "no") + "(" + st.nLines + "L," + st.nBlobs + "B)"
      + " touched=" + st.nAny + "px";
   var keywords = win.keywords, kept = [], i;
   for (i = 0; i < keywords.length; i++)
      if (keywords[i].name !== "STRTRAIL" && keywords[i].name !== "STRNLINE" && keywords[i].name !== "STRZMAX")
         kept.push(keywords[i]);
   keywords = kept;
   while (full.length > 0) {
      keywords.push(new FITSKeyword("HISTORY", "", full.substring(0, 70)));
      full = full.substring(70);
   }
   keywords.push(new FITSKeyword("STRTRAIL", st.hasTrail ? "T" : "F", "Satellite trail detected (Desat)"));
   keywords.push(new FITSKeyword("STRNLINE", "" + st.nLines, "Number of trail lines detected"));
   keywords.push(new FITSKeyword("STRZMAX", st.zMax.toFixed(1), "Max line detection score (z)"));
   win.keywords = keywords;
}

function STRW_dir(path) {
   if (!File.directoryExists(path)) {
      try { File.createDirectory(path, true); }
      catch (e) { if (!File.directoryExists(path)) throw e; }
   }
   return path;
}

function STRW_closeWindowId(id) {
   if (!id) return;
   var w = ImageWindow.windowById(id);
   if (w && !w.isNull) w.forceClose();
}

// Pixel rejection of the reference stack.  By default (STRW_REF_REJECTION
// "winsorized" or "sigma") it is fixed here, independent of WBPP's settings for
// the master light: sigma clipping with STRW_REF_SIGMA_LOW / STRW_REF_SIGMA_HIGH,
// average combination, no large-scale rejection.  The other parameters below are
// not used by sigma clipping; they are constants, so they never change the cache key.
// With "wbpp" (builder 1.2): WBPP's rejection settings for lights, with sigma
// high replaced by STRW_REF_SIGMA_HIGH when it is set (> 0).  Sigma high belongs
// to the sigma-clipping algorithms (and, as its high clipping limit, to linear
// fit); with any other algorithm (percentile, ESD, RCR, ...) the reference then
// uses Winsorized sigma clipping.
// The master light always keeps WBPP's settings.  `signature` lists everything
// that changes the reference: it is part of the frames' cache key, so a change
// reprocesses the frames.
function STRW_refRejection(engine, group) {
   var II = ImageIntegration, r, note = "";
   var mode = String(STRW_REF_REJECTION).replace(/^\s+|\s+$/g, "").toLowerCase();
   if (mode !== "wbpp" && mode !== "winsorized" && mode !== "sigma") {
      note = "; unknown STRW_REF_REJECTION \"" + STRW_REF_REJECTION + "\", Winsorized used";
      mode = "winsorized";
   }
   if (mode !== "wbpp") {
      var lo = Number(STRW_REF_SIGMA_LOW), hi = Number(STRW_REF_SIGMA_HIGH);
      if (!(lo > 0)) { note += "; invalid STRW_REF_SIGMA_LOW, 4 used"; lo = 4; }
      if (!(hi > 0)) { note += "; invalid STRW_REF_SIGMA_HIGH, 2.5 used"; hi = 2.5; }
      r = {
         source: "builder",
         rejection: (mode === "sigma") ? II.SigmaClip : II.WinsorizedSigmaClip,
         combination: II.Average,
         pcLow: 0.2, pcHigh: 0.1,
         sigmaLow: lo, sigmaHigh: hi,
         linearFitLow: 5, linearFitHigh: 4,
         esdOutliers: 0.3, esdAlpha: 0.05, rcrLimit: 0.1,
         largeHigh: false, largeHighLayers: 2, largeHighGrowth: 2,
         largeLow: false, largeLowLayers: 2, largeLowGrowth: 2,
         text: ""
      };
      r.text = engine.rejectionName(r.rejection) + ", sigma low " + lo + ", sigma high " + hi
         + " (STRW_REF_*, independent of WBPP's settings" + note + ")";
      return STRW_signRejection(r);
   }
   var idx = BPP.imageTypeIndex(ImageType.Light);
   r = {
      source: "wbpp",
      rejection: (engine.rejection[idx] == BPP.REJECTION_AUTO) ? group.bestRejectionMethod() : engine.rejection[idx],
      combination: engine.combination[idx],
      pcLow: engine.percentileLow[idx], pcHigh: engine.percentileHigh[idx],
      sigmaLow: engine.sigmaLow[idx], sigmaHigh: engine.sigmaHigh[idx],
      linearFitLow: engine.linearFitLow[idx], linearFitHigh: engine.linearFitHigh[idx],
      esdOutliers: engine.ESD_Outliers[idx], esdAlpha: engine.ESD_Significance[idx], rcrLimit: engine.RCR_Limit[idx],
      largeHigh: engine.lightsLargeScaleRejectionHigh, largeHighLayers: engine.lightsLargeScaleRejectionLayersHigh,
      largeHighGrowth: engine.lightsLargeScaleRejectionGrowthHigh,
      largeLow: engine.lightsLargeScaleRejectionLow, largeLowLayers: engine.lightsLargeScaleRejectionLayersLow,
      largeLowGrowth: engine.lightsLargeScaleRejectionGrowthLow,
      text: ""
   };
   var name = engine.rejectionName(r.rejection), extra = "";
   var v = Number(STRW_REF_SIGMA_HIGH);
   if (v > 0) {
      if (r.rejection == II.LinearFit) {
         extra = ", high limit " + v + " (STRW_REF_SIGMA_HIGH; WBPP: " + r.linearFitHigh + ")";
         r.linearFitHigh = v;
      } else {
         var was = "";
         if (r.rejection != II.SigmaClip && r.rejection != II.WinsorizedSigmaClip && r.rejection != II.AveragedSigmaClip) {
            was = "; WBPP's " + name + " has no sigma high";
            r.rejection = II.WinsorizedSigmaClip;
            name = engine.rejectionName(r.rejection);
         }
         extra = ", sigma high " + v + " (STRW_REF_SIGMA_HIGH; WBPP: " + r.sigmaHigh + was + ")";
         r.sigmaHigh = v;
      }
   }
   r.text = name + extra + " [STRW_REF_REJECTION = wbpp: WBPP's settings for lights]";
   return STRW_signRejection(r);
}

function STRW_signRejection(r) {
   var keys = [], k;
   for (k in r) if (r.hasOwnProperty(k) && k !== "text") keys.push(k + "=" + r[k]);
   r.signature = keys.join(" ");
   return r;
}

// Trail-free reference of the group: ImageIntegration of the registered frames with
// the rejection `rej` (STRW_refRejection); equal weights, no local normalization, no
// drizzle data, no rejection maps.  Cached in WBPP's execution cache: reused while
// the frames and the integration settings are unchanged.
// Returns { win, path, cached } (win: open, hidden window; the caller closes it).
function STRW_reference(engine, group, frames, outDir, log, rej) {
   var i;

   var II = new ImageIntegration;
   II.inputHints = engine.imageProcessor.inputHints();
   II.overrideImageType = true;
   II.imageType = ImageType.Light;
   II.bufferSizeMB = 16;
   II.stackSizeMB = 1024;
   II.autoMemorySize = true;
   II.autoMemoryLimit = 0.75;
   var images = [];
   for (i = 0; i < frames.length; i++) images.push([true, frames[i].current, "", ""]);
   II.images = images;
   II.combination = rej.combination;
   II.rejection = rej.rejection;
   II.generateRejectionMaps = false;
   II.generateDrizzleData = false;
   II.pcClipLow = rej.pcLow;
   II.pcClipHigh = rej.pcHigh;
   II.sigmaLow = rej.sigmaLow;
   II.sigmaHigh = rej.sigmaHigh;
   II.winsorizationCutoff = 5.0;
   II.linearFitLow = rej.linearFitLow;
   II.linearFitHigh = rej.linearFitHigh;
   II.esdOutliersFraction = rej.esdOutliers;
   II.esdAlpha = rej.esdAlpha;
   II.rcrLimit = rej.rcrLimit;
   II.clipLow = true;
   II.clipHigh = true;
   II.normalization = ImageIntegration.AdditiveWithScaling;
   II.rejectionNormalization = ImageIntegration.Scale;
   II.largeScaleClipHigh = rej.largeHigh;
   II.largeScaleClipHighProtectedLayers = rej.largeHighLayers;
   II.largeScaleClipHighGrowth = rej.largeHighGrowth;
   II.largeScaleClipLow = rej.largeLow;
   II.largeScaleClipLowProtectedLayers = rej.largeLowLayers;
   II.largeScaleClipLowGrowth = rej.largeLowGrowth;
   II.subtractPedestals = true;
   II.weightMode = ImageIntegration.DontCare;
   II.evaluateSNR = false;
   II.rangeClipLow = true;
   II.rangeLow = 0;
   II.rangeClipHigh = false;
   II.truncateOnOutOfRange = false;
   II.generate64BitResult = false;
   II.useFileThreads = true;
   II.fileThreadOverload = 1.00;
   II.useCache = true;

   var refPath = outDir + "/" + STRW_REF;
   var C = engine.executionCache;
   var SCF = (typeof SourceCodeFlag !== "undefined") ? SourceCodeFlag : null;
   var flags = STRW_const(SCF, "NoTimeInfo", 0) | STRW_const(SCF, "NoReadOnlyParams", 0) | STRW_const(SCF, "NoDescription", 0);
   var key = C.keyFor("BlackRig SatelliteTrailRemover reference " + STRW_CACHE_VERSION + " "
      + II.toSource("JavaScript", "II", 0, flags).trim());

   var ok = C.hasCacheForKey(key) && File.exists(refPath) && C.isFileUnmodified(key, refPath);
   for (i = 0; i < frames.length && ok; i++) ok = C.isFileUnmodified(key, frames[i].current);
   if (ok) {
      log("Reference (cached): " + refPath);
      return { win: engine.imageProcessor.readImage(refPath), path: refPath, cached: true };
   }

   log("Reference: integrating " + frames.length + " registered frames, rejection " + rej.text + ", equal weights");
   engine.processContainer.add(II);
   II.showImages = false;
   var success = II.executeGlobal();
   II.showImages = true;
   STRW_closeWindowId(II.lowRejectionMapImageId);
   STRW_closeWindowId(II.highRejectionMapImageId);
   STRW_closeWindowId(II.slopeMapImageId);
   if (!success) throw new Error("ImageIntegration of the reference failed");
   var win = ImageWindow.windowById(II.integrationImageId);
   if (!win || win.isNull) throw new Error("ImageIntegration produced no image");
   var kw = win.keywords;
   kw.push(new FITSKeyword("HISTORY", "", "Desat " + STR_VERSION + " (WBPP builder " + STRW_VERSION + ") reference"));
   kw.push(new FITSKeyword("HISTORY", "", "of " + frames.length + " registered frames (trail-free by pixel rejection)"));
   win.keywords = kw;
   engine.imageProcessor.writeImage(refPath, [win], ["integration"]);
   C.cacheFileLMD(key, refPath);
   for (i = 0; i < frames.length; i++) C.cacheFileLMD(key, frames[i].current);
   C.setCache(key, { path: refPath, frames: frames.length });
   log("Reference written: " + refPath);
   return { win: win, path: refPath, cached: false };
}

// WBPP's integration of lights takes the drizzle data file of each frame from the
// frame's current path (<name>.xdrz next to it), and fails when it is missing while
// the registered frames have one.  A cleaned copy therefore gets a copy of the
// registered frame's .xdrz.  Drizzle integration itself is not cleaned: it reads
// the calibrated frames.  The copy is not tracked by date: ImageIntegration
// rewrites it (rejection data) on every run.
// After integrating the lights, WBPP checks the date of each frame's drizzle file
// (activeFrame.drizzleFile, set by registration to the registered .xdrz) and marks
// the frames whose file did not change as "excluded from the integration (drizzle
// data not updated)", drizzle on or off (BPP-processing.js).  With drizzle off,
// STRW_useDrizzleCopy points the frame at the copy, the file ImageIntegration
// updates.  With drizzle on it is left alone: the cleaned frames are then left out
// of the drizzle master, whose pixels would come from the calibrated, trailed frame.
function STRW_useDrizzleCopy(f, group, outPath) {
   if (typeof f.addDrizzleFile !== "function") return;
   if (typeof group.isDrizzleEnabled === "function" && group.isDrizzleEnabled()) return;
   var copy = File.changeExtension(outPath, ".xdrz");
   if (File.exists(copy)) f.addDrizzleFile(copy);
}
function STRW_copyDrizzleFile(regPath, outPath) {
   var src = File.changeExtension(regPath, ".xdrz"), dst = File.changeExtension(outPath, ".xdrz");
   if (File.exists(src)) File.copyFile(dst, src);
   else if (File.exists(dst)) File.remove(dst);
}

function STRW_hasDrizzleCopy(regPath, outPath) {
   return !File.exists(File.changeExtension(regPath, ".xdrz")) || File.exists(File.changeExtension(outPath, ".xdrz"));
}

function STRW_csvRow(name, e, action) {
   return '"' + name.replace(/"/g, "'") + '",' + (e.trail ? 1 : 0) + "," + e.lines + "," + e.blobs + ","
      + e.zmax.toFixed(1) + "," + e.px + ',"' + action + '","' + (e.details || "").replace(/"/g, "'") + '"';
}

// The pipeline step for one group.  Never fails a frame: on any error the frame
// keeps its registered file.
function STRW_runGroup(engine, group, op, requestInterruption) {
   var log = function(m) { console.writeln(m); };
   console.noteln("<end><cbr><br>" + BPP.Format.SEPARATOR);
   console.noteln("* Begin satellite trail removal (Desat " + STR_VERSION
      + ", WBPP builder " + STRW_VERSION + ")");
   console.noteln(BPP.Format.SEPARATOR);
   group.log();

   var frames = group.activeFrames(), i;
   if (frames.length < 3) {
      console.warningln("** Warning: " + STRW_NAME + ": fewer than 3 registered frames, no reference can be built. Frames not cleaned.");
      engine.processLogger.addWarning(STRW_NAME + ": fewer than 3 registered frames, frames not cleaned.");
      op.statusMessage = "skipped: " + frames.length + " frame(s)";
      return OperationBlockStatus.DONE;
   }

   var lp = STRW_loadParams(), P = lp.P;
   log(lp.nRead > 0 ? "Parameters: saved settings of the Desat script"
                    : "Parameters: Desat " + STR_VERSION + " defaults (no saved settings found)");
   log("  " + STRW_paramString(P));
   if (lp.forced.length > 0) log("  forced on in a WBPP pipeline: " + lp.forced.join(", "));

   var C = engine.executionCache;
   var rej = STRW_refRejection(engine, group);
   log("Reference rejection: " + rej.text);
   var key = C.keyFor("BlackRig SatelliteTrailRemover " + STR_VERSION + " builder " + STRW_CACHE_VERSION + " " + STRW_paramString(P)
      + " | reference " + rej.signature);
   var state = C.hasCacheForKey(key) ? C.cacheForKey(key) : null;
   if (typeof state !== "object" || state === null) state = {};

   var outDir = STRW_dir(STRW_dir(engine.outputDirectory + "/" + STRW_DIR) + "/" + group.folderName());
   log("Cleaned frames: " + outDir);

   // Frames with a valid cached result are not processed again
   var todo = [], e, f, inp;
   for (i = 0; i < frames.length; i++) {
      inp = frames[i].current;
      e = state[inp];
      if (e && C.isFileUnmodified(key, inp) && (!e.out || (File.exists(e.out) && C.isFileUnmodified(key, e.out)
            && STRW_hasDrizzleCopy(inp, e.out))))
         continue;
      delete state[inp];   // invalid entry: never used, even if this run stops before the frame
      todo.push(frames[i]);
   }
   log(frames.length + " frame(s): " + todo.length + " to process, " + (frames.length - todo.length) + " cached");

   var nTrail = 0, nClean = 0, nErr = 0, aborted = false, ref = null, k, name;
   var nThreads = 1, serial = [], t0 = Date.now(), nDone = 0;

   function frameName(fr) { return File.extractName(fr.current) + File.extractExtension(fr.current); }
   function frameTitle(k) {
      return "=== " + STRW_NAME + " " + (k + 1) + "/" + todo.length + ": <raw>" + frameName(todo[k]) + "</raw>";
   }
   function closeWin(w) { if (w && !w.isNull) w.forceClose(); }

   // Result of frame `fr` (cleaned in `w`, statistics st): write the cleaned copy,
   // or remove a stale one, and record it in the cache
   function frameDone(fr, w, st) {
      var inp = fr.current, outPath = outDir + "/" + frameName(fr);
      var e = { out: "", trail: st.hasTrail, lines: st.nLines, blobs: st.nBlobs, zmax: st.zMax, px: st.nAny, details: st.details };
      if (st.hasTrail && st.nAny > 0) {
         STRW_writeHistory(w, P, st);
         engine.imageProcessor.writeImage(outPath, [w], ["detrailed"]);
         C.cacheFileLMD(key, outPath);
         STRW_copyDrizzleFile(inp, outPath);
         e.out = outPath;
         nTrail++;
         console.noteln("Trail removed (" + st.nAny + " px): <raw>" + outPath + "</raw>");
      } else {
         // a copy left by other settings must not be mistaken for a result
         if (File.exists(outPath)) File.remove(outPath);
         if (File.exists(File.changeExtension(outPath, ".xdrz"))) File.remove(File.changeExtension(outPath, ".xdrz"));
         nClean++;
         log("No trail: <raw>" + frameName(fr) + "</raw>, the registered frame is used unchanged.");
      }
      C.cacheFileLMD(key, inp);
      state[inp] = e;
      nDone++;
   }

   function frameFailed(fr, msg) {
      nErr++;
      delete state[fr.current];
      console.warningln("** Warning: " + STRW_NAME + " failed on <raw>" + frameName(fr) + "</raw>: " + msg
         + ". The registered frame is used unchanged.");
      engine.processLogger.addWarning(STRW_NAME + " failed on " + frameName(fr) + ": " + msg);
   }

   // One frame on the main thread
   function runSerial(k) {
      var fr = todo[k], w = null;
      log("");
      console.noteln(frameTitle(k));
      try {
         w = engine.imageProcessor.readImage(fr.current);
         frameDone(fr, w, STRW_processWindow(w, ref.win, P, log));
      } catch (x) {
         frameFailed(fr, x.message || String(x));
      }
      closeWin(w);
      C.setCache(key, state);   // after every frame: an interrupted run resumes here
   }

   // Frames in parallel threads.  The main thread reads each frame, shares its
   // pixels with a thread, and writes the result when the thread has finished.
   // On a user abort no new frame is started; the frames in progress finish.
   // Frames whose thread fails are put in `serial`, to be redone on the main
   // thread; if the first two threads fail, all remaining frames are.
   function runParallel() {
      var src = STRW_threadSource(), refView = ref.win.mainView, refImg = refView.image;
      var W = refImg.width, H = refImg.height, nChR = refImg.numberOfChannels;
      var refShared = [], running = [], next = 0, stopping = false, nOk = 0, nFail = 0, c, j, job;

      function release(job) {
         if (job.shared) { job.shared = false; try { job.img.releaseSharedData(); } catch (x) {} }
         if (job.inProcess) { job.inProcess = false; job.view.endProcess(); }
      }

      // The thread of frame k failed, or could not be set up: redo the frame on the main thread
      function threadFailed(k, msg) {
         nFail++;
         console.warningln("** Warning: " + STRW_NAME + ": the thread of <raw>" + frameName(todo[k]) + "</raw> failed: "
            + msg + ". The frame is processed again without threads.");
         serial.push(k);
         if (nOk === 0 && nFail === 2 && !stopping) {
            console.warningln("** Warning: " + STRW_NAME + ": threads do not work here; the remaining frames are processed one at a time.");
            while (next < todo.length) serial.push(next++);
         }
      }

      function start(k) {
         var fr = todo[k], job = { k: k, fr: fr, win: null, shared: false, inProcess: false, thread: null }, subs = [], refs = [], img;
         var threadStage = false;
         try {
            job.win = engine.imageProcessor.readImage(fr.current);
            job.view = job.win.mainView;
            img = job.img = job.view.image;
            if (img.width !== W || img.height !== H)
               throw new Error("Reference and frame sizes differ: " + W + "x" + H + " vs " + img.width + "x" + img.height);
            threadStage = true;
            job.view.beginProcess(STRW_noSwapFile());   // shared pixels are writable only inside a process
            job.inProcess = true;
            job.shared = true;
            for (c = 0; c < img.numberOfChannels; c++) {
               subs.push(ImageIterator.share(img, c));
               refs.push(refShared[(c < nChR) ? c : nChR - 1]);
            }
            job.thread = new Thread(src, { title: frameTitle(k), W: W, H: H, P: P, sub: subs, ref: refs });
            job.thread.start();
            return job;
         } catch (x) {
            release(job);
            closeWin(job.win);
            if (threadStage) threadFailed(k, x.message || String(x));
            else {
               frameFailed(fr, x.message || String(x));
               C.setCache(key, state);
            }
            return null;
         }
      }

      function finish(job) {
         var t = job.thread, err = t.error, st = t.result;
         release(job);
         if (err && err.length > 0) {
            threadFailed(job.k, err);
         } else {
            nOk++;
            try { frameDone(job.fr, job.win, st); }
            catch (x) { frameFailed(job.fr, x.message || String(x)); }
            C.setCache(key, state);
         }
         closeWin(job.win);
         job.win = null;
      }

      refView.beginProcess(STRW_noSwapFile());
      try {
         for (c = 0; c < nChR; c++) refShared.push(ImageIterator.share(refImg, c));
         while ((!stopping && next < todo.length) || running.length > 0) {
            while (!stopping && next < todo.length && running.length < nThreads) {
               job = start(next++);
               if (job) running.push(job);
               STRW_processEvents();
               if (console.abortRequested) stopping = true;
            }
            for (j = 0; j < running.length; j++)
               if (running[j].thread.wait(20)) {
                  finish(running[j]);
                  running.splice(j--, 1);
               }
            STRW_processEvents();
            if (console.abortRequested) stopping = true;
         }
      } finally {
         // only reached with threads still running after an unexpected error
         for (j = 0; j < running.length; j++) {
            try { running[j].thread.terminate(); } catch (x) {}
            release(running[j]);
            closeWin(running[j].win);
         }
         try { refImg.releaseSharedData(); } catch (x) {}
         refView.endProcess();
      }
      if (stopping) aborted = true;
   }

   if (todo.length > 0) {
      try {
         ref = STRW_reference(engine, group, frames, outDir, log, rej);
      } catch (x) {
         console.warningln("** Warning: " + STRW_NAME + ": " + x.message + ". Frames not cleaned.");
         engine.processLogger.addWarning(STRW_NAME + ": " + x.message + ". Frames not cleaned.");
         op.statusMessage = "reference failed, frames not cleaned";
         return OperationBlockStatus.FAILED;
      }
      t0 = Date.now();
      try {
         var refIm = ref.win.mainView.image;
         var tc = STRW_threadCount(todo.length, refIm.width * refIm.height * refIm.numberOfChannels * STRW_BYTES_PER_SAMPLE);
         nThreads = tc.n;
         if (tc.note) log("Threads: " + tc.note);
         if (nThreads > 1) {
            log("Cleaning " + todo.length + " frames, " + nThreads + " at a time (one thread per frame;"
               + " a frame's log appears when it is finished)");
            runParallel();
         } else {
            if (todo.length > 1 && /limited by memory/.test(tc.note))
               log("Cleaning " + todo.length + " frames one at a time (not enough memory for more)");
            for (k = 0; k < todo.length; k++) serial.push(k);
         }
         for (k = 0; k < serial.length && !aborted; k++) {
            runSerial(serial[k]);
            STRW_processEvents();
            if (console.abortRequested) aborted = true;
         }
      } finally {
         if (ref && ref.win && !ref.win.isNull) ref.win.forceClose();
      }
      if (nDone > 0)
         log("Time: " + ((Date.now() - t0) / 1000).toFixed(0) + " s for " + nDone + " frame(s), "
            + ((Date.now() - t0) / 1000 / nDone).toFixed(1) + " s per frame"
            + (nThreads > 1 ? " (" + nThreads + " threads)" : ""));
   }

   // Point WBPP at the cleaned copies (processed now or cached) and write the report
   var rows = ["file,trail,lines,blobs,zmax,modified_px,action,details"], nUsed = 0, nCached = 0, isNew;
   for (i = 0; i < frames.length; i++) {
      f = frames[i];
      inp = f.current;
      name = File.extractName(inp) + File.extractExtension(inp);
      e = state[inp];
      isNew = todo.indexOf(f) >= 0;
      if (!e) { rows.push('"' + name.replace(/"/g, "'") + '",,,,,,"' + (isNew && !aborted ? "error" : "not processed") + '",""'); continue; }
      if (!isNew) nCached++;
      if (e.out) {
         f.processingSucceeded(BPP.FrameProcessingStep.REGISTRATION, e.out);
         STRW_useDrizzleCopy(f, group, e.out);
         nUsed++;
      }
      rows.push(STRW_csvRow(name, e, (isNew ? "" : "cached: ") + (e.out ? "cleaned" : "no trail")));
   }
   var rp = outDir + "/Desat_report.csv";
   try { File.writeTextFile(rp, rows.join("\n") + "\n"); log("Report: " + rp); }
   catch (x2) { console.warningln("** Warning: could not write " + rp + ": " + x2.message); }

   var msg = nUsed + " cleaned frame(s) used, " + nTrail + " cleaned now, " + nClean + " without trail"
      + (nCached > 0 ? ", " + nCached + " cached" : "") + (nErr > 0 ? ", " + nErr + " error(s)" : "");
   log("");
   console.noteln(STRW_NAME + ": " + msg);
   engine.processLogger.addSuccess(STRW_NAME, msg + ". Cleaned frames in " + outDir);
   op.statusMessage = nUsed + " cleaned" + (nErr > 0 ? ", " + nErr + " error(s)" : "");
   if (nErr > 0) op.hasWarnings = true;
   console.noteln("<end><cbr><br>" + BPP.Format.SEPARATOR);
   console.noteln("* End satellite trail removal");
   console.noteln(BPP.Format.SEPARATOR);
   if (aborted) {
      requestInterruption();
      return OperationBlockStatus.CANCELED;
   }
   return OperationBlockStatus.DONE;
}

function STRW_makeOperation(engine, group) {
   var op = new BPPOperationBlock(STRW_NAME, group, true);   // trackable: shown in the monitor, raises events
   op.spaceRequired = function() { return group.frameSize(); };   // the reference; cleaned copies only for trailed frames
   op.envForScript = function() {
      return { name: STRW_NAME, status: op.status, statusMessage: op.statusMessage, group: group };
   };
   op._run = function(environment, requestInterruption) {
      return STRW_runGroup(engine, group, op, requestInterruption);
   };
   return op;
}

function STRW_logBlock(fn, params) {
   var b = new OperationBlock;
   b.run = function(env) { fn(env); };
   return { operation: b, params: params };
}


// ============================================================================
// ==== DEBAND STEP (Deband, before registration)
// Runs inside WBPP.  Uses STRW_readChannel, STRW_writeChannel, STRW_samples,
// STRW_putSamples, STRW_processEvents, STRW_noSwapFile, STRW_const, STRW_dir,
// STRW_availableMemory and STRW_logBlock of the trail step above.
// ============================================================================

// Settings written by the standalone Deband dialog (its FD_SETTINGS_KEY)
var FDW_SETTINGS = "FourierDeband/";   // old script name, kept: saved settings carry over

// Processing defaults of Deband 2.1 (its FD_defaults, processing keys only)
var FDW_defaults = {
   horizontal: true, vertical: true, lineSigma: 1.0, protectScale: 128,
   spikes: false, spikeK: 6.0, spikeDilate: 1, nyquist: false, nyquistSigma: 1.5,
   protectStars: true, detectK: 5.0, maskLow: 2.0, maskGrow: 4, refine: 1,
   strength: 1.0, adaptive: false, adaptWindow: 128
};
var FDW_numKeys = ["lineSigma", "protectScale", "spikeK", "spikeDilate", "nyquistSigma", "detectK", "maskLow",
   "maskGrow", "refine", "strength", "adaptWindow"];
var FDW_boolKeys = ["horizontal", "vertical", "spikes", "nyquist", "protectStars", "adaptive"];

var FDW_NAME   = "Deband";
var FDW_DIR    = "debanded";
var FDW_REPORT = "Deband_report.csv";
var FDW_RATIO_WARN = 2;          // removed RMS above this multiple of the group median: warned
// Memory of one frame in progress: Deband needs about 22 bytes per pixel and
// channel (26 with adaptive matching), plus the frame and its output.
var FDW_BYTES_PER_SAMPLE = 30;

// Parameters: Deband 2.1 defaults, overridden by the standalone script's saved settings
function FDW_loadParams() {
   var P = {}, k, i, v, nRead = 0;
   for (k in FDW_defaults) if (FDW_defaults.hasOwnProperty(k)) P[k] = FDW_defaults[k];
   var DT = (typeof DataType !== "undefined") ? DataType : null;
   var tD = STRW_const(DT, "Double", 10), tB = STRW_const(DT, "Boolean", 0);
   for (i = 0; i < FDW_numKeys.length; i++) {
      v = Settings.read(FDW_SETTINGS + FDW_numKeys[i], tD);
      if (Settings.lastReadOK && v !== null && v === v) { P[FDW_numKeys[i]] = v; nRead++; }
   }
   for (i = 0; i < FDW_boolKeys.length; i++) {
      v = Settings.read(FDW_SETTINGS + FDW_boolKeys[i], tB);
      if (Settings.lastReadOK && v !== null) { P[FDW_boolKeys[i]] = v; nRead++; }
   }
   // no diagnostic outputs in a pipeline
   P.wantNoise = P.wantDiag = P.wantMask = P.wantGains = false;
   return { P: P, nRead: nRead };
}

// Parameter signature: part of the cache key, so changed settings reprocess the frames
function FDW_paramString(P) {
   var keys = FDW_numKeys.concat(FDW_boolKeys).sort(), s = [], i;
   for (i = 0; i < keys.length; i++) s.push(keys[i] + "=" + P[keys[i]]);
   return s.join(" ");
}

// What is removed (as Deband's FD_describe)
function FDW_describe(P) {
   var m = [];
   if (P.horizontal) m.push("horizontal bands");
   if (P.vertical) m.push("vertical bands");
   if (P.spikes) m.push("periodic spikes (" + P.spikeK + " sigma)");
   if (P.nyquist) m.push("checkerboard/Nyquist");
   var t = m.join(", ");
   if (P.adaptive && (P.horizontal || P.vertical)) t += "; adaptive amplitude matching (" + P.adaptWindow + " px)";
   return t.length > 0 ? t : "nothing (every target is off)";
}

// HISTORY (as the standalone's FD_historyKeyword) + FDRMS: RMS of what was removed
function FDW_writeHistory(win, P, st) {
   var full = "Deband " + FD_VERSION + " (WBPP builder DebandDesat_WBPP " + DD_VERSION + "): " + FDW_describe(P)
      + " sig=" + Number(P.lineSigma).toFixed(2) + " keep>" + Math.round(P.protectScale) + "px str=" + Number(P.strength).toFixed(2)
      + (P.protectStars ? " mask=" + Number(P.detectK).toFixed(1) + "/" + Number(P.maskLow).toFixed(1) + "/" + Math.round(P.maskGrow)
         + " ref=" + Math.round(P.refine) : " nostarprot")
      + ((P.adaptive && (P.horizontal || P.vertical)) ? " adapt=" + Math.round(P.adaptWindow) + "px" : "");
   var keywords = win.keywords, kept = [], i;
   for (i = 0; i < keywords.length; i++) if (keywords[i].name !== "FDRMS") kept.push(keywords[i]);
   keywords = kept;
   while (full.length > 0) {
      keywords.push(new FITSKeyword("HISTORY", "", full.substring(0, 70)));
      full = full.substring(70);
   }
   keywords.push(new FITSKeyword("FDRMS", st.rms.toExponential(4), "RMS removed by Deband, 64 px from the edges"));
   win.keywords = keywords;
}

// RMS of what was removed (input - output) away from the frame edges (FDW_EDGE px): the first
// and last rows of calibrated frames often differ strongly from the rest; deband flattens them
// too, but they would dominate a whole-frame RMS, which is meant to measure banding.
var FDW_EDGE = 64;
function FDW_interiorRms(a, out, W, H) {
   var e = (W > 4 * FDW_EDGE && H > 4 * FDW_EDGE) ? FDW_EDGE : 0, s = 0, n = 0, x, y, i, d;
   for (y = e; y < H - e; y++) {
      i = y * W + e;
      for (x = e; x < W - e; x++, i++) { d = a[i] - out[i]; s += d * d; n++; }
   }
   return n > 0 ? Math.sqrt(s / n) : 0;
}

// Debands the image of `win` in place, on the main thread.  Returns { rms }.
function FDW_processWindow(win, P) {
   var view = win.mainView, img = view.image, W = img.width, H = img.height, nCh = img.numberOfChannels;
   var rms = 0, ch, a, r;
   view.beginProcess(STRW_noSwapFile());
   try {
      for (ch = 0; ch < nCh; ch++) {
         a = STRW_readChannel(img, ch);
         r = FD_processChannel(a, W, H, P, null);
         rms += FDW_interiorRms(a, r.out, W, H);
         a = null;
         STRW_writeChannel(img, r.out, ch);
         r = null;
         STRW_processEvents();
      }
   } finally {
      view.endProcess();
   }
   return { rms: rms / nCh };
}

// Thread body.  d = { title, W, H, P, sub: [descriptor per channel] }: the frame's
// channels, shared with ImageIterator.share(); debanded in place.  Returns { rms }.
function FDW_threadBody(d) {
   var nCh = d.sub.length, rms = 0, ch, it, a, r;
   for (ch = 0; ch < nCh; ch++) {
      it = new ImageIterator(d.sub[ch]);
      try {
         a = STRW_samples(it, d.W, d.H);
         r = FD_processChannel(a, d.W, d.H, d.P, null);
         rms += FDW_interiorRms(a, r.out, d.W, d.H);
         if (a === it.data) a.set(r.out);
         else STRW_putSamples(it, r.out, d.W, d.H);
      } finally {
         it.free();
      }
      a = r = null;
   }
   return { rms: rms / nCh };
}

// The thread's program: the core, the helpers, and the body as its value
function FDW_threadSource() {
   return "var FD_processChannel = (" + FDW_core.toString() + ")();\n"
      + "var FDW_EDGE = " + FDW_EDGE + ";\n"
      + [STRW_samples, STRW_putSamples, FDW_interiorRms].map(function(f) { return f.toString(); }).join("\n")
      + "\n;(" + FDW_threadBody.toString() + ")\n";
}

// Frames processed at the same time: setting (0 = 8), at most the processors
// PixInsight may use, the number of frames, and what fits in STRW_MEMORY_FRACTION
// of the available physical memory.  Returns { n, note }.
function FDW_threadCount(nFrames, bytesPerFrame) {
   if (typeof Thread !== "function" || typeof ImageIterator !== "function" || typeof ImageIterator.share !== "function")
      return { n: 1, note: "" };
   var n = (FDW_THREADS > 0) ? Math.floor(FDW_THREADS) : 8, note = "";
   var cpu = Thread.numberOfProcessors;
   if (cpu > 0 && n > cpu) n = cpu;
   if (n > nFrames) n = nFrames;
   var mem = STRW_availableMemory();
   if (mem > 0 && bytesPerFrame > 0) {
      var fit = Math.floor(STRW_MEMORY_FRACTION * mem / bytesPerFrame);
      note = "memory: " + (mem / 1073741824).toFixed(1) + " GB available, about "
         + (bytesPerFrame / 1073741824).toFixed(1) + " GB per frame";
      if (fit < n) {
         n = fit;
         note += ", limited by memory";
      }
   }
   return { n: (n > 1) ? n : 1, note: note };
}

function FDW_csvRow(name, inp, e, ratio, action) {
   return '"' + name.replace(/"/g, "'") + '","' + inp.replace(/"/g, "'") + '",'
      + (e ? e.rms.toExponential(4) : "") + "," + (e && ratio > 0 ? ratio.toFixed(3) : "") + ',"' + action + '"';
}

// Median of an array of numbers (copied)
function FDW_median(v) {
   if (v.length === 0) return 0;
   var s = v.slice(0).sort(function(a, b) { return a - b; }), n = s.length;
   return (n & 1) ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

// The pipeline step for one light group (calibration grouping).  Never fails a
// frame: on any error the frame keeps its input file.
function FDW_runGroup(engine, group, op, requestInterruption) {
   var log = function(m) { console.writeln(m); };
   console.noteln("<end><cbr><br>" + BPP.Format.SEPARATOR);
   console.noteln("* Begin deband (Deband " + FD_VERSION + ", WBPP builder DebandDesat_WBPP " + DD_VERSION + ")");
   console.noteln(BPP.Format.SEPARATOR);
   group.log();

   function endLog() {
      console.noteln("<end><cbr><br>" + BPP.Format.SEPARATOR);
      console.noteln("* End deband");
      console.noteln(BPP.Format.SEPARATOR);
   }

   if (group.isCFA) {
      var DOM = (typeof BPP !== "undefined" && BPP.DebayerOutputMode) ? BPP.DebayerOutputMode : null;
      if (!DOM || engine.debayerOutputMethod !== DOM.COMBINED) {
         var why = FDW_NAME + ": colour (CFA) frames are debanded only with WBPP's debayer output \"Combined RGB\"; "
            + "this group is not debanded.";
         console.warningln("** Warning: " + why);
         engine.processLogger.addWarning(why);
         op.statusMessage = "skipped: debayer output is not combined";
         op.hasWarnings = true;
         endLog();
         return OperationBlockStatus.DONE;
      }
   }

   var frames = group.activeFrames(), i;
   if (frames.length === 0) {
      log(FDW_NAME + ": no active frame in this group.");
      op.statusMessage = "no frame";
      endLog();
      return OperationBlockStatus.DONE;
   }

   var lp = FDW_loadParams(), P = lp.P;
   log(lp.nRead > 0 ? "Parameters: saved settings of the Deband script"
                    : "Parameters: Deband " + FD_VERSION + " defaults (no saved settings found)");
   log("  " + FDW_paramString(P));
   log("Removes: " + FDW_describe(P));

   var C = engine.executionCache;
   var key = C.keyFor("BlackRig FourierDeband " + FD_VERSION + " DebandDesat " + FDW_CACHE_VERSION + " " + FDW_paramString(P));
   var state = C.hasCacheForKey(key) ? C.cacheForKey(key) : null;
   if (typeof state !== "object" || state === null) state = {};

   var outDir = STRW_dir(STRW_dir(engine.outputDirectory + "/" + FDW_DIR) + "/" + group.folderName());
   log("Debanded frames: " + outDir);

   // Frames with a valid cached result are not processed again
   var todo = [], e, f, inp;
   for (i = 0; i < frames.length; i++) {
      inp = frames[i].current;
      e = state[inp];
      if (e && e.out && C.isFileUnmodified(key, inp) && File.exists(e.out) && C.isFileUnmodified(key, e.out))
         continue;
      delete state[inp];   // invalid entry: never used, even if this run stops before the frame
      todo.push(frames[i]);
   }
   log(frames.length + " frame(s): " + todo.length + " to process, " + (frames.length - todo.length) + " cached");

   var nNew = 0, nErr = 0, aborted = false, k, name;
   var nThreads = 1, serial = [], t0 = Date.now();

   function frameName(fr) { return File.extractName(fr.current) + File.extractExtension(fr.current); }
   function frameTitle(k) {
      return "=== " + FDW_NAME + " " + (k + 1) + "/" + todo.length + ": <raw>" + frameName(todo[k]) + "</raw>";
   }
   function closeWin(w) { if (w && !w.isNull) w.forceClose(); }

   // Result of frame `fr` (debanded in `w`): write the copy and record it in the cache
   function frameDone(fr, w, st) {
      var inp = fr.current, outPath = outDir + "/" + frameName(fr);
      if (outPath === inp) throw new Error("the output would overwrite the input file");
      FDW_writeHistory(w, P, st);
      engine.imageProcessor.writeImage(outPath, [w], ["debanded"]);
      C.cacheFileLMD(key, outPath);
      C.cacheFileLMD(key, inp);
      state[inp] = { out: outPath, rms: st.rms };
      nNew++;
      log("Debanded (removed RMS " + st.rms.toExponential(3) + "): <raw>" + outPath + "</raw>");
   }

   function frameFailed(fr, msg) {
      nErr++;
      delete state[fr.current];
      console.warningln("** Warning: " + FDW_NAME + " failed on <raw>" + frameName(fr) + "</raw>: " + msg
         + ". The frame is used without debanding.");
      engine.processLogger.addWarning(FDW_NAME + " failed on " + frameName(fr) + ": " + msg);
   }

   // One frame on the main thread
   function runSerial(k) {
      var fr = todo[k], w = null;
      log("");
      console.noteln(frameTitle(k));
      try {
         w = engine.imageProcessor.readImage(fr.current);
         frameDone(fr, w, FDW_processWindow(w, P));
      } catch (x) {
         frameFailed(fr, x.message || String(x));
      }
      closeWin(w);
      C.setCache(key, state);   // after every frame: an interrupted run resumes here
   }

   // Frames in parallel threads (as the trail step): the main thread reads each
   // frame, shares its pixels with a thread, and writes the result when the thread
   // has finished.  On a user abort no new frame is started.  Frames whose thread
   // fails are redone on the main thread; if the first two threads fail, all are.
   function runParallel() {
      var src = FDW_threadSource(), running = [], next = 0, stopping = false, nOk = 0, nFail = 0, c, j, job;

      function release(job) {
         if (job.shared) { job.shared = false; try { job.img.releaseSharedData(); } catch (x) {} }
         if (job.inProcess) { job.inProcess = false; job.view.endProcess(); }
      }

      function threadFailed(k, msg) {
         nFail++;
         console.warningln("** Warning: " + FDW_NAME + ": the thread of <raw>" + frameName(todo[k]) + "</raw> failed: "
            + msg + ". The frame is processed again without threads.");
         serial.push(k);
         if (nOk === 0 && nFail === 2 && !stopping) {
            console.warningln("** Warning: " + FDW_NAME + ": threads do not work here; the remaining frames are processed one at a time.");
            while (next < todo.length) serial.push(next++);
         }
      }

      function start(k) {
         var fr = todo[k], job = { k: k, fr: fr, win: null, shared: false, inProcess: false, thread: null }, subs = [], img;
         var threadStage = false;
         try {
            job.win = engine.imageProcessor.readImage(fr.current);
            job.view = job.win.mainView;
            img = job.img = job.view.image;
            threadStage = true;
            job.view.beginProcess(STRW_noSwapFile());   // shared pixels are writable only inside a process
            job.inProcess = true;
            job.shared = true;
            for (c = 0; c < img.numberOfChannels; c++) subs.push(ImageIterator.share(img, c));
            job.thread = new Thread(src, { title: frameTitle(k), W: img.width, H: img.height, P: P, sub: subs });
            job.thread.start();
            return job;
         } catch (x) {
            release(job);
            closeWin(job.win);
            if (threadStage) threadFailed(k, x.message || String(x));
            else {
               frameFailed(fr, x.message || String(x));
               C.setCache(key, state);
            }
            return null;
         }
      }

      function finish(job) {
         var t = job.thread, err = t.error, st = t.result;
         release(job);
         if (err && err.length > 0) {
            threadFailed(job.k, err);
         } else {
            nOk++;
            log("");
            console.noteln(frameTitle(job.k));
            try { frameDone(job.fr, job.win, st); }
            catch (x) { frameFailed(job.fr, x.message || String(x)); }
            C.setCache(key, state);
         }
         closeWin(job.win);
         job.win = null;
      }

      try {
         while ((!stopping && next < todo.length) || running.length > 0) {
            while (!stopping && next < todo.length && running.length < nThreads) {
               job = start(next++);
               if (job) running.push(job);
               STRW_processEvents();
               if (console.abortRequested) stopping = true;
            }
            for (j = 0; j < running.length; j++)
               if (running[j].thread.wait(20)) {
                  finish(running[j]);
                  running.splice(j--, 1);
               }
            STRW_processEvents();
            if (console.abortRequested) stopping = true;
         }
      } finally {
         // only reached with threads still running after an unexpected error
         for (j = 0; j < running.length; j++) {
            try { running[j].thread.terminate(); } catch (x) {}
            release(running[j]);
            closeWin(running[j].win);
         }
      }
      if (stopping) aborted = true;
   }

   if (todo.length > 0) {
      t0 = Date.now();
      // samples per frame: the group's geometry (PRE groups are mono before debayering; debayered = RGB)
      var px = (group.size && group.size.width > 0) ? group.size.width * group.size.height * (group.isCFA ? 3 : 1) : 0;
      var tc = FDW_threadCount(todo.length, px * FDW_BYTES_PER_SAMPLE);
      nThreads = tc.n;
      if (tc.note) log("Threads: " + tc.note);
      if (nThreads > 1) {
         log("Debanding " + todo.length + " frames, " + nThreads + " at a time (one thread per frame)");
         runParallel();
      } else {
         if (todo.length > 1 && /limited by memory/.test(tc.note))
            log("Debanding " + todo.length + " frames one at a time (not enough memory for more)");
         for (k = 0; k < todo.length; k++) serial.push(k);
      }
      for (k = 0; k < serial.length && !aborted; k++) {
         runSerial(serial[k]);
         STRW_processEvents();
         if (console.abortRequested) aborted = true;
      }
      if (nNew > 0)
         log("Time: " + ((Date.now() - t0) / 1000).toFixed(0) + " s for " + nNew + " frame(s), "
            + ((Date.now() - t0) / 1000 / nNew).toFixed(1) + " s per frame"
            + (nThreads > 1 ? " (" + nThreads + " threads)" : ""));
   }

   // Point WBPP at the debanded copies (processed now or cached) and write the report
   var rmsList = [], nUsed = 0, nCached = 0, isNew, rows = ["file,input,rms_removed,ratio_to_median,action"];
   var step = BPP.FrameProcessingStep.CC;
   for (i = 0; i < frames.length; i++) { e = state[frames[i].current]; if (e) rmsList.push(e.rms); }
   var med = FDW_median(rmsList), strong = [];
   for (i = 0; i < frames.length; i++) {
      f = frames[i];
      inp = f.current;
      e = state[inp];
      isNew = todo.indexOf(f) >= 0;
      if (!e) {
         name = File.extractName(inp) + File.extractExtension(inp);
         rows.push(FDW_csvRow(name, inp, null, 0, (isNew && !aborted) ? "error" : "not processed"));
         continue;
      }
      if (!isNew) nCached++;
      var ratio = med > 0 ? e.rms / med : 0;
      name = File.extractName(e.out) + File.extractExtension(e.out);
      rows.push(FDW_csvRow(name, inp, e, ratio, (isNew ? "" : "cached: ") + "debanded"));
      if (ratio > FDW_RATIO_WARN) strong.push(name + " (x" + ratio.toFixed(2) + ")");
      f.processingSucceeded(step, e.out);
      nUsed++;
   }
   var rp = outDir + "/" + FDW_REPORT;
   try { File.writeTextFile(rp, rows.join("\n") + "\n"); log("Report: " + rp); }
   catch (x2) { console.warningln("** Warning: could not write " + rp + ": " + x2.message); }
   if (strong.length > 0)
      console.warningln("** " + strong.length + " frame(s) with unusually strong pattern noise (removed RMS above "
         + FDW_RATIO_WARN + "x the group median): " + strong.join(", "));

   var msg = nUsed + " debanded frame(s) used, " + nNew + " debanded now"
      + (nCached > 0 ? ", " + nCached + " cached" : "") + (nErr > 0 ? ", " + nErr + " error(s)" : "");
   log("");
   console.noteln(FDW_NAME + ": " + msg);
   engine.processLogger.addSuccess(FDW_NAME, msg + ". Debanded frames in " + outDir);
   op.statusMessage = nUsed + " debanded" + (nErr > 0 ? ", " + nErr + " error(s)" : "");
   if (nErr > 0) op.hasWarnings = true;
   endLog();
   if (aborted) {
      requestInterruption();
      return OperationBlockStatus.CANCELED;
   }
   return OperationBlockStatus.DONE;
}

function FDW_makeOperation(engine, group) {
   var op = new BPPOperationBlock(FDW_NAME, group, true);   // trackable: shown in the monitor, raises events
   op.spaceRequired = function() {
      // one copy of every frame (PRE groups are counted mono: x3 once debayered)
      return ((typeof group.groupSize === "function") ? group.groupSize() : group.frameSize() * group.activeFrames().length)
         * (group.isCFA ? 3 : 1);
   };
   op.envForScript = function() {
      return { name: FDW_NAME, status: op.status, statusMessage: op.statusMessage, group: group };
   };
   op._run = function(environment, requestInterruption) {
      return FDW_runGroup(engine, group, op, requestInterruption);
   };
   return op;
}


// ============================================================================
// ==== BUILDER
// Runs on every pipeline rebuild (nearly every click in WBPP): no console
// output and no file access here.
// ============================================================================

// Throws when this WBPP lacks what the step relies on: WBPP then builds its
// standard pipeline and shows the message in the Pipeline builder panel.
function STRW_checkApi(engine) {
   var missing = [];
   if (!engine.pipelineManager || typeof engine.pipelineManager.buildPipelineForLight !== "function") missing.push("pipelineManager.buildPipelineForLight");
   if (!engine.imageProcessor || typeof engine.imageProcessor.readImage !== "function" || typeof engine.imageProcessor.writeImage !== "function") missing.push("imageProcessor.readImage/writeImage");
   if (!engine.executionCache || typeof engine.executionCache.isFileUnmodified !== "function") missing.push("executionCache");
   if (typeof BPPOperationBlock !== "function" || typeof OperationBlock !== "function") missing.push("BPPOperationBlock");
   if (typeof BPP === "undefined" || !BPP.FrameProcessingStep) missing.push("BPP.FrameProcessingStep");
   if (missing.length > 0)
      throw new Error("DebandDesat_WBPP " + DD_VERSION + " needs WBPP 3.1.2; missing: " + missing.join(", "));
}

// Inserts one trail-removal step per registered group after the last registration
// (and its log footer), before local normalization and integration.
function STRW_insert(engine) {
   var Q = engine.operationQueue, ops = Q.operations, i, o, last = -1, groups = [];
   var RegOp = engine.RegistrationOperation;
   for (i = 0; i < ops.length; i++) {
      o = ops[i].operation;
      if ((typeof RegOp === "function" && o instanceof RegOp) || o.name === "Registration") {
         last = i;
         if (o.group && groups.indexOf(o.group) < 0) groups.push(o.group);
      }
   }
   if (last < 0) {
      engine.pipelineBuilderWarning = STRW_NAME + ": no registration in this pipeline, nothing to clean.";
      return;
   }
   var at = last + 1;
   if (at < ops.length && !(ops[at].operation instanceof BPPOperationBlock)) at++;   // registration log footer

   var mine = [], g, logEnv, drizzle = false;
   for (i = 0; i < groups.length; i++) {
      g = groups[i];
      logEnv = { processLogger: engine.processLogger, group: g };
      mine.push(STRW_logBlock(function(env) {
         env.params.processLogger.addMessage(env.params.group.logStringHeader("SATELLITE TRAIL REMOVAL"));
      }, logEnv));
      mine.push({ operation: STRW_makeOperation(engine, g), params: undefined });
      mine.push(STRW_logBlock(function(env) {
         env.params.processLogger.addMessage(env.params.group.logStringFooter());
         env.params.processLogger.newLine();
      }, logEnv));
      if (engine.WS && engine.WS.registration) engine.WS.registration.size += g.frameSize();
      if (typeof g.isDrizzleEnabled === "function" && g.isDrizzleEnabled()) drizzle = true;
   }
   var all = ops.slice(0, at).concat(mine).concat(ops.slice(at));
   Q.operations = [];
   for (i = 0; i < all.length; i++) Q.addOperation(all[i].operation, all[i].params);
   if (drizzle)
      engine.pipelineBuilderWarning = STRW_NAME + ": drizzle is enabled. Drizzle integration is not cleaned "
         + "(it reads the frames as they were before registration). Frames with a cleaned trail are left out of the drizzle master; "
         + "WBPP lists them as excluded (drizzle data not updated).";
}

// Inserts one deband step per light group of the calibration grouping, after the
// last light preprocessing operation (calibration, linear defects correction,
// cosmetic correction, debayering) and its log footer, i.e. before measurement,
// reference frame selection and registration.  Returns a warning or "".
function FDW_insert(engine) {
   var missing = [];
   if (!engine.groupsManager || typeof engine.groupsManager.groupsForMode !== "function") missing.push("groupsManager.groupsForMode");
   if (typeof BPP === "undefined" || !BPP.GroupingMode) missing.push("BPP.GroupingMode");
   if (missing.length > 0) throw new Error("this WBPP lacks " + missing.join(", "));

   var Q = engine.operationQueue, ops = Q.operations, i, o, last = -1, first = -1;
   var preTypes = [engine.calibrationOperation, engine.LPSOperation, engine.CosmeticCorrectionOperation, engine.DebayerOperation];
   var postTypes = [engine.ReferenceFrameDataPreparationOperation, engine.MeasurementOperation,
      engine.ReferenceFrameSelectionOperation, engine.RegistrationOperation, engine.FastIntegrationOperation];
   function isOf(op, types) {
      for (var t = 0; t < types.length; t++) if (typeof types[t] === "function" && op instanceof types[t]) return true;
      return false;
   }
   for (i = 0; i < ops.length; i++) {
      o = ops[i].operation;
      if (isOf(o, preTypes)) {
         // calibration operations also run for bias, darks and flats: only lights count
         if (typeof engine.calibrationOperation === "function" && o instanceof engine.calibrationOperation
             && !(o.group && o.group.imageType == ImageType.Light)) continue;
         last = i;
      } else if (first < 0 && isOf(o, postTypes)) first = i;
   }
   var at;
   if (last >= 0) {
      at = last + 1;
      if (at < ops.length && !(ops[at].operation instanceof BPPOperationBlock)) at++;   // log footer
   } else if (first >= 0) {
      at = first;
      if (at > 0 && !(ops[at - 1].operation instanceof BPPOperationBlock)) at--;        // log header of that step
   } else
      return FDW_NAME + ": no light frames to deband in this pipeline.";

   var groups = engine.groupsManager.groupsForMode(BPP.GroupingMode.PRE).filter(function(g) {
      return g.isActive !== false && g.imageType == ImageType.Light;
   });
   if (groups.length === 0) return FDW_NAME + ": no light group to deband.";
   var mine = [], g, logEnv, cfaSep = false, dop;
   for (i = 0; i < groups.length; i++) {
      g = groups[i];
      logEnv = { processLogger: engine.processLogger, group: g };
      mine.push(STRW_logBlock(function(env) {
         env.params.processLogger.addMessage(env.params.group.logStringHeader("DEBAND"));
      }, logEnv));
      dop = FDW_makeOperation(engine, g);
      mine.push({ operation: dop, params: undefined });
      mine.push(STRW_logBlock(function(env) {
         env.params.processLogger.addMessage(env.params.group.logStringFooter());
         env.params.processLogger.newLine();
      }, logEnv));
      if (engine.WS && engine.WS.cosmeticCorrection) engine.WS.cosmeticCorrection.size += dop.spaceRequired();
      if (g.isCFA && BPP.DebayerOutputMode && engine.debayerOutputMethod !== BPP.DebayerOutputMode.COMBINED) cfaSep = true;
   }
   var all = ops.slice(0, at).concat(mine).concat(ops.slice(at));
   Q.operations = [];
   for (i = 0; i < all.length; i++) Q.addOperation(all[i].operation, all[i].params);
   return cfaSep ? FDW_NAME + ": colour frames are debanded only with the debayer output \"Combined RGB\"." : "";
}

function DD_build(engine) {
   STRW_checkApi(engine);
   engine.pipelineManager.buildPipelineForLight();
   // From here on the builder must not throw: WBPP would build the light pipeline a second time
   var warn = [], w;
   if (DD_DEBAND) {
      try { w = FDW_insert(engine); if (w) warn.push(w); }
      catch (x) { warn.push(FDW_NAME + " NOT added: " + (x.message || x)); }
   }
   if (DD_DETRAIL) {
      engine.pipelineBuilderWarning = "";
      try { STRW_insert(engine); }
      catch (x) { engine.pipelineBuilderWarning = STRW_NAME + " NOT added: " + (x.message || x); }
      if (engine.pipelineBuilderWarning) warn.push(engine.pipelineBuilderWarning);
   }
   if (!DD_DEBAND && !DD_DETRAIL) warn.push("DebandDesat_WBPP: both steps are switched off (DD_DEBAND, DD_DETRAIL); standard pipeline.");
   engine.pipelineBuilderWarning = warn.join(" | ");
}

DD_build(engine);

// ----------------------------------------------------------------------------
// EOF DebandDesat_WBPP.js
