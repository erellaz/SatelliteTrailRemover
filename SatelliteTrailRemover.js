// ----------------------------------------------------------------------------
// SatelliteTrailRemover.js  –  PixInsight PJSR Script
// Remove satellite trails from registered sub-exposures by adaptive
// subtraction of a sigma-clipped reference stack.
//
// The stack is matched to the sub with a spatially varying gain and offset
// (model = gain(x,y) * stack + offset(x,y)).  The residual diff = sub - model
// holds the trails plus noise.  The significant positive part of that
// residual is subtracted from the sub with a soft, spatially smooth weight:
//
//    corrected = sub - w * diff  =  (1 - w) * sub + w * model
//
// No explicit trail detection / line fitting: w comes from the significance
// of the smoothed residual, with a structure tolerance that protects stars
// (present in the reference) but not trails (absent from it).
// v2.3: scale-aware gain prior (the gain is really fitted) and saturation
// guard (saturated pixels are never modified), both on by default.
// v2.4: experimental star exclusion (v2.1-2.3) removed: on real data it
// targeted the wrong cause and was slow.
// v2.5: brightness tolerance (default 0.05): residuals on smooth bright light
// already in the reference (bright-star halos/spikes/bleed) are not subtracted.
// v2.6: frame-level trail detection (matched-filter line search on the residual
// + elongated blobs), line removal with an along-track trail model (faint
// trails), and option to modify only the detected trails (default on).
// v2.7: WBPP compatibility mode: cleans the .xisf frames of <WBPP>/registered/<group> against
// <WBPP>/master/master<group>.xisf; originals of cleaned frames renamed .sat.
// v2.8: collapsible dialog sections (fits small screens); the on/off switches of
// detection, debug dump, WBPP and batch mode sit in the section bars; the
// expanded/collapsed state is remembered.  Processing unchanged.
// v2.9: double / parallel trails (satellite pairs, aircraft with two lights): the
// cross-profile of each line is measured over +-96 px, the corridor is asymmetric
// (line re-centred on the trail extent) and includes parallel components present all
// along the track (segment test); half-width
// up to 60 px.  Before, the outer flank of the second component was left in the frame.
// The along-track model is 0 in distance bins without significant mean trail signal
// (removes a small over-subtraction from clamping noise at 0).
// Interactive mode modifies the selected views in place, with undo.
//
// Version 2.9
// Author: Erellaz
// License: MIT (see the LICENSE file next to this script)
// Documentation: SatelliteTrailRemover_how_it_works.docx (next to this file)
//
// Script > BlackRig > SatelliteTrailRemover
// ----------------------------------------------------------------------------

#feature-id    SatelliteTrailRemover : BlackRig > SatelliteTrailRemover
#feature-info  Removes satellite trails from registered sub-exposures by \
   adaptive subtraction of a sigma-clipped reference stack: the stack is \
   matched to the sub (local gain and offset) and the significant positive \
   residual is subtracted with a soft weight.

#include <pjsr/DataType.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/SectionBar.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdButton.jsh>

#define STR_VERSION   "2.9"

// ============================================================================
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
// ============================================================================


// ============================================================================
// PJSR User Interface
// ============================================================================

var STR_defaults = {
   // Adaptive match
   blockSize:     64,
   halfWin:       4,
   tau:           0.1,
   clipSigma:     3.0,
   clipIter:      3,
   scaledPrior:   true,
   // Saturation guard
   satGuard:      true,
   satLevel:      0.95,
   satGrow:       8,
   // Residual subtraction
   smoothRadius:  2,
   sigmaLow:      4.0,
   sigmaHigh:     8.0,
   structTol:     0.5,
   brightTol:     0.05,
   growRadius:    3,
   featherRadius: 2,
   // Trail detection (v2.6)
   detectEnable:     true,
   detectZ:          15,
   blobMinLen:       300,
   blobMinAspect:    10,
   lineRemoval:      true,
   alongWin:         64,
   restrictToTrails: true,
   // Outputs
   wantDiff:      false,
   wantWeight:    true,
   wantRemoved:   false,
   wantGainMap:   false,
   // Batch
   batchDir:      "",
   batchSuffix:   "_detrailed",
   // WeightedBatchPreprocessing compatibility mode (v2.7)
   wbppEnable:    false,
   wbppDir:       "",
   // Debug dump (interactive mode only)
   dumpEnable:    false,
   dumpDir:       "",
   // Dialog: comma-separated keys of the expanded sections (v2.8)
   uiExpanded:    ""
};

var STR_settingsKey = "BlackRig/SatelliteTrailRemover/v2";
var STR_numKeys = [
   "blockSize", "halfWin", "tau", "clipSigma", "clipIter",
   "smoothRadius", "sigmaLow", "sigmaHigh", "structTol", "brightTol", "growRadius", "featherRadius",
   "detectZ", "blobMinLen", "blobMinAspect", "alongWin",
   "satLevel", "satGrow"
];
var STR_boolKeys = ["scaledPrior", "satGuard", "wantDiff", "wantWeight", "wantRemoved", "wantGainMap",
                    "dumpEnable", "detectEnable", "lineRemoval", "restrictToTrails", "wbppEnable"];
var STR_strKeys  = ["batchDir", "batchSuffix", "dumpDir", "wbppDir", "uiExpanded"];

function STR_loadSettings(P) {
   var k = STR_settingsKey + "/";
   var i, val;
   for (i = 0; i < STR_numKeys.length; i++) {
      val = Settings.read(k + STR_numKeys[i], DataType_Double);
      if (Settings.lastReadOK && val !== null && val === val) P[STR_numKeys[i]] = val;
   }
   for (i = 0; i < STR_boolKeys.length; i++) {
      val = Settings.read(k + STR_boolKeys[i], DataType_Boolean);
      if (Settings.lastReadOK && val !== null) P[STR_boolKeys[i]] = val;
   }
   for (i = 0; i < STR_strKeys.length; i++) {
      val = Settings.read(k + STR_strKeys[i], DataType_String);
      if (Settings.lastReadOK && val !== null) P[STR_strKeys[i]] = val;
   }
}

function STR_saveSettings(P) {
   var k = STR_settingsKey + "/";
   var i;
   for (i = 0; i < STR_numKeys.length; i++)
      Settings.write(k + STR_numKeys[i], DataType_Double, P[STR_numKeys[i]]);
   for (i = 0; i < STR_boolKeys.length; i++)
      Settings.write(k + STR_boolKeys[i], DataType_Boolean, P[STR_boolKeys[i]]);
   for (i = 0; i < STR_strKeys.length; i++)
      Settings.write(k + STR_strKeys[i], DataType_String, P[STR_strKeys[i]]);
}

