// ----------------------------------------------------------------------------
// SatelliteTrailRemover_WBPP.js  –  WBPP pipeline builder for PixInsight
// Satellite trail removal inside WeightedBatchPreprocessing (WBPP 3.2.0, whose
// source files are labelled 3.1.2; PixInsight 1.9.6).
//
// WHAT IT DOES
// WBPP runs the standard light pipeline with one extra step per light group,
// right after registration and before local normalization and integration:
//
//   1. Reference: the registered frames of the group are integrated with
//      ImageIntegration (WBPP's rejection settings, equal weights, no LN).
//      Pixel rejection removes the trails, so this stack is trail-free.
//      Saved as <output>/detrailed/<group>/STR_reference.xisf.
//   2. Every registered frame is matched to the reference and searched for
//      trails with the SatelliteTrailRemover 2.9 method (adaptive match, line
//      and blob detection, along-track removal, double trails).
//   3. A frame with a trail gets a cleaned copy in <output>/detrailed/<group>/
//      (same file name) and WBPP continues with that copy: local normalization
//      and integration see the cleaned frame.  Frames without trail are not
//      written; WBPP keeps using the registered file.
//
// The registered frames are never modified, so WBPP's registration cache stays
// valid and nothing needs restoring: disable the builder and WBPP uses the
// registered frames again.
//
// REFERENCE REJECTION
// The reference stack has its own pixel rejection, set below and independent
// of WBPP's settings for the master light: by default Winsorized sigma
// clipping, sigma low 4, sigma high 2.5.  Changing WBPP's rejection for the
// master light therefore never redoes the trail removal.  A lower sigma high
// (e.g. 2.0) rejects faint trails more completely.
// STRW_REF_REJECTION = "wbpp" restores the behaviour of builder 1.2: the
// reference follows WBPP's settings for lights, and STRW_REF_SIGMA_HIGH (> 0)
// replaces only its sigma high (with linear fit, the high clipping limit; with
// percentile, ESD or RCR the reference then uses Winsorized sigma clipping).
// The console shows what was used.
//
// SETTINGS
// The processing parameters are the ones saved by the standalone script
// SatelliteTrailRemover (Script > BlackRig > SatelliteTrailRemover): run it
// once, set the parameters, close it with OK or Cancel (both save).  Missing
// settings fall back to the 2.9 defaults.  Trail detection and "modify only
// detected trails" are always on here.  Read when the step runs.
//
// CACHE
// Results are stored in WBPP's execution cache: a rerun skips frames whose
// registered file and parameters are unchanged (and reuses their cleaned
// copy); new frames, re-registered frames and changed parameters are
// processed again.  "Purge cache" in WBPP clears it.
//
// SPEED
// Several frames are cleaned at the same time, each in its own thread
// (PixInsight's Thread object).  STRW_THREADS below sets how many: 0 means
// automatic (8), 1 means one frame at a time.  The number is always lowered to
// the processors PixInsight may use (Edit > Global Preferences) and to what
// fits in 80 % of the available physical memory: each frame in progress needs
// about 32 bytes per pixel and channel (about 3 GB for a 100-Mpx monochrome
// frame).  The console shows the memory available and the number used.  The
// result does not depend on the number of threads.
//
// NOT CLEANED: drizzle.  Drizzle integration reads the calibrated frames
// through the .xdrz files.  A cleaned copy gets a copy of its frame's .xdrz
// (WBPP's integration needs one next to each file).  After integrating the
// lights, WBPP checks that each frame's drizzle file was updated, even with
// drizzle off.  With drizzle off, the step points WBPP at the copy, which
// ImageIntegration updates.  With drizzle on, WBPP keeps checking the
// registered frame's .xdrz, reports the cleaned frames as "excluded (drizzle
// data not updated)" and leaves them out of the drizzle master; they are in
// the master light.
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
// Version 1.3 (core: SatelliteTrailRemover 2.9)
//   1.3  the reference stack's rejection is independent of WBPP's settings
//        (STRW_REF_REJECTION, STRW_REF_SIGMA_LOW, STRW_REF_SIGMA_HIGH; default
//        Winsorized 4 / 2.5); with drizzle off, cleaned frames are no longer
//        reported as "excluded (drizzle data not updated)" after integration;
//        the number of frames cleaned at once fits the available memory
//   1.2  separate sigma high for the reference stack (STRW_REF_SIGMA_HIGH);
//        cleaned copies get the frame's .xdrz (WBPP's integration needs it)
//   1.1  frames cleaned in parallel threads (same results as 1.0)
//   1.0  first version
// Author: Erellaz
// License: MIT (see the LICENSE file next to this script)
// ----------------------------------------------------------------------------

