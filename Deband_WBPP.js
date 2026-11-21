// ----------------------------------------------------------------------------
// Deband_WBPP.js  -  WBPP pipeline builder for PixInsight
// Banding removal inside WeightedBatchPreprocessing
// (WBPP 3.2.0, whose source files are labelled 3.1.2; PixInsight 1.9.6).
//
// GENERATED from DebandDesat_WBPP.js by tools/make_Deband_WBPP.py: do not edit
// by hand.  It is DebandDesat_WBPP.js without its trail removal step; the deband
// step, its core and its helpers are verbatim copies, so both builders give
// identical debanded frames and share WBPP's cache.
//
// WHAT IT DOES
// WBPP runs the standard light pipeline with one extra step per light group:
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
// The input files are never modified, so WBPP's caches stay valid: disable the
// builder and WBPP uses the calibrated frames again.  For banding AND satellite
// trail removal select DebandDesat_WBPP.js instead; for trails only,
// Desat_WBPP.js (WBPP takes one builder).
//
// SETTINGS
// The step reads the parameters saved by the standalone script: run it once
// (Script > BlackRig > Deband), set the parameters, close it with OK or Cancel
// (both save).  Missing settings fall back to the defaults of Deband 2.1.  Read
// when the step runs.  The standalone Deband's diagnostic outputs (spectrum,
// mask, removed noise, gain maps) and its file options are not used here.
//
// REPORT
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
// WBPP's debayer output "Combined RGB"; with separated channels the step skips
// the group and says so.
//
// CACHE
// Results are stored in WBPP's execution cache: a rerun skips frames whose
// input file and parameters are unchanged.  "Purge cache" in WBPP clears it.
//
// SPEED AND MEMORY
// Several frames are processed at the same time, each in its own thread
// (PixInsight's Thread object).  FDW_THREADS below sets how many: 0 means
// automatic (8), 1 means one frame at a time.  The number is always lowered to
// the processors PixInsight may use (Edit > Global Preferences) and to what fits
// in 80 % of the available physical memory.  Deband needs about 30 bytes per
// pixel and channel per frame in progress (about 3 GB for a 100-Mpx monochrome
// frame).  The console shows the memory available and the number used.  The
// results do not depend on the number of threads.
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
//   1.0  first version: the deband step of DebandDesat_WBPP 1.0 (Deband 2.1)
// Author: Erellaz
// License: MIT (see the LICENSE file next to this script)
// ----------------------------------------------------------------------------

var DBW_VERSION = "1.0";     // this WBPP builder

var FDW_THREADS = 0;        // frames debanded at the same time: 0 = automatic (8), 1 = one at a time; always limited by processors and memory

var FD_VERSION   = "2.1";   // Deband core below (verbatim copy of 2.1)
var FDW_CACHE_VERSION = "1.0";    // version of the deband results, part of the cache keys: bump when they change

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
// ==== HELPERS
// Runs inside WBPP: uses PixInsight objects and WBPP's engine.  No preprocessor:
// the constants of the pjsr include files do not exist here (WBPP uses DataType.Double,
// UndoFlag.NoSwapFile, ...).  Verbatim copies of the trail step's helpers in
// DebandDesat_WBPP.js, whose names they keep.
// ============================================================================

function STRW_const(obj, name, fallback) {
   return (obj !== undefined && obj !== null && obj[name] !== undefined) ? obj[name] : fallback;
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

// CoreApplication.processEvents(); the global processEvents() is deprecated in PixInsight 1.9.6
function STRW_processEvents() {
   if (typeof CoreApplication !== "undefined" && typeof CoreApplication.processEvents === "function") CoreApplication.processEvents();
   else processEvents();
}

function STRW_noSwapFile() {
   return STRW_const((typeof UndoFlag !== "undefined") ? UndoFlag : null, "NoSwapFile", 0xFFFFFFFF);
}

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

function STRW_dir(path) {
   if (!File.directoryExists(path)) {
      try { File.createDirectory(path, true); }
      catch (e) { if (!File.directoryExists(path)) throw e; }
   }
   return path;
}

function STRW_logBlock(fn, params) {
   var b = new OperationBlock;
   b.run = function(env) { fn(env); };
   return { operation: b, params: params };
}


// ============================================================================
// ==== DEBAND STEP (Deband, before registration)
// Runs inside WBPP.  Uses the helpers above.
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
   var full = "Deband " + FD_VERSION + " (WBPP builder Deband_WBPP " + DBW_VERSION + "): " + FDW_describe(P)
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
   console.noteln("* Begin deband (Deband " + FD_VERSION + ", WBPP builder Deband_WBPP " + DBW_VERSION + ")");
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
      throw new Error("Deband_WBPP " + DBW_VERSION + " needs WBPP 3.1.2; missing: " + missing.join(", "));
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

function DBW_build(engine) {
   STRW_checkApi(engine);
   engine.pipelineManager.buildPipelineForLight();
   // From here on the builder must not throw: WBPP would build the light pipeline a second time
   var w = "";
   try { w = FDW_insert(engine); }
   catch (x) { w = FDW_NAME + " NOT added: " + (x.message || x); }
   engine.pipelineBuilderWarning = w || "";
}

DBW_build(engine);

// ----------------------------------------------------------------------------
// EOF Deband_WBPP.js