// ---------------------------------------------------------------------------
// Sample I/O with typed arrays (Array fallback, as in FourierDeband)
// ---------------------------------------------------------------------------
function STR_readChannel(image, c) {
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

function STR_writeChannel(image, a, c) {
   var r = new Rect(0, 0, image.width, image.height);
   try { image.setSamples(a, r, c); }
   catch (e) {
      var t = new Array(a.length);
      for (var i = 0; i < a.length; ++i) t[i] = a[i];
      image.setSamples(t, r, c);
   }
}

// New float window holding `data`; diagnostic, no undo
function STR_showImage(id, data, W, H) {
   var win = new ImageWindow(W, H, 1, 32, true, false, id);
   win.mainView.beginProcess(UndoFlag_NoSwapFile);
   STR_writeChannel(win.mainView.image, data, 0);
   win.mainView.endProcess();
   win.show();
   return win;
}

// ---------------------------------------------------------------------------
// Debug dump: intermediate images as 32-bit float XISF + meta.json
// Region = first preview of the sub window if any, else the full frame.
// ---------------------------------------------------------------------------
function STR_writeText(path, text) {
   try { File.writeTextFile(path, text); return; } catch (e) {}
   var f = new File;
   f.createForWriting(path);
   f.outText(text);
   f.close();
}

function STR_pad2(n) { return (n < 10 ? "0" : "") + n; }

function STR_timeStamp() {
   var d = new Date();
   return d.getFullYear() + STR_pad2(d.getMonth() + 1) + STR_pad2(d.getDate()) + "-"
      + STR_pad2(d.getHours()) + STR_pad2(d.getMinutes()) + STR_pad2(d.getSeconds());
}

function STR_dumpRect(win, W, H) {
   var r = { x0: 0, y0: 0, w: W, h: H, preview: "" };
   try {
      var pv = win.previews;
      if (pv && pv.length > 0) {
         var pr = win.previewRect(pv[0]);
         var x0 = Math.max(0, Math.round(pr.x0)), y0 = Math.max(0, Math.round(pr.y0));
         var x1 = Math.min(W, Math.round(pr.x1)), y1 = Math.min(H, Math.round(pr.y1));
         if (x1 > x0 && y1 > y0) r = { x0: x0, y0: y0, w: x1 - x0, h: y1 - y0, preview: pv[0].id };
      }
   } catch (e) {}
   return r;
}

// Returns function(name, fullFrameArray) writing NN_name.xisf (cropped to rect);
// .files lists the written names, .ms the time spent writing.
function STR_makeDumper(folder, W, H, rect, log) {
   var n = 0;
   var fn = function(name, arr) {
      if (!arr) return;
      var t0 = Date.now();
      n++;
      var fname = STR_pad2(n) + "_" + name + ".xisf";
      try {
         var cw = rect.w, chh = rect.h, a = new Float32Array(cw * chh), x, y, o, s;
         for (y = 0; y < chh; y++) {
            o = y * cw; s = (y + rect.y0) * W + rect.x0;
            for (x = 0; x < cw; x++) a[o + x] = arr[s + x];
         }
         var win = new ImageWindow(cw, chh, 1, 32, true, false, "STR_dump");
         win.mainView.beginProcess(UndoFlag_NoSwapFile);
         STR_writeChannel(win.mainView.image, a, 0);
         win.mainView.endProcess();
         win.saveAs(folder + "/" + fname, false, false, false, false);
         win.forceClose();
         fn.files.push(fname);
      } catch (e) {
         if (log) log("  DUMP ERROR " + name + ": " + e.message);
      }
      fn.ms += Date.now() - t0;
   };
   fn.files = [];
   fn.ms = 0;
   return fn;
}

function STR_gridToArray(g) {
   var a = [], i;
   for (i = 0; i < g.length; i++) a.push(g[i]);
   return a;
}

// ---------------------------------------------------------------------------
// HISTORY keywords: 70-char chunks
// ---------------------------------------------------------------------------
function STR_writeHistory(view, P, st) {
   var full = "SatelliteTrailRemover v" + STR_VERSION
      + " block=" + P.blockSize + " win=" + P.halfWin
      + " tau=" + P.tau + (P.scaledPrior ? "s" : "L") + " clip=" + P.clipSigma + "x" + P.clipIter
      + (P.satGuard ? " sat=" + P.satLevel + "/" + P.satGrow : " sat=off")
      + " smooth=" + P.smoothRadius + " ramp=" + P.sigmaLow + "-" + P.sigmaHigh
      + " struct=" + P.structTol + " bright=" + P.brightTol + " grow=" + P.growRadius + " feather=" + P.featherRadius
      + (P.detectEnable ? " detect=z" + P.detectZ + "/blob" + P.blobMinLen + "x" + P.blobMinAspect
         + (P.lineRemoval ? "/lines" + P.alongWin : "") + (P.restrictToTrails ? "/restrict" : "") : "")
      + (st.detected ? " trail=" + (st.hasTrail ? "yes" : "no") + "(" + st.nLines + "L," + st.nBlobs + "B)" : "")
      + " touched=" + st.nAny + "px";
   var keywords = view.window.keywords, kept = [], i;
   // Replace previous STR* keywords (re-runs)
   for (i = 0; i < keywords.length; i++) {
      if (keywords[i].name !== "STRTRAIL" && keywords[i].name !== "STRNLINE" && keywords[i].name !== "STRZMAX")
         kept.push(keywords[i]);
   }
   keywords = kept;
   while (full.length > 0) {
      keywords.push(new FITSKeyword("HISTORY", "", full.substring(0, 70)));
      full = full.substring(70);
   }
   if (st.detected) {
      keywords.push(new FITSKeyword("STRTRAIL", st.hasTrail ? "T" : "F", "Satellite trail detected (SatelliteTrailRemover)"));
      keywords.push(new FITSKeyword("STRNLINE", "" + st.nLines, "Number of trail lines detected"));
      keywords.push(new FITSKeyword("STRZMAX", st.zMax.toFixed(1), "Max line detection score (z)"));
   }
   view.window.keywords = keywords;
}

// One-line description of a channel's trail detection result
function STR_trailSummary(tr) {
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

// ---------------------------------------------------------------------------
// Process one sub view in place.  Caller wraps in beginProcess/endProcess.
// Returns {nAny, nFull, aborted}
// ---------------------------------------------------------------------------
function STR_processImage(subView, stackView, P, log, dumpRoot) {
   var W = subView.image.width;
   var H = subView.image.height;
   var nCh = subView.image.numberOfChannels;
   var nChS = stackView.image.numberOfChannels;

   if (stackView.image.width !== W || stackView.image.height !== H) {
      throw new Error("Stack and sub dimensions do not match: "
         + W + "x" + H + " vs " + stackView.image.width + "x" + stackView.image.height);
   }

   var st = { nAny: 0, nFull: 0, aborted: false, detected: false, hasTrail: false,
              nLines: 0, nBlobs: 0, zMax: 0, details: "" };
   var baseId = subView.id;
   var ch, i;
   for (ch = 0; ch < nCh; ch++) {
      if (nCh > 1 && log) log("--- Channel " + ch + " ---");
      var sub = STR_readChannel(subView.image, ch);
      var stack = STR_readChannel(stackView.image, (ch < nChS) ? ch : nChS - 1);
      var sfx = (nCh > 1) ? "_ch" + ch : "";

      // Optional debug dump
      var dumper = null, dumpFolder = "", rect = null, lines = [], chLog = log;
      if (dumpRoot) {
         dumpFolder = dumpRoot + "/" + baseId + sfx + "_" + STR_timeStamp();
         if (!File.directoryExists(dumpFolder)) File.createDirectory(dumpFolder, true);
         rect = STR_dumpRect(subView.window, W, H);
         chLog = function(m) { lines.push(m); if (log) log(m); };
         chLog("Debug dump to " + dumpFolder + ", region " + rect.w + "x" + rect.h
            + " at (" + rect.x0 + "," + rect.y0 + ")"
            + (rect.preview ? " from preview " + rect.preview : " (full frame, no preview)"));
         dumper = STR_makeDumper(dumpFolder, W, H, rect, chLog);
      }

      var tC = Date.now();
      var res = STR_processChannel(sub, stack, W, H, P, chLog, dumper);
      tC = Date.now() - tC;
      stack = null;
      if (res.nAny > 0) STR_writeChannel(subView.image, sub, ch);   // unchanged image: nothing to write
      sub = null;
      st.nAny += res.nAny;
      st.nFull += res.nFull;
      if (res.trail) {
         st.detected = true;
         if (res.trail.hasTrail) st.hasTrail = true;
         st.nLines += res.trail.lines.length; st.nBlobs += res.trail.blobs.length;
         for (i = 0; i < res.trail.lines.length; i++) if (res.trail.lines[i].z > st.zMax) st.zMax = res.trail.lines[i].z;
         var dsc = STR_trailSummary(res.trail);
         if (dsc.length > 0) st.details += (st.details.length > 0 ? " | " : "") + (nCh > 1 ? "ch" + ch + ": " : "") + dsc;
      }

      if (dumper) {
         chLog("  time: channel total " + (tC / 1000).toFixed(1) + " s, of which dump writing "
            + (dumper.ms / 1000).toFixed(1) + " s");
         var Pc = {}, key;
         for (key in STR_defaults) if (STR_defaults.hasOwnProperty(key)) Pc[key] = P[key];
         var meta = {
            script: "SatelliteTrailRemover", version: STR_VERSION,
            subId: baseId, stackId: stackView.id, channel: ch, width: W, height: H,
            region: rect, params: Pc,
            stats: { nAny: res.nAny, nFull: res.nFull, removedFlux: res.removedFlux },
            trail: res.trail,
            grids: { BW: res.BW, BH: res.BH, blockSize: res.blockSize,
                     gain: STR_gridToArray(res.gainGrid), offset: STR_gridToArray(res.offsetGrid) },
            timeMs: tC, dumpMs: dumper.ms, files: dumper.files, log: lines
         };
         try { STR_writeText(dumpFolder + "/meta.json", JSON.stringify(meta, null, 1)); }
         catch (e) { chLog("  DUMP ERROR meta.json: " + e.message); }
      }
      if (P.wantDiff)    STR_showImage(baseId + "_diff" + sfx, res.diff, W, H);
      if (P.wantWeight)  STR_showImage(baseId + "_weight" + sfx, res.weight, W, H);
      if (P.wantRemoved && res.removed) STR_showImage(baseId + "_removed" + sfx, res.removed, W, H);
      if (P.wantGainMap) {
         // Displayed as gain/2: mid-grey = gain 1.0
         var g = STR_expandGrid(res.gainGrid, res.BW, res.BH, res.blockSize, W, H);
         for (i = 0; i < g.length; i++) g[i] *= 0.5;
         STR_showImage(baseId + "_gainmap" + sfx, g, W, H);
      }

      processEvents();
      if (console.abortRequested) { st.aborted = true; break; }
   }

   STR_writeHistory(subView, P, st);
   return st;
}

// ---------------------------------------------------------------------------
// Run on open images (in place, WITH undo: Ctrl+Z / History Explorer)
// ---------------------------------------------------------------------------
function STR_run(stackViewId, subViewIds, P) {
   var stackView = View.viewById(stackViewId);
   if (stackView.isNull) throw new Error("Stack view not found: " + stackViewId);

   var log = function(msg) { console.writeln(msg); };
   log("SatelliteTrailRemover v" + STR_VERSION);
   log("Stack: " + stackViewId);
   log("Processing " + subViewIds.length + " sub-exposure(s)");
   console.show();

   var dumpRoot = null;
   if (P.dumpEnable) {
      if (P.dumpDir.length === 0) {
         log("WARNING: debug dump enabled but no folder set; dump skipped.");
      } else {
         dumpRoot = P.dumpDir;
         if (dumpRoot.charAt(dumpRoot.length - 1) === "/") dumpRoot = dumpRoot.substring(0, dumpRoot.length - 1);
         if (!File.directoryExists(dumpRoot)) File.createDirectory(dumpRoot, true);
      }
   }

   var i, t0, st, summary = [];
   for (i = 0; i < subViewIds.length; i++) {
      log("\n=== Sub " + (i + 1) + "/" + subViewIds.length + ": " + subViewIds[i] + " ===");
      if (subViewIds[i] === stackViewId) { log("Skipping: this is the reference stack."); continue; }
      var subView = View.viewById(subViewIds[i]);
      if (subView.isNull) { log("WARNING: View not found: " + subViewIds[i] + ", skipping."); continue; }

      t0 = Date.now();
      // Default undo mode: the change is recorded in the view's history
      subView.beginProcess(UndoFlag_DefaultMode);
      try {
         st = STR_processImage(subView, stackView, P, log, dumpRoot);
      } finally {
         subView.endProcess();
      }
      log("Result: " + st.nAny + " px touched (" + st.nFull + " fully replaced), "
         + ((Date.now() - t0) / 1000).toFixed(1) + " s.  Undo with Ctrl+Z.");
      summary.push({ name: subViewIds[i], st: st });
      if (st.aborted || console.abortRequested) { log("Aborted by user."); break; }
   }
   STR_logSummary(summary, log);
   log("\nDone.");
}

// Trail summary table (console)
function STR_logSummary(rows, log) {
   if (rows.length === 0 || !rows[0].st.detected) return;
   var i, n = 0, st;
   log("\n--- Trail detection summary ---");
   for (i = 0; i < rows.length; i++) {
      st = rows[i].st;
      if (st.hasTrail) n++;
      log((st.hasTrail ? "TRAIL  " : "clean  ") + rows[i].name + "  lines=" + st.nLines + " blobs=" + st.nBlobs
         + (st.nLines > 0 ? " zmax=" + st.zMax.toFixed(1) : "") + "  modified px=" + st.nAny
         + (st.details ? "  [" + st.details + "]" : ""));
   }
   log(n + " of " + rows.length + " frame(s) with trail(s).");
}

// CSV report (batch mode)
function STR_writeReport(path, rows) {
   var out = ["file,trail,lines,blobs,zmax,modified_px,details"], i, st;
   for (i = 0; i < rows.length; i++) {
      st = rows[i].st;
      out.push('"' + rows[i].name.replace(/"/g, "'") + '",' + (st.hasTrail ? 1 : 0) + "," + st.nLines + ","
         + st.nBlobs + "," + st.zMax.toFixed(1) + "," + st.nAny + ',"' + st.details.replace(/"/g, "'") + '"');
   }
   STR_writeText(path, out.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Batch: open files from disk, process, save with suffix, close.
// Originals are never modified, so no undo data is kept.
// ---------------------------------------------------------------------------
function STR_runBatch(stackViewId, filePaths, P) {
   var stackView = View.viewById(stackViewId);
   if (stackView.isNull) throw new Error("Stack view not found: " + stackViewId);

   var log = function(msg) { console.writeln(msg); };
   log("SatelliteTrailRemover v" + STR_VERSION + " BATCH MODE");
   log("Stack: " + stackViewId);
   log("Processing " + filePaths.length + " file(s) from: " + P.batchDir);
   console.show();

   // No diagnostic windows in batch mode
   var PB = {}, key;
   for (key in P) if (P.hasOwnProperty(key)) PB[key] = P[key];
   PB.wantDiff = PB.wantWeight = PB.wantRemoved = PB.wantGainMap = false;

   var i, st, summary = [];
   for (i = 0; i < filePaths.length; i++) {
      log("\n=== File " + (i + 1) + "/" + filePaths.length + ": " + filePaths[i] + " ===");
      var wins = ImageWindow.open(filePaths[i]);
      if (!wins || wins.length === 0) { log("WARNING: Could not open: " + filePaths[i] + ", skipping."); continue; }
      var win = wins[0];
      var subView = win.mainView;
      try {
         subView.beginProcess(UndoFlag_NoSwapFile);
         try {
            st = STR_processImage(subView, stackView, PB, log);
         } finally {
            subView.endProcess();
         }
         var dir = File.extractDrive(filePaths[i]) + File.extractDirectory(filePaths[i]);
         var outPath = dir + "/" + File.extractName(filePaths[i]) + P.batchSuffix
            + File.extractExtension(filePaths[i]);
         win.saveAs(outPath, false, false, false, false);
         log("Result: " + st.nAny + " px touched (" + st.nFull + " fully replaced). Saved: " + outPath
            + (st.detected && !st.hasTrail && P.restrictToTrails ? " (no trail: unchanged copy)" : ""));
         summary.push({ name: File.extractName(filePaths[i]) + File.extractExtension(filePaths[i]), st: st });
      } catch (e) {
         log("ERROR on " + filePaths[i] + ": " + e.message);
      }
      win.forceClose();

      processEvents();
      if (console.abortRequested) { log("Aborted by user."); break; }
   }
   STR_logSummary(summary, log);
   if (summary.length > 0 && summary[0].st.detected) {
      var rp = P.batchDir + (P.batchDir.charAt(P.batchDir.length - 1) === "/" ? "" : "/") + "SatelliteTrailRemover_report.csv";
      try { STR_writeReport(rp, summary); log("Report: " + rp); }
      catch (e) { log("WARNING: could not write report " + rp + ": " + e.message); }
   }
   log("\nBatch done.");
}


// ===========================================================================
// WeightedBatchPreprocessing (WBPP) compatibility mode (v2.7)
//
// the .xisf files of <root>/registered/<group> are the registered lights of each group;
// <root>/master/master<group>.xisf is the full-size (not _autocrop) integration
// of that group, used as reference (its first image, "integration").
// For every registered frame in which a trail is detected:
//    cleaned image  -> <name>_STRtmp.xisf      (written first)
//    original .xisf -> <name>.sat              (renamed, kept as backup)
//    _STRtmp.xisf   -> <name>.xisf             (cleaned version in place)
// Frames without trail are not touched.  A frame with an existing .sat is
// skipped (already cleaned).  Restore mode puts every .sat back as .xisf.
// The .xnml / .xdrz side files reference frames by name and stay valid.
// ===========================================================================
var STR_WBPP_TMP = "_STRtmp";

function STR_listDir(dir, wantDirs, ext) {
   var out = [], ff = new FileFind, nm;
   if (ff.begin(dir + "/" + "*")) {   // never write slash-star: the PJSR preprocessor reads it as a comment
      do {
         nm = ff.name;
         if (nm === "." || nm === "..") continue;
         if (wantDirs) { if (ff.isDirectory) out.push(nm); }
         else if (!ff.isDirectory && (!ext || File.extractExtension(nm).toLowerCase() === ext)) out.push(nm);
      } while (ff.next());
   }
   out.sort();
   return out;
}

// Full-size master of a WBPP group (never the _autocrop one)
function STR_wbppMaster(masterDir, group) {
   var exact = masterDir + "/master" + group + ".xisf";
   if (File.exists(exact)) return exact;
   var files = STR_listDir(masterDir, false, ".xisf"), i, nm;
   for (i = 0; i < files.length; i++) {
      nm = files[i];
      if (nm.indexOf("master") === 0 && nm.indexOf(group) >= 0 && nm.indexOf("autocrop") < 0)
         return masterDir + "/" + nm;
   }
   return null;
}

// Opens the integration image of a master file; returns its window (others closed)
function STR_openMaster(path) {
   var wins = ImageWindow.open(path), keep = null, i;
   if (!wins || wins.length === 0) return null;
   for (i = 0; i < wins.length; i++) if (wins[i].mainView.id.indexOf("integration") >= 0) { keep = wins[i]; break; }
   if (keep === null) keep = wins[0];
   for (i = 0; i < wins.length; i++) if (wins[i] !== keep) wins[i].forceClose();
   return keep;
}

function STR_runWBPP(root, P, restore) {
   var log = function(msg) { console.writeln(msg); };
   if (root.charAt(root.length - 1) === "/") root = root.substring(0, root.length - 1);
   var regDir = root + "/registered", masDir = root + "/master";
   console.show();
   log("SatelliteTrailRemover v" + STR_VERSION + " WBPP MODE" + (restore ? " (RESTORE ORIGINALS)" : ""));
   log("WBPP output: " + root);
   if (!File.directoryExists(regDir)) { console.criticalln("Not a WBPP output folder (no 'registered' sub-folder): " + root); return; }
   var groups = STR_listDir(regDir, true, null), g, i, f, gdir;

   // ---- Restore: .sat -> .xisf ----
   if (restore) {
      var nRest = 0;
      for (g = 0; g < groups.length; g++) {
         gdir = regDir + "/" + groups[g];
         var sats = STR_listDir(gdir, false, ".sat");
         for (i = 0; i < sats.length; i++) {
            var base = gdir + "/" + File.extractName(sats[i]);
            try {
               if (File.exists(base + ".xisf")) File.remove(base + ".xisf");
               File.move(base + ".sat", base + ".xisf");
               nRest++;
               log("Restored: " + base + ".xisf");
            } catch (e) { log("ERROR restoring " + base + ".sat: " + e.message); }
         }
      }
      log("\n" + nRest + " original frame(s) restored.");
      return;
   }

   // ---- Clean ----
   var PB = {}, key;
   for (key in P) if (P.hasOwnProperty(key)) PB[key] = P[key];
   PB.wantDiff = PB.wantWeight = PB.wantRemoved = PB.wantGainMap = false;
   PB.detectEnable = true; PB.restrictToTrails = true;   // only frames with a trail are rewritten
   var rows = [], nClean = 0, nTrail = 0, aborted = false;
   for (g = 0; g < groups.length && !aborted; g++) {
      gdir = regDir + "/" + groups[g];
      var frames = STR_listDir(gdir, false, ".xisf"), list = [];
      for (i = 0; i < frames.length; i++) if (File.extractName(frames[i]).indexOf(STR_WBPP_TMP) < 0) list.push(frames[i]);
      log("\n##### Group " + (g + 1) + "/" + groups.length + ": " + groups[g] + " (" + list.length + " frame(s))");
      if (list.length === 0) continue;
      var mPath = STR_wbppMaster(masDir, groups[g]);
      if (mPath === null) { log("WARNING: no full-size master found for this group in " + masDir + ", group skipped."); continue; }
      log("Reference: " + mPath);
      var mWin = STR_openMaster(mPath);
      if (mWin === null) { log("WARNING: could not open " + mPath + ", group skipped."); continue; }
      try {
         for (i = 0; i < list.length; i++) {
            f = gdir + "/" + list[i];
            var base2 = gdir + "/" + File.extractName(list[i]), satPath = base2 + ".sat";
            var row = { group: groups[g], name: list[i], st: null, action: "" };
            log("\n=== " + groups[g] + "  " + (i + 1) + "/" + list.length + ": " + list[i]);
            if (File.exists(satPath)) {
               log("Already cleaned (" + File.extractName(list[i]) + ".sat exists): skipped.");
               row.action = "skipped (already cleaned)"; rows.push(row); continue;
            }
            var wins = ImageWindow.open(f);
            if (!wins || wins.length === 0) { log("WARNING: could not open, skipped."); row.action = "error: open"; rows.push(row); continue; }
            var win = wins[0], st;
            for (var k2 = 1; k2 < wins.length; k2++) wins[k2].forceClose();
            try {
               win.mainView.beginProcess(UndoFlag_NoSwapFile);
               try { st = STR_processImage(win.mainView, mWin.mainView, PB, log); }
               finally { win.mainView.endProcess(); }
               row.st = st;
               if (st.hasTrail && st.nAny > 0) {
                  var tmp = base2 + STR_WBPP_TMP + ".xisf";
                  if (File.exists(tmp)) File.remove(tmp);
                  win.saveAs(tmp, false, false, false, false);   // 1. cleaned copy
                  win.forceClose(); win = null;
                  File.move(f, satPath);                           // 2. original -> .sat
                  File.move(tmp, f);                               // 3. cleaned -> .xisf
                  nTrail++;
                  row.action = "cleaned (original -> .sat)";
                  log("Trail removed: original kept as " + File.extractName(list[i]) + ".sat");
               } else {
                  row.action = "no trail (untouched)";
                  nClean++;
               }
            } catch (e) {
               row.action = "error: " + e.message;
               log("ERROR: " + e.message);
            }
            if (win !== null) win.forceClose();
            rows.push(row);
            processEvents();
            if (console.abortRequested) { log("Aborted by user."); aborted = true; break; }
         }
      } finally {
         mWin.forceClose();
      }
   }

   // ---- Report ----
   var out = ["group,file,trail,lines,blobs,zmax,modified_px,action,details"], r, s2;
   for (i = 0; i < rows.length; i++) {
      r = rows[i]; s2 = r.st;
      out.push('"' + r.group + '","' + r.name.replace(/"/g, "'") + '",'
         + (s2 ? (s2.hasTrail ? 1 : 0) + "," + s2.nLines + "," + s2.nBlobs + "," + s2.zMax.toFixed(1) + "," + s2.nAny
               : ",,,,")
         + ',"' + r.action + '","' + (s2 ? s2.details.replace(/"/g, "'") : "") + '"');
   }
   var rp = root + "/SatelliteTrailRemover_WBPP_report.csv";
   try { STR_writeText(rp, out.join("\n") + "\n"); log("\nReport: " + rp); }
   catch (e2) { log("WARNING: could not write report " + rp + ": " + e2.message); }
   log("\n--- WBPP summary ---");
   for (i = 0; i < rows.length; i++) {
      if (rows[i].st && rows[i].st.hasTrail)
         log("TRAIL  " + rows[i].group + "/" + rows[i].name + "  [" + rows[i].st.details + "]");
   }
   log(nTrail + " frame(s) cleaned (originals renamed .sat), " + nClean + " frame(s) without trail left untouched.");
   log("Done.");
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
function STR_Dialog() {
   this.__base__ = Dialog;
   this.__base__();
   var d = this;

   this.windowTitle = "SatelliteTrailRemover v" + STR_VERSION;
   this.minWidth = 500;

   function numCtrl(parent, label, lo, hi, prec, steps, tip) {
      var c = new NumericControl(parent);
      c.label.text = label;
      c.label.minWidth = 170;
      c.setRange(lo, hi);
      c.slider.setRange(0, steps);
      c.setPrecision(prec);
      c.toolTip = tip;
      return c;
   }

   // ---- Collapsible sections (v2.8): all groups expanded need ~1100 px of height ----
   this.sectionBars = [];
   function onToggle(bar, toggleBegin) {
      if (toggleBegin) { bar.expandedState = !bar.expandedState; return; }
      d.setVariableHeight();
      d.adjustToContents();
      d.setMinHeight();
   }
   function makeSection(key, title, withCheck, tip) {
      var ctrl = new Control(d);
      var bar = new SectionBar(d, title);
      if (withCheck) bar.enableCheckBox();
      bar.setSection(ctrl);
      bar.onToggleSection = onToggle;
      bar.sectionKey = key;
      bar.expandedState = true;
      if (tip) { bar.toolTip = tip; if (withCheck) bar.checkBox.toolTip = tip; }
      d.sectionBars.push(bar);
      return bar;
   }

   // ---- Stack selector ----
   this.stackLabel = new Label(this);
   this.stackLabel.text = "Reference stack:";
   this.stackLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.stackCombo = new ComboBox(this);
   this.stackCombo.editEnabled = false;
   var views = ImageWindow.windows;
   var vi;
   for (vi = 0; vi < views.length; vi++) this.stackCombo.addItem(views[vi].mainView.id);

   this.stackSizer = new HorizontalSizer;
   this.stackSizer.spacing = 6;
   this.stackSizer.add(this.stackLabel);
   this.stackSizer.add(this.stackCombo, 100);

   // ---- Sub-exposure selector ----
   this.subLabel = new Label(this);
   this.subLabel.text = "Sub-exposures (select from open images; modified in place, undoable):";

   this.subTree = new TreeBox(this);
   this.subTree.multipleSelection = true;
   this.subTree.headerVisible = false;
   this.subTree.numberOfColumns = 1;
   this.subTree.setMinSize(400, 120);
   for (vi = 0; vi < views.length; vi++) {
      var node = new TreeBoxNode(this.subTree);
      node.setText(0, views[vi].mainView.id);
   }

   // ---- Adaptive match ----
   this.adaptBar = makeSection("adapt", "Adaptive Match (stack -> sub)", false, "");
   this.adaptGroup = this.adaptBar.section;

   this.blockSizeCtrl = numCtrl(this.adaptGroup, "Block size (px):", 8, 256, 0, 248,
      "Size of grid blocks for local gain/offset estimation.");
   this.halfWinCtrl = numCtrl(this.adaptGroup, "Half window (blocks):", 0, 32, 0, 32,
      "Half-width of the sliding window (in blocks) for the windowed least-squares. "
      + "Effective window = blockSize * (2*halfWin+1) px.");
   this.tauCtrl = numCtrl(this.adaptGroup, "Bayesian tau:", 0.01, 1.0, 2, 99,
      "Width of the prior N(1, tau^2) on the gain. Smaller = gain held closer to 1.");
   this.clipSigmaCtrl = numCtrl(this.adaptGroup, "Clip sigma:", 1.0, 10.0, 1, 90,
      "Pixels whose residual deviates by more than this are excluded from the gain/offset fit "
      + "(keeps trails and stars from biasing the match).");
   this.clipIterCtrl = numCtrl(this.adaptGroup, "Clip iterations:", 0, 10, 0, 10,
      "Number of sigma-clipping refinement iterations of the fit.");

   this.adaptGroup.sizer = new VerticalSizer;
   this.adaptGroup.sizer.margin = 6;
   this.adaptGroup.sizer.spacing = 4;
   this.adaptGroup.sizer.add(this.blockSizeCtrl);
   this.adaptGroup.sizer.add(this.halfWinCtrl);
   this.adaptGroup.sizer.add(this.tauCtrl);
   this.adaptGroup.sizer.add(this.clipSigmaCtrl);
   this.adaptGroup.sizer.add(this.clipIterCtrl);

   this.scaledPriorCheck = new CheckBox(this.adaptGroup);
   this.scaledPriorCheck.text = "Scale-aware gain prior (fit the gain)";
   this.scaledPriorCheck.toolTip = "On (v2.3): the gain prior is weighed against the noise, so the "
      + "local gain is really fitted (stars on a trail are replaced at the sub's brightness). "
      + "Off: v2.0-2.2 behaviour, gain pinned at 1 (offset-only match).";
   this.adaptGroup.sizer.add(this.scaledPriorCheck);

   // ---- Residual subtraction ----
   this.subtrBar = makeSection("subtr", "Residual Subtraction (corrected = sub - w * residual)", false, "");
   this.subtrGroup = this.subtrBar.section;

   this.smoothRadiusCtrl = numCtrl(this.subtrGroup, "Smoothing radius (px):", 0, 10, 0, 10,
      "Box radius used to smooth the residual before measuring its significance. "
      + "Larger = more sensitive to faint, wide trails; less sensitive to single pixels.");
   this.sigmaLowCtrl = numCtrl(this.subtrGroup, "Lower sigma:", 1.0, 20.0, 1, 190,
      "Significance of the smoothed residual where subtraction starts (w = 0).");
   this.sigmaHighCtrl = numCtrl(this.subtrGroup, "Upper sigma:", 1.0, 40.0, 1, 390,
      "Significance of the smoothed residual where subtraction is full (w = 1).");
   this.structTolCtrl = numCtrl(this.subtrGroup, "Structure tolerance:", 0, 3, 2, 300,
      "Protects stars and other structure already present in the reference: the noise "
      + "used for the significance becomes sqrt(sigma^2 + (tol * local structure)^2). "
      + "Trails are absent from the reference, so they are not protected. "
      + "0 = off (star cores with PSF mismatch get replaced by the reference).");
   this.brightTolCtrl = numCtrl(this.subtrGroup, "Brightness tolerance:", 0, 0.5, 3, 500,
      "Protects smooth bright light already present in the reference (halos, diffraction "
      + "spikes and bleed of bright stars, bright nebula/galaxy cores): the residual must exceed "
      + "this fraction of the local light above the sky to be subtracted. Trails on dark sky are "
      + "unaffected. 0 = off (v2.4 behaviour).");
   this.growRadiusCtrl = numCtrl(this.subtrGroup, "Grow radius (px):", 0, 30, 0, 30,
      "Dilation of the weight map to include the faint wings of the trails.");
   this.featherRadiusCtrl = numCtrl(this.subtrGroup, "Feather radius (px):", 0, 20, 0, 20,
      "Box blur of the weight map for a seamless transition. Keep <= grow radius "
      + "so thin trails are still fully subtracted.");

   this.subtrGroup.sizer = new VerticalSizer;
   this.subtrGroup.sizer.margin = 6;
   this.subtrGroup.sizer.spacing = 4;
   this.subtrGroup.sizer.add(this.smoothRadiusCtrl);
   this.subtrGroup.sizer.add(this.sigmaLowCtrl);
   this.subtrGroup.sizer.add(this.sigmaHighCtrl);
   this.subtrGroup.sizer.add(this.structTolCtrl);
   this.subtrGroup.sizer.add(this.brightTolCtrl);
   this.subtrGroup.sizer.add(this.growRadiusCtrl);
   this.subtrGroup.sizer.add(this.featherRadiusCtrl);

   this.satGuardCheck = new CheckBox(this.subtrGroup);
   this.satGuardCheck.text = "Saturation guard (never modify saturated stars)";
   this.satGuardCheck.toolTip = "Pixels where the sub or the stack is at or above the level, plus "
      + "the grow radius, are never modified. Saturated cores otherwise give large meaningless "
      + "residuals and get replaced.";
   this.satLevelCtrl = numCtrl(this.subtrGroup, "Saturation level:", 0.5, 1.0, 3, 500,
      "Normalised level considered saturated (sub or stack).");
   this.satGrowCtrl = numCtrl(this.subtrGroup, "Saturation grow (px):", 0, 50, 0, 50,
      "Dilation around saturated pixels (interpolation ringing, blooming).");
   this.satGuardCheck.onCheck = function(checked) {
      d.satLevelCtrl.enabled = checked;
      d.satGrowCtrl.enabled = checked;
   };
   this.subtrGroup.sizer.add(this.satGuardCheck);
   this.subtrGroup.sizer.add(this.satLevelCtrl);
   this.subtrGroup.sizer.add(this.satGrowCtrl);


   // ---- Trail detection (v2.6) ----
   this.detectBar = makeSection("detect", "Trail Detection (frame level)", true,
      "Checkbox: detect trails (line search on the residual + elongated blobs). "
      + "Matched-filter line search on the 16x binned residual (z = line sum / "
      + "sqrt(length)) plus long thin blobs of the weight map. Reported in the console, as FITS "
      + "keywords STRTRAIL / STRNLINE / STRZMAX, and in a CSV report in batch mode. "
      + "Off = v2.5 behaviour.");
   this.detectGroup = this.detectBar.section;
   this.detectCheck = this.detectBar.checkBox;
   this.detectZCtrl = numCtrl(this.detectGroup, "Line threshold (z):", 5, 100, 1, 950,
      "Detection threshold of the line search. On NGC6729 Blue: trails 19-54, other frames <= 11.");
   this.blobMinLenCtrl = numCtrl(this.detectGroup, "Blob min length (px):", 50, 5000, 0, 495,
      "A weight-map blob counts as a trail if at least this long ...");
   this.blobMinAspectCtrl = numCtrl(this.detectGroup, "Blob min length/width:", 2, 100, 1, 980,
      "... and at least this elongated (short or bright trails, e.g. at the frame edge).");
   this.lineRemovalCheck = new CheckBox(this.detectGroup);
   this.lineRemovalCheck.text = "Remove detected lines with an along-track model";
   this.lineRemovalCheck.toolTip = "Along each detected line, the trail is modelled as the residual "
      + "averaged along the track (stars, hot pixels, saturated pixels excluded) and subtracted. "
      + "Removes faint trails the per-pixel weight cannot reach; stars under the trail keep their own "
      + "signal (only the trail is removed).";
   this.alongWinCtrl = numCtrl(this.detectGroup, "Along-track half window (px):", 8, 512, 0, 504,
      "Averaging length along the trail. Smaller follows brightness changes (flares) better, "
      + "larger is less noisy.");
   this.restrictCheck = new CheckBox(this.detectGroup);
   this.restrictCheck.text = "Only modify detected trails (frames without trail are left untouched)";
   this.restrictCheck.toolTip = "Off: the per-pixel correction also applies elsewhere (hot pixels, "
      + "cosmics, star mismatches in bad-seeing frames).";
   this.detectCheck.onCheck = function(checked) { d.detectGroup.enabled = checked; };
   this.detectGroup.sizer = new VerticalSizer;
   this.detectGroup.sizer.margin = 6;
   this.detectGroup.sizer.spacing = 4;
   this.detectGroup.sizer.add(this.detectZCtrl);
   this.detectGroup.sizer.add(this.blobMinLenCtrl);
   this.detectGroup.sizer.add(this.blobMinAspectCtrl);
   this.detectGroup.sizer.add(this.lineRemovalCheck);
   this.detectGroup.sizer.add(this.alongWinCtrl);
   this.detectGroup.sizer.add(this.restrictCheck);

   // ---- Diagnostic outputs ----
   this.outputBar = makeSection("output", "Diagnostic Outputs (interactive mode only)", false, "");
   this.outputGroup = this.outputBar.section;

   this.wantDiffCheck = new CheckBox(this.outputGroup);
   this.wantDiffCheck.text = "Residual (sub - gain*stack - offset)";
   this.wantWeightCheck = new CheckBox(this.outputGroup);
   this.wantWeightCheck.text = "Weight map w";
   this.wantRemovedCheck = new CheckBox(this.outputGroup);
   this.wantRemovedCheck.text = "Removed component (sub - corrected)";
   this.wantGainCheck = new CheckBox(this.outputGroup);
   this.wantGainCheck.text = "Gain map (shown as gain/2)";

   this.outputGroup.sizer = new VerticalSizer;
   this.outputGroup.sizer.margin = 6;
   this.outputGroup.sizer.spacing = 4;
   this.outputGroup.sizer.add(this.wantDiffCheck);
   this.outputGroup.sizer.add(this.wantWeightCheck);
   this.outputGroup.sizer.add(this.wantRemovedCheck);
   this.outputGroup.sizer.add(this.wantGainCheck);

   // ---- Debug dump ----
   this.dumpBar = makeSection("dump", "Debug Dump (interactive mode only)", true,
      "Checkbox: dump inputs and intermediate images (32-bit XISF + meta.json). "
      + "Writes sub, stack, residual, structure map, smoothed residual, "
      + "significance, weights, saturation mask, removed and corrected images to a new "
      + "sub-folder per sub. Define a preview on the sub to dump only that region "
      + "(strongly recommended: full frames are ~245 MB each, ~20 files).");
   this.dumpGroup = this.dumpBar.section;
   this.dumpCheck = this.dumpBar.checkBox;
   this.dumpCheck.onCheck = function(checked) { d.dumpGroup.enabled = checked; };

   this.dumpHint = new Label(this.dumpGroup);
   this.dumpHint.text = "Tip: put a preview on the sub over a trail and a few touched stars.";

   this.dumpDirLabel = new Label(this.dumpGroup);
   this.dumpDirLabel.text = "Folder:";
   this.dumpDirEdit = new Edit(this.dumpGroup);
   this.dumpDirEdit.setMinWidth(300);
   this.dumpDirButton = new ToolButton(this.dumpGroup);
   this.dumpDirButton.icon = this.scaledResource(":/browser/select-file.png");
   this.dumpDirButton.setScaledFixedSize(22, 22);
   this.dumpDirButton.onClick = function() {
      var dir = new GetDirectoryDialog;
      dir.caption = "Select debug dump folder";
      if (d.dumpDirEdit.text.length > 0) dir.initialPath = d.dumpDirEdit.text;
      if (dir.execute()) d.dumpDirEdit.text = dir.directory;
   };

   this.dumpDirSizer = new HorizontalSizer;
   this.dumpDirSizer.spacing = 4;
   this.dumpDirSizer.add(this.dumpDirLabel);
   this.dumpDirSizer.add(this.dumpDirEdit, 100);
   this.dumpDirSizer.add(this.dumpDirButton);

   this.dumpGroup.sizer = new VerticalSizer;
   this.dumpGroup.sizer.margin = 6;
   this.dumpGroup.sizer.spacing = 4;
   this.dumpGroup.sizer.add(this.dumpHint);
   this.dumpGroup.sizer.add(this.dumpDirSizer);

   // ---- WBPP compatibility mode (v2.7) ----
   this.wbppBar = makeSection("wbpp", "WBPP Mode (clean a WBPP output folder)", true,
      "Checkbox: clean a WeightedBatchPreprocessing output folder (registered frames vs. masters). "
      + "Uses the .xisf frames of <folder>/registered/<group> and the full-size masters "
      + "<folder>/master/master<group>.xisf (not _autocrop) as reference. Frames with a detected "
      + "trail: the original is renamed .sat and the cleaned frame takes its .xisf name, so a new "
      + "ImageIntegration run ingests the cleaned frames. Frames without trail are untouched; "
      + "frames already cleaned (.sat present) are skipped. No reference stack needs to be open.");
   this.wbppGroup = this.wbppBar.section;
   this.wbppCheck = this.wbppBar.checkBox;
   this.wbppDirLabel = new Label(this.wbppGroup);
   this.wbppDirLabel.text = "WBPP folder:";
   this.wbppDirEdit = new Edit(this.wbppGroup);
   this.wbppDirEdit.setMinWidth(300);
   this.wbppDirButton = new ToolButton(this.wbppGroup);
   this.wbppDirButton.icon = this.scaledResource(":/browser/select-file.png");
   this.wbppDirButton.setScaledFixedSize(22, 22);
   this.wbppDirButton.onClick = function() {
      var dir = new GetDirectoryDialog;
      dir.caption = "Select the WBPP output folder (contains 'registered' and 'master')";
      if (d.wbppDirEdit.text.length > 0) dir.initialPath = d.wbppDirEdit.text;
      if (dir.execute()) d.wbppDirEdit.text = dir.directory;
   };
   this.wbppRestoreCheck = new CheckBox(this.wbppGroup);
   this.wbppRestoreCheck.text = "Restore originals instead (.sat -> .xisf, cleaned frames deleted)";
   this.wbppRestoreCheck.checked = false;
   this.wbppDirSizer = new HorizontalSizer;
   this.wbppDirSizer.spacing = 4;
   this.wbppDirSizer.add(this.wbppDirLabel);
   this.wbppDirSizer.add(this.wbppDirEdit, 100);
   this.wbppDirSizer.add(this.wbppDirButton);
   this.wbppCheck.onCheck = function(checked) { d.wbppGroup.enabled = checked; };
   this.wbppGroup.sizer = new VerticalSizer;
   this.wbppGroup.sizer.margin = 6;
   this.wbppGroup.sizer.spacing = 4;
   this.wbppGroup.sizer.add(this.wbppDirSizer);
   this.wbppGroup.sizer.add(this.wbppRestoreCheck);

   // ---- Batch mode ----
   this.batchBar = makeSection("batch", "Batch Mode (process a folder)", true,
      "Checkbox: process all FITS/XISF files in a directory instead of the "
      + "selected open images, against the reference stack. Results are saved with the "
      + "suffix; originals untouched.");
   this.batchGroup = this.batchBar.section;
   this.batchCheck = this.batchBar.checkBox;
   this.batchCheck.onCheck = function(checked) { d.batchGroup.enabled = checked; };

   this.batchDirLabel = new Label(this.batchGroup);
   this.batchDirLabel.text = "Directory:";
   this.batchDirEdit = new Edit(this.batchGroup);
   this.batchDirEdit.setMinWidth(300);
   this.batchDirButton = new ToolButton(this.batchGroup);
   this.batchDirButton.icon = this.scaledResource(":/browser/select-file.png");
   this.batchDirButton.setScaledFixedSize(22, 22);
   this.batchDirButton.onClick = function() {
      var dir = new GetDirectoryDialog;
      dir.caption = "Select directory of registered sub-exposures";
      if (d.batchDirEdit.text.length > 0) dir.initialPath = d.batchDirEdit.text;
      if (dir.execute()) d.batchDirEdit.text = dir.directory;
   };

   this.batchSuffixLabel = new Label(this.batchGroup);
   this.batchSuffixLabel.text = "Output suffix:";
   this.batchSuffixEdit = new Edit(this.batchGroup);
   this.batchSuffixEdit.setFixedWidth(120);

   this.batchDirSizer = new HorizontalSizer;
   this.batchDirSizer.spacing = 4;
   this.batchDirSizer.add(this.batchDirLabel);
   this.batchDirSizer.add(this.batchDirEdit, 100);
   this.batchDirSizer.add(this.batchDirButton);

   this.batchSuffixSizer = new HorizontalSizer;
   this.batchSuffixSizer.spacing = 4;
   this.batchSuffixSizer.add(this.batchSuffixLabel);
   this.batchSuffixSizer.add(this.batchSuffixEdit);
   this.batchSuffixSizer.addStretch();

   this.batchGroup.sizer = new VerticalSizer;
   this.batchGroup.sizer.margin = 6;
   this.batchGroup.sizer.spacing = 4;
   this.batchGroup.sizer.add(this.batchDirSizer);
   this.batchGroup.sizer.add(this.batchSuffixSizer);

   // ---- Parameter transfer ----
   this.setParams = function(P) {
      d.blockSizeCtrl.setValue(P.blockSize);
      d.halfWinCtrl.setValue(P.halfWin);
      d.tauCtrl.setValue(P.tau);
      d.clipSigmaCtrl.setValue(P.clipSigma);
      d.clipIterCtrl.setValue(P.clipIter);
      d.scaledPriorCheck.checked = P.scaledPrior;
      d.satGuardCheck.checked = P.satGuard;
      d.satLevelCtrl.setValue(P.satLevel);
      d.satGrowCtrl.setValue(P.satGrow);
      d.satGuardCheck.onCheck(P.satGuard);
      d.smoothRadiusCtrl.setValue(P.smoothRadius);
      d.sigmaLowCtrl.setValue(P.sigmaLow);
      d.sigmaHighCtrl.setValue(P.sigmaHigh);
      d.structTolCtrl.setValue(P.structTol);
      d.brightTolCtrl.setValue(P.brightTol);
      d.growRadiusCtrl.setValue(P.growRadius);
      d.featherRadiusCtrl.setValue(P.featherRadius);
      d.detectZCtrl.setValue(P.detectZ);
      d.blobMinLenCtrl.setValue(P.blobMinLen);
      d.blobMinAspectCtrl.setValue(P.blobMinAspect);
      d.lineRemovalCheck.checked = P.lineRemoval;
      d.alongWinCtrl.setValue(P.alongWin);
      d.restrictCheck.checked = P.restrictToTrails;
      d.detectCheck.checked = P.detectEnable;
      d.detectCheck.onCheck(P.detectEnable);
      d.wantDiffCheck.checked = P.wantDiff;
      d.wantWeightCheck.checked = P.wantWeight;
      d.wantRemovedCheck.checked = P.wantRemoved;
      d.wantGainCheck.checked = P.wantGainMap;
      d.batchDirEdit.text = P.batchDir;
      d.batchSuffixEdit.text = P.batchSuffix;
      d.wbppDirEdit.text = P.wbppDir;
      d.wbppCheck.checked = P.wbppEnable;
      d.wbppCheck.onCheck(P.wbppEnable);
      d.dumpCheck.checked = P.dumpEnable;
      d.dumpCheck.onCheck(P.dumpEnable);
      d.dumpDirEdit.text = P.dumpDir;
   };
   this.getParams = function(P) {
      P.blockSize     = Math.round(d.blockSizeCtrl.value);
      P.halfWin       = Math.round(d.halfWinCtrl.value);
      P.tau           = d.tauCtrl.value;
      P.clipSigma     = d.clipSigmaCtrl.value;
      P.clipIter      = Math.round(d.clipIterCtrl.value);
      P.scaledPrior   = d.scaledPriorCheck.checked;
      P.satGuard      = d.satGuardCheck.checked;
      P.satLevel      = d.satLevelCtrl.value;
      P.satGrow       = Math.round(d.satGrowCtrl.value);
      P.smoothRadius  = Math.round(d.smoothRadiusCtrl.value);
      P.sigmaLow      = d.sigmaLowCtrl.value;
      P.sigmaHigh     = d.sigmaHighCtrl.value;
      P.structTol     = d.structTolCtrl.value;
      P.brightTol     = d.brightTolCtrl.value;
      P.growRadius    = Math.round(d.growRadiusCtrl.value);
      P.featherRadius = Math.round(d.featherRadiusCtrl.value);
      P.detectEnable  = d.detectCheck.checked;
      P.detectZ       = d.detectZCtrl.value;
      P.blobMinLen    = Math.round(d.blobMinLenCtrl.value);
      P.blobMinAspect = d.blobMinAspectCtrl.value;
      P.lineRemoval   = d.lineRemovalCheck.checked;
      P.alongWin      = Math.round(d.alongWinCtrl.value);
      P.restrictToTrails = d.restrictCheck.checked;
      P.wantDiff      = d.wantDiffCheck.checked;
      P.wantWeight    = d.wantWeightCheck.checked;
      P.wantRemoved   = d.wantRemovedCheck.checked;
      P.wantGainMap   = d.wantGainCheck.checked;
      P.batchDir      = d.batchDirEdit.text;
      P.batchSuffix   = d.batchSuffixEdit.text;
      P.wbppEnable    = d.wbppCheck.checked;
      P.wbppDir       = d.wbppDirEdit.text;
      P.dumpEnable    = d.dumpCheck.checked;
      P.dumpDir       = d.dumpDirEdit.text;
   };

   // ---- Expanded/collapsed sections (not touched by Reset) ----
   this.setExpanded = function(list) {
      var keys = "," + list + ",", i, b;
      for (i = 0; i < d.sectionBars.length; i++) {
         b = d.sectionBars[i];
         b.expandedState = keys.indexOf("," + b.sectionKey + ",") >= 0;
         if (b.expandedState) {
            b.section.show();
            b.button.icon = d.scaledResource(":/process-interface/contract-vert.png");
         } else {
            b.section.hide();
            b.button.icon = d.scaledResource(":/process-interface/expand-vert.png");
         }
      }
      d.ensureLayoutUpdated();
      d.adjustToContents();
   };
   this.getExpanded = function() {
      var out = [], i;
      for (i = 0; i < d.sectionBars.length; i++)
         if (d.sectionBars[i].expandedState) out.push(d.sectionBars[i].sectionKey);
      return out.join(",");
   };

   // ---- Buttons ----
   this.okButton = new PushButton(this);
   this.okButton.text = "Execute";
   this.okButton.icon = this.scaledResource(":/icons/power.png");
   this.okButton.onClick = function() { d.ok(); };

   this.cancelButton = new PushButton(this);
   this.cancelButton.text = "Cancel";
   this.cancelButton.icon = this.scaledResource(":/icons/cancel.png");
   this.cancelButton.onClick = function() { d.cancel(); };

   this.resetButton = new PushButton(this);
   this.resetButton.text = "Reset";
   this.resetButton.toolTip = "Reset all parameters to defaults.";
   this.resetButton.onClick = function() { d.setParams(STR_defaults); };

   this.buttonSizer = new HorizontalSizer;
   this.buttonSizer.spacing = 6;
   this.buttonSizer.add(this.resetButton);
   this.buttonSizer.addStretch();
   this.buttonSizer.add(this.okButton);
   this.buttonSizer.add(this.cancelButton);

   // ---- Main layout ----
   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add(this.stackSizer);
   this.sizer.add(this.subLabel);
   this.sizer.add(this.subTree);
   var si;
   for (si = 0; si < this.sectionBars.length; si++) {
      this.sizer.add(this.sectionBars[si]);
      this.sizer.add(this.sectionBars[si].section);
   }
   this.sizer.addSpacing(4);
   this.sizer.add(this.buttonSizer);

   this.batchCheck.checked = false;
   this.batchCheck.onCheck(false);
   this.setParams(STR_defaults);
   this.setExpanded("");
}
STR_Dialog.prototype = new Dialog;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
function main() {
   var P = {}, key;
   for (key in STR_defaults) if (STR_defaults.hasOwnProperty(key)) P[key] = STR_defaults[key];
   STR_loadSettings(P);

   var dlg = new STR_Dialog();
   dlg.setParams(P);
   dlg.setExpanded(P.uiExpanded);
   var accepted = dlg.execute();
   // the layout is remembered even on Cancel (parameters are not)
   Settings.write(STR_settingsKey + "/uiExpanded", DataType_String, dlg.getExpanded());
   if (!accepted) return;

   dlg.getParams(P);
   P.uiExpanded = dlg.getExpanded();
   if (P.sigmaHigh <= P.sigmaLow) {
      P.sigmaHigh = P.sigmaLow + 0.1;
      console.warningln("Upper sigma must exceed lower sigma; using " + P.sigmaHigh.toFixed(1));
   }
   STR_saveSettings(P);

   // WBPP mode: references come from the masters folder, no open stack needed
   if (P.wbppEnable) {
      if (P.wbppDir.length === 0) { console.criticalln("WBPP mode: no folder selected."); return; }
      var restore = dlg.wbppRestoreCheck.checked;
      if (restore) {
         var mb = new MessageBox("Restore all originals in\n" + P.wbppDir + "/registered ?\n\n"
            + "Every <name>.sat is renamed back to <name>.xisf; the cleaned frames are deleted.",
            "SatelliteTrailRemover", StdIcon_Warning, StdButton_Yes, StdButton_No);
         if (mb.execute() !== StdButton_Yes) return;
      }
      STR_runWBPP(P.wbppDir, P, restore);
      return;
   }

   var stackIdx = dlg.stackCombo.currentItem;
   if (stackIdx < 0) { console.criticalln("No stack image selected."); return; }
   var stackId = ImageWindow.windows[stackIdx].mainView.id;

   if (dlg.batchCheck.checked && P.batchDir.length > 0) {
      var searchDir = P.batchDir;
      if (searchDir.charAt(searchDir.length - 1) !== "/") searchDir += "/";
      var files = [];
      var ff = new FileFind;
      if (ff.begin(searchDir + "*")) {
         do {
            if (!ff.isDirectory) {
               var name = ff.name;
               var ext = File.extractExtension(name).toLowerCase();
               // Do not re-process our own outputs
               if (P.batchSuffix.length > 0
                   && File.extractName(name).indexOf(P.batchSuffix) >= 0) continue;
               if (ext === ".fit" || ext === ".fits" || ext === ".fts" || ext === ".xisf")
                  files.push(searchDir + name);
            }
         } while (ff.next());
      }
      if (files.length === 0) { console.criticalln("No FITS/XISF files found in: " + searchDir); return; }
      files.sort();
      STR_runBatch(stackId, files, P);
   } else {
      var subIds = [], i;
      for (i = 0; i < dlg.subTree.numberOfChildren; i++)
         if (dlg.subTree.child(i).selected) subIds.push(dlg.subTree.child(i).text(0));
      if (subIds.length === 0) { console.criticalln("No sub-exposure images selected."); return; }
      STR_run(stackId, subIds, P);
   }
}

main();