var STRW_THREADS = 0;       // frames cleaned at the same time: 0 = automatic (8), 1 = one at a time; always limited by processors and memory
// Pixel rejection of the REFERENCE stack only.  Independent of WBPP's settings for the master light.
var STRW_REF_REJECTION  = "winsorized";   // "winsorized", "sigma" (plain sigma clipping), or "wbpp" (follow WBPP's settings for lights)
var STRW_REF_SIGMA_LOW  = 4.0;
var STRW_REF_SIGMA_HIGH = 2.5;            // lower = trails rejected more completely; with "wbpp": 0 keeps WBPP's value

var STR_VERSION  = "2.9";   // SatelliteTrailRemover core below (verbatim copy of 2.9)
var STRW_VERSION = "1.3";   // this WBPP builder
var STRW_CACHE_VERSION = "1.0";   // version of the results, part of the cache keys: bump when they change

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
function STR_adaptiveSubtract(sub, stack, valid, W, H, P, log) {
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
function STR_refineLine(L, diff, incl, W, H, sigma) {
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
   // wings of bright trails: extend while above 2 % of the peak (at most 15 px per side)
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
// Along-track trail model T(a, d) inside the corridor of line L (estimated
// over the corridor + 8 px margin, minus the margin level = pedestal): mean residual
// of included pixels in 1-px along-track bins and 1-px distance bins, box-
// averaged along track over +-Lw px; two passes (2nd rejects |r - T0| > 4 sigma:
// hot pixels, residual star mismatch).  T is added to lineT (linear in d),
// attenuated by the saturation protection and blended with the per-pixel
// weight (removed = w*r + (1-w)*T); corridor pixels are marked in corr.
// Returns the number of newly marked corridor pixels.
// ---------------------------------------------------------------------------
function STR_lineModel(L, diff, incl, W, H, sigma, Lw, lineT, w, sp, corr) {
   var hwT = L.hw, mg = 8, hw = hwT + mg, nd = 2 * hw + 1, a0 = L.a0, La = Math.floor(L.a1 - a0) + 1;
   var S = new Float64Array(La * nd), C = new Float64Array(La * nd);
   var T0 = null, T = null, pass, rej = 4 * sigma;
   function boxAlong() {
      var out = new Float32Array(La * nd), di, ai, s, c, add, rem;
      for (di = 0; di < nd; di++) {
         s = 0; c = 0;
         for (ai = 0; ai <= Lw && ai < La; ai++) { s += S[ai * nd + di]; c += C[ai * nd + di]; }
         for (ai = 0; ai < La; ai++) {
            out[ai * nd + di] = (c >= 3) ? s / c : 0;
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
      if (pass === 0) T0 = boxAlong(); else T = boxAlong();
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
   var ai2, di2, pb, pc;
   for (ai2 = 0; ai2 < La; ai2++) {
      pb = 0; pc = 0;
      for (di2 = 0; di2 < mg; di2++) { pb += T[ai2 * nd + di2] + T[ai2 * nd + nd - 1 - di2]; pc += 2; }
      pb /= pc;
      for (di2 = 0; di2 < nd; di2++) {
         var tv = T[ai2 * nd + di2] - pb;
         T[ai2 * nd + di2] = (tv > 0 && sig_d[di2]) ? tv : 0;   // a trail only adds light
      }
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
function STR_detectTrails(sub, stack, diff, valid, w, sp, W, H, P, sigma, log, dump) {
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
      for (i = 0; i < lines.length; i++) STR_refineLine(lines[i], diff, incl, W, H, sigma);
      if (P.lineRemoval !== false) {
         lineT = new Float32Array(N); corr = new Uint8Array(N);
         for (i = 0; i < lines.length; i++) nCorr += STR_lineModel(lines[i], diff, incl, W, H, sigma, Lw, lineT, w, sp, corr);
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
            + (Math.abs(L.shift) >= 1 ? ", re-centred by " + L.shift.toFixed(1) + " px" : ""));
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
   return { hasTrail: hasTrail, lines: outLines, blobs: outBlobs, lineT: lineT, region: region, nCorr: nCorr };
}

// ---------------------------------------------------------------------------
// Full pipeline for one channel.
// `sub` is OVERWRITTEN in place with the corrected data.
// Returns {diff, weight, removed (or null), gainGrid, offsetGrid, BW, BH,
//          blockSize, nAny, nFull, removedFlux}
// ---------------------------------------------------------------------------
// `dump` (optional): function(name, fullFrameArray) called with intermediate
// images, read-only (debugging; does not change the result).
function STR_processChannel(sub, stack, W, H, P, log, dump) {
   var N = W * H;
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
      det = STR_detectTrails(sub, stack, diff, vm.mask, w, (typeof sp !== "undefined") ? sp : null,
                             W, H, P, as.sigma, log, dump);
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
// ============================================================================


// ============================================================================
// ==== WBPP STEP
// Runs inside WBPP: uses PixInsight objects and WBPP's engine.  No preprocessor:
// the constants of the pjsr include files do not exist here (WBPP uses DataType.Double,
// UndoFlag.NoSwapFile, ...).
// ============================================================================

// Settings written by the standalone SatelliteTrailRemover dialog
var STRW_SETTINGS = "BlackRig/SatelliteTrailRemover/v2/";

// Processing defaults of SatelliteTrailRemover 2.9 (its STR_defaults)
var STRW_defaults = {
   blockSize: 64, halfWin: 4, tau: 0.1, clipSigma: 3.0, clipIter: 3, scaledPrior: true,
   satGuard: true, satLevel: 0.95, satGrow: 8,
   smoothRadius: 2, sigmaLow: 4.0, sigmaHigh: 8.0, structTol: 0.5, brightTol: 0.05,
   growRadius: 3, featherRadius: 2,
   detectEnable: true, detectZ: 15, blobMinLen: 300, blobMinAspect: 10,
   lineRemoval: true, alongWin: 64, restrictToTrails: true
};
var STRW_numKeys = [
   "blockSize", "halfWin", "tau", "clipSigma", "clipIter",
   "smoothRadius", "sigmaLow", "sigmaHigh", "structTol", "brightTol", "growRadius", "featherRadius",
   "detectZ", "blobMinLen", "blobMinAspect", "alongWin",
   "satLevel", "satGrow"
];
var STRW_boolKeys = ["scaledPrior", "satGuard", "detectEnable", "lineRemoval", "restrictToTrails"];

var STRW_NAME = "Satellite trail removal";
var STRW_DIR  = "detrailed";
var STRW_REF  = "STR_reference.xisf";

function STRW_const(obj, name, fallback) {
   return (obj !== undefined && obj !== null && obj[name] !== undefined) ? obj[name] : fallback;
}

// Parameters: 2.9 defaults, overridden by the standalone script's saved settings
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

// Statistics of one frame: those of SatelliteTrailRemover's processImage (2.9)
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
// reference match, weights, detection maps), measured in Node.js on the 2.9 core.
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
   var full = "SatelliteTrailRemover v" + STR_VERSION + " (WBPP builder " + STRW_VERSION + ")"
      + " block=" + P.blockSize + " win=" + P.halfWin
      + " tau=" + P.tau + (P.scaledPrior ? "s" : "L") + " clip=" + P.clipSigma + "x" + P.clipIter
      + (P.satGuard ? " sat=" + P.satLevel + "/" + P.satGrow : " sat=off")
      + " smooth=" + P.smoothRadius + " ramp=" + P.sigmaLow + "-" + P.sigmaHigh
      + " struct=" + P.structTol + " bright=" + P.brightTol + " grow=" + P.growRadius + " feather=" + P.featherRadius
      + " detect=z" + P.detectZ + "/blob" + P.blobMinLen + "x" + P.blobMinAspect
      + (P.lineRemoval ? "/lines" + P.alongWin : "") + "/restrict"
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
   keywords.push(new FITSKeyword("STRTRAIL", st.hasTrail ? "T" : "F", "Satellite trail detected (SatelliteTrailRemover)"));
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
   kw.push(new FITSKeyword("HISTORY", "", "SatelliteTrailRemover " + STR_VERSION + " (WBPP builder " + STRW_VERSION + ") reference"));
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
   console.noteln("* Begin satellite trail removal (SatelliteTrailRemover " + STR_VERSION
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
   log(lp.nRead > 0 ? "Parameters: saved settings of the SatelliteTrailRemover script"
                    : "Parameters: SatelliteTrailRemover " + STR_VERSION + " defaults (no saved settings found)");
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
   var rp = outDir + "/SatelliteTrailRemover_report.csv";
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
      throw new Error("SatelliteTrailRemover builder " + STRW_VERSION + " needs WBPP 3.1.2; missing: " + missing.join(", "));
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
         + "(it reads the calibrated frames). Frames with a cleaned trail are left out of the drizzle master; "
         + "WBPP lists them as excluded (drizzle data not updated).";
}

function STRW_build(engine) {
   STRW_checkApi(engine);
   engine.pipelineManager.buildPipelineForLight();
   // From here on the builder must not throw: WBPP would build the light pipeline a second time
   try { STRW_insert(engine); }
   catch (x) {
      engine.pipelineBuilderWarning = STRW_NAME + " NOT added (standard pipeline kept): " + (x.message || x);
   }
}

STRW_build(engine);

// ----------------------------------------------------------------------------
// EOF SatelliteTrailRemover_WBPP.js
