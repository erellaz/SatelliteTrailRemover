// ----------------------------------------------------------------------------
// TrailBlink.js  -  PixInsight PJSR Script
// Record human verdicts on Desat results, frame by frame.
//
// Open the output folder of a WBPP run cleaned by Desat or by the DebandDesat_WBPP
// builder (the folder that holds registered/ and detrailed/, or debanded/).  Three modes:
//   Review     every frame the script cleaned: registered (left) and detrailed (right), side by
//              side.  Verdicts: Correct, False positive, Incomplete removal, Missed trail, Unsure.
//   Hunt       every registered frame, one panel, showing the final frame (the detrailed copy if
//              the script cleaned the frame, the registered frame otherwise), to find trails the
//              script missed.  Verdicts: No trail, Missed trail, Incomplete removal, Unsure.
//   Deband QC  every frame DebandDesat_WBPP debanded: the frame before deband (left) and the debanded
//              frame (right), in sensor coordinates (before registration).  Verdicts: Clean,
//              Residual banding, Artefact (deband removed or added something that is not banding,
//              e.g. a streak along a bright star's row), Unsure.  The status line shows the row
//              and column banding before and after, and the removed pattern's strength relative
//              to the group; "Strongest first" lists the frames with the most pattern noise first.
//
// Drawing: press False positive, Incomplete removal or Missed trail (or F / I / M; in Deband QC
// Residual banding or Artefact, R / A), then click the two ends of each segment; draw as many as
// needed.  Esc stops drawing, Backspace removes the last segment.
//
// Views (keys 1 / 2 / 3)
//   Image     linear frame with an automatic stretch (the same stretch on both panels).
//   Residual  frame minus the reference stack matched to it, in noise units: faint trails stand out.
//             In Deband QC: Detail, the frame minus its smooth background, in noise units: bands
//             stand out.
//   Removed   right panel = registered minus detrailed, i.e. what the script subtracted (in Deband
//             QC: before minus debanded, the removed pattern).
// Zoom with the mouse wheel or + / -, pan by dragging, 0 = whole frame.  Zoomed in past 1:1 the
// panels show full-resolution pixels; zoomed out they show 4x4-binned means (lower noise, faint
// trails show better).
//
// Labels are saved after every change to <folder>/trail_labels.json (its "conventions" entry
// explains the fields), in the same format as the Python TrailLabeler 1.0, so both tools can be
// used on the same folder (Deband QC verdicts are kept by the Python tool, which does not show
// them).  Coordinates are full-resolution pixels of the registered frame (Deband QC: of the frame
// before registration).
//
// Version 1.2
//   1.2  Deband QC mode (frames debanded by the DebandDesat_WBPP WBPP builder); renamed TrailBlink (was TrailLabeler 1.1)
//   1.1  first PixInsight version (the Python TrailLabeler was 1.0)
// Author: Erellaz
// License: MIT (see the LICENSE file next to this script)
//
// Script > BlackRig > TrailBlink
// ----------------------------------------------------------------------------

#feature-id    TrailBlink : BlackRig > TrailBlink
#feature-info  Records human verdicts (correct, false positive, incomplete removal, \
   missed trail) on the frames of a WBPP output folder cleaned by Desat, \
   and on the frames debanded by the DebandDesat_WBPP builder (Deband QC), with side-by-side, \
   residual and removed views, and writes them to trail_labels.json.

#include <pjsr/Sizer.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/KeyCodes.jsh>
#include <pjsr/ButtonCodes.jsh>
#include <pjsr/PenStyle.jsh>
#include <pjsr/FocusStyle.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/DataType.jsh>

#define TL_VERSION "1.2"

// ==== CORE BEGIN
// Pure ECMAScript 5, no PixInsight objects.  Testable in Node.js.

var TL_BIN = 4;               // display binning when zoomed out
var TL_BG_SIZE = 31;          // binned px (124 full-res px): background removed from the residual view
var TL_LABEL_FILE = "trail_labels.json";

var TL_REVIEW_FLAGS = [["correct", "Correct", "C", "#2e9e44"],
                       ["false_positive", "False positive", "F", "#d03030"],
                       ["incomplete", "Incomplete removal", "I", "#e08000"],
                       ["missed", "Missed trail", "M", "#c030c0"],
                       ["unsure", "Unsure", "U", "#4a6fb0"]];
var TL_HUNT_FLAGS = [["no_trail", "No trail", "C", "#2e9e44"],
                     ["missed", "Missed trail", "M", "#c030c0"],
                     ["incomplete", "Incomplete removal", "I", "#e08000"],
                     ["unsure", "Unsure", "U", "#4a6fb0"]];
var TL_DEBAND_FLAGS = [["deband_ok", "Clean", "C", "#2e9e44"],
                       ["residual_bands", "Residual banding", "R", "#e08000"],
                       ["artefact", "Artefact", "A", "#d03030"],
                       ["unsure", "Unsure", "U", "#4a6fb0"]];
var TL_DRAW_KINDS = ["false_positive", "incomplete", "missed", "residual_bands", "artefact"];
var TL_GOOD = { review: "correct", hunt: "no_trail", deband: "deband_ok" };
var TL_CONFLICTS = { review: ["false_positive", "incomplete"], hunt: ["missed", "incomplete"], deband: ["residual_bands", "artefact"] };
var TL_KIND_COLOR = { false_positive: 0xffff3b3b, incomplete: 0xffffa020, missed: 0xffff50ff, residual_bands: 0xffffa020, artefact: 0xffff3b3b };
var TL_KIND_SHORT = { false_positive: "FP", incomplete: "INC", missed: "MISS", residual_bands: "BAND", artefact: "ART" };
var TL_DEBAND_DIR = "debanded";
var TL_DEBAND_REPORT = "Deband_report.csv";
var TL_DEBAND_REPORT_OLD = "DebandDesat_report.csv";   // its name before the rename (DebandDesat 1.0)

var TL_CONVENTIONS = {
   coordinates: "full-resolution pixels of the registered frame (deband: of the frame before registration); "
      + "x to the right, y down, (0,0) = top-left pixel",
   frames: "key = <WBPP group folder>/<file name>; index = position of the file in its group, files sorted by name",
   review: "verdict on a frame the script cleaned, judged on registered vs detrailed. flags: correct = what the "
      + "script removed is a trail and it is fully removed; false_positive = the script removed something that "
      + "is not a trail; incomplete = a trail the script handled is still visible after cleaning; missed = a "
      + "trail the script did not touch; unsure",
   hunt: "verdict on the final frame (detrailed if cleaned, else registered). flags: no_trail; missed = trail "
      + "visible that the script did not touch; incomplete = leftover of a trail the script handled; unsure",
   deband: "verdict on a frame debanded by the DebandDesat_WBPP WBPP builder, judged on the frame before deband vs "
      + "the debanded frame (key = <group folder>/<debanded file name>). flags: deband_ok = banding removed, "
      + "nothing else changed; residual_bands = banding still visible after deband; artefact = deband removed or "
      + "added something that is not banding (e.g. a streak along a bright star's row or column); unsure",
   trails: "segments drawn by the labeler: kind (false_positive | incomplete | missed | residual_bands | artefact), "
      + "ends (x0,y0)-(x1,y1); for false_positive the segment marks the feature the script wrongly removed",
   note: "free text typed by the labeler"
};

function TL_inArray(a, v) { for (var i = 0; i < a.length; i++) if (a[i] === v) return true; return false; }
function TL_pad2(n) { return (n < 10 ? "0" : "") + n; }

function TL_now() {
   var d = new Date();
   return d.getFullYear() + "-" + TL_pad2(d.getMonth() + 1) + "-" + TL_pad2(d.getDate()) + "T"
      + TL_pad2(d.getHours()) + ":" + TL_pad2(d.getMinutes()) + ":" + TL_pad2(d.getSeconds());
}

function TL_frameTime(name) {
   var m = /(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/.exec(name);
   return m ? m[1] + " " + m[2] : name;
}

// Short group name: the FILTER-<name> part of a WBPP group folder
function TL_shortName(group) {
   var m = /FILTER-([^_]+)/.exec(group);
   return m ? m[1] : group;
}

// Script detections from the report's "details" column
function TL_parseDetails(s) {
   var out = [], m, re1 = /line z=([\d.]+) \((-?\d+),(-?\d+)\)-\((-?\d+),(-?\d+)\) hw=(\d+)/g,
       re2 = /blob (\d+)x(\d+) at \((-?\d+),(-?\d+)\)/g;
   s = s || "";
   while ((m = re1.exec(s)) !== null)
      out.push({ kind: "line", z: +m[1], x0: +m[2], y0: +m[3], x1: +m[4], y1: +m[5], hw: +m[6] });
   while ((m = re2.exec(s)) !== null)
      out.push({ kind: "blob", len: +m[1], wid: +m[2], cx: +m[3], cy: +m[4] });
   return out;
}

// CSV with a header row, quoted fields ("" = quote) -> array of {column: value}
function TL_parseCSV(text) {
   if (text.length > 0 && text.charCodeAt(0) === 0xfeff) text = text.substring(1);
   var rows = [], row = [], f = "", q = false, i, c;
   for (i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (q) {
         if (c === '"') { if (text.charAt(i + 1) === '"') { f += '"'; i++; } else q = false; }
         else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") {
         if (c === "\r" && text.charAt(i + 1) === "\n") i++;
         row.push(f); f = ""; rows.push(row); row = [];
      } else f += c;
   }
   if (f.length > 0 || row.length > 0) { row.push(f); rows.push(row); }
   var out = [], k, o;
   if (rows.length < 1) return out;
   for (i = 1; i < rows.length; i++) {
      if (rows[i].length === 1 && rows[i][0] === "") continue;
      o = {};
      for (k = 0; k < rows[0].length; k++) o[rows[0][k]] = rows[i][k] !== undefined ? rows[i][k] : "";
      out.push(o);
   }
   return out;
}

// JSON with every non-ASCII character escaped (file names hold the degree sign): the file is
// then plain ASCII, read identically by PixInsight and by Python.
function TL_jsonAscii(obj) {
   return JSON.stringify(obj, null, 1).replace(/[\u0080-￿]/g, function(ch) {
      return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
   });
}

function TL_copy(o) { return JSON.parse(JSON.stringify(o)); }

// Median of a typed array (sorted in place)
function TL_medianSorted(a) {
   var n = a.length;
   if (n === 0) return 0;
   return (n & 1) ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}
function TL_sortF32(a) { Array.prototype.sort.call(a, function(p, q) { return p - q; }); return a; }

// Robust sigma and median of the values x[i] with ok[i] (every step-th of them); {s, m}
function TL_madn(x, ok, step) {
   var n = 0, i, k = 0;
   for (i = 0; i < x.length; i++) if (!ok || ok[i]) n++;
   step = Math.max(step, Math.ceil(n / 200000));   // robust statistics: 200 000 samples are plenty
   var sel = new Float32Array(Math.ceil(n / step)), c = 0;
   for (i = 0; i < x.length; i++) {
      if (ok && !ok[i]) continue;
      if (k++ % step === 0 && c < sel.length) sel[c++] = x[i];
   }
   if (c === 0) return { s: 1, m: 0 };
   sel = TL_sortF32(sel.subarray(0, c));
   var med = TL_medianSorted(sel), dev = new Float32Array(c);
   for (i = 0; i < c; i++) dev[i] = Math.abs(sel[i] - med);
   var mad = TL_medianSorted(TL_sortF32(dev));
   return { s: Math.max(1.4826 * mad, 1e-12), m: med };
}

function TL_percentile(x, ok, step, p) {
   var vals = [], k = 0, i, n = 0;
   for (i = 0; i < x.length; i++) if (!ok || ok[i]) n++;
   step = Math.max(step, Math.ceil(n / 200000));
   for (i = 0; i < x.length; i++) { if (ok && !ok[i]) continue; if (k++ % step === 0) vals.push(x[i]); }
   if (vals.length === 0) return 0;
   vals.sort(function(a, b) { return a - b; });
   var pos = (vals.length - 1) * p / 100, lo = Math.floor(pos), hi = Math.min(vals.length - 1, lo + 1);
   return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo);
}

// Summed-area table (w + 1) x (h + 1)
function TL_sat(x, w, h) {
   var S = new Float64Array((w + 1) * (h + 1)), y, xx, row;
   for (y = 0; y < h; y++) {
      row = 0;
      for (xx = 0; xx < w; xx++) {
         row += x[y * w + xx];
         S[(y + 1) * (w + 1) + xx + 1] = S[y * (w + 1) + xx + 1] + row;
      }
   }
   return S;
}
function TL_satSum(S, w, x0, y0, x1, y1) {   // sum over [x0, x1) x [y0, y1)
   var W1 = w + 1;
   return S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
}

// Box mean of x over the pixels with v = 1 (window size, clipped at the borders)
function TL_boxMean(x, v, w, h, size) {
   var n = w * h, xv = new Float32Array(n), i, r = size >> 1;
   for (i = 0; i < n; i++) xv[i] = v[i] ? x[i] : 0;
   var Sx = TL_sat(xv, w, h), Sv = TL_sat(v, w, h), out = new Float32Array(n), y, xx, x0, x1, y0, y1, den;
   xv = null;
   for (y = 0; y < h; y++) {
      y0 = Math.max(0, y - r); y1 = Math.min(h, y + r + 1);
      for (xx = 0; xx < w; xx++) {
         x0 = Math.max(0, xx - r); x1 = Math.min(w, xx + r + 1);
         den = TL_satSum(Sv, w, x0, y0, x1, y1);
         out[y * w + xx] = TL_satSum(Sx, w, x0, y0, x1, y1) / Math.max(den, 1e-6);
      }
   }
   return out;
}

// Dilation of a 0/1 mask by a square of radius r
function TL_dilate(m, w, h, r) {
   var tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), x, y, k, k0, k1;
   for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      k0 = Math.max(0, x - r); k1 = Math.min(w - 1, x + r);
      for (k = k0; k <= k1; k++) tmp[y * w + k] = 1;
   }
   for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue;
      k0 = Math.max(0, y - r); k1 = Math.min(h - 1, y + r);
      for (k = k0; k <= k1; k++) out[k * w + x] = 1;
   }
   return out;
}

// Smooth background of res (box TL_BG_SIZE), ignoring stars, trails and other outliers; {bg, s}
function TL_robustBg(res, v, w, h) {
   var n = w * h, keep = new Float32Array(n), i, it, bg = null, st = { s: 1, m: 0 }, r = new Float32Array(n), out;
   for (i = 0; i < n; i++) keep[i] = v[i] ? 1 : 0;
   for (it = 0; it < 3; it++) {
      bg = TL_boxMean(res, keep, w, h, TL_BG_SIZE);
      for (i = 0; i < n; i++) r[i] = res[i] - bg[i];
      st = TL_madn(r, v, 5);
      var bad = new Uint8Array(n);
      for (i = 0; i < n; i++) bad[i] = (v[i] && Math.abs(r[i] - st.m) > 3 * st.s) ? 1 : 0;
      out = TL_dilate(bad, w, h, 2);
      for (i = 0; i < n; i++) keep[i] = (v[i] && !out[i]) ? 1 : 0;
   }
   return { bg: bg, s: st.s };
}

// Gain of the frame A against the reference R, on structure only (local background removed)
function TL_gainFit(A, R, v, w, h) {
   var n = w * h, hA = TL_boxMean(A, v, w, h, TL_BG_SIZE), hR = TL_boxMean(R, v, w, h, TL_BG_SIZE), i, it;
   for (i = 0; i < n; i++) { hA[i] = A[i] - hA[i]; hR[i] = R[i] - hR[i]; }
   var ok = new Uint8Array(n);
   for (i = 0; i < n; i++) ok[i] = v[i] ? 1 : 0;
   var p995 = TL_percentile(R, ok, 7, 99.5);
   for (i = 0; i < n; i++) if (ok[i] && !(R[i] < p995)) ok[i] = 0;
   var g = 1, e = new Float32Array(n), sAR, sRR, st;
   for (it = 0; it < 4; it++) {
      sAR = 0; sRR = 0;
      for (i = 0; i < n; i++) if (ok[i]) { sAR += hA[i] * hR[i]; sRR += hR[i] * hR[i]; }
      g = sAR / Math.max(sRR, 1e-30);
      for (i = 0; i < n; i++) e[i] = hA[i] - g * hR[i];
      st = TL_madn(e, ok, 5);
      for (i = 0; i < n; i++) if (ok[i] && !(Math.abs(e[i] - st.m) < 4 * st.s)) ok[i] = 0;
   }
   return g;
}

function TL_mtf(m, x) { return (m - 1) * x / ((2 * m - 1) * x - m); }

// Display stretch parameters of a frame: c0 (shadows), xm (normalised median)
function TL_stretch(A, valid) {
   var st = TL_madn(A, valid, 7), c0 = Math.max(0, st.m - 2.8 * st.s);
   return { c0: c0, xm: (st.m - c0) / Math.max(1e-12, 1 - c0) };
}

// Display values in [0, 1] (Float32Array) of n pixels.
//   view "image":  MTF stretch of X (c0, xm), contrast k
//   otherwise:     z = (X - gain R - bg) / sig (without a reference R: (X - bg) / sig),
//                  or (A - B) / sig for "removed" on the right panel
function TL_display(view, k, X, A, B, R, bg, gain, sig, st, n, removedRight) {
   var out = new Float32Array(n), i, y, z;
   if (view === "image") {
      var m = TL_mtf(0.04 + 0.04 * k, st.xm), c0 = st.c0, sc = 1 / Math.max(1e-12, 1 - c0), x;
      for (i = 0; i < n; i++) {
         if (!(A[i] > 0)) { out[i] = 0; continue; }
         x = (X[i] - c0) * sc; if (x < 0) x = 0; else if (x > 1) x = 1;
         out[i] = TL_mtf(m, x);
      }
      return out;
   }
   var rng2 = 2 * 15 / k;
   for (i = 0; i < n; i++) {
      if (!(A[i] > 0)) { out[i] = 0.5; continue; }
      z = removedRight ? (A[i] - B[i]) / sig : (X[i] - (R ? gain * R[i] : 0) - bg[i]) / sig;
      y = 0.5 + z / rng2;
      out[i] = y < 0 ? 0 : (y > 1 ? 1 : y);
   }
   return out;
}

// Flag button logic (as the Python tool).  st = {entry, armed, p0}; returns
// {changed, advance, ask: null | {text, then}} and updates st; when ask is set nothing changed yet:
// call then() after the user confirmed.
function TL_toggle(st, flag, mode) {
   var fl = st.entry.flags, good = TL_GOOD[mode], res = { changed: false, advance: false, ask: null }, n, i;
   function countKinds(kinds) { var c = 0; for (var j = 0; j < st.entry.trails.length; j++) if (TL_inArray(kinds, st.entry.trails[j].kind)) c++; return c; }
   function removeKinds(kinds) { var t = []; for (var j = 0; j < st.entry.trails.length; j++) if (!TL_inArray(kinds, st.entry.trails[j].kind)) t.push(st.entry.trails[j]); st.entry.trails = t; }
   function removeFlag(f) { var j = fl.indexOf(f); if (j >= 0) fl.splice(j, 1); }
   if (TL_inArray(TL_DRAW_KINDS, flag)) {
      if (!TL_inArray(fl, flag)) {
         fl.push(flag);
         if (TL_inArray(fl, good) && TL_inArray(TL_CONFLICTS[mode], flag)) removeFlag(good);
         st.armed = flag; st.p0 = null; res.changed = true;
      } else if (st.armed !== flag) {
         st.armed = flag; st.p0 = null;
      } else {
         n = countKinds([flag]);
         var drop = function() { removeKinds([flag]); removeFlag(flag); st.armed = null; st.p0 = null; };
         if (n > 0) { res.ask = { text: "Remove the " + n + " drawn trail(s) of this kind?", then: drop }; return res; }
         drop(); res.changed = true;
      }
   } else if (flag === good) {
      if (TL_inArray(fl, flag)) { removeFlag(flag); res.changed = true; }
      else {
         var bad = [];
         for (i = 0; i < fl.length; i++) if (TL_inArray(TL_CONFLICTS[mode], fl[i])) bad.push(fl[i]);
         n = countKinds(bad);
         var setGood = function() {
            removeKinds(bad);
            for (var j = 0; j < bad.length; j++) removeFlag(bad[j]);
            fl.push(flag);
            if (TL_inArray(bad, st.armed)) { st.armed = null; st.p0 = null; }
         };
         if (n > 0) {
            res.ask = { text: "This removes " + bad.join(", ") + " and " + n + " drawn trail(s). Continue?", then: setGood };
            res.advance = true;
            return res;
         }
         setGood(); res.changed = true; res.advance = true;
      }
   } else {
      if (TL_inArray(fl, flag)) removeFlag(flag); else fl.push(flag);
      res.changed = true;
   }
   return res;
}

// Label store (the JSON object of the file)
function TL_newLabels(root) {
   return { tool: "TrailBlink", version: TL_VERSION_CORE, root: root, created: TL_now(), frames: {} };
}
function TL_entryOf(d, fr, mode) { var f = d.frames[fr.key]; return f ? (f[mode] || null) : null; }
function TL_labelled(d, fr, mode) { var e = TL_entryOf(d, fr, mode); return !!(e && e.flags && e.flags.length); }
function TL_put(d, fr, mode, entry, size) {
   var f = d.frames[fr.key];
   if (!f) f = d.frames[fr.key] = {};
   f.group = fr.group; f.filter = fr.short; f.index = fr.index; f.file = fr.file;
   f.cleaned_by_script = !!fr.det; f.script_action = fr.action; f.script_details = fr.details;
   if (size) { f.width = size[0]; f.height = size[1]; }
   if (entry === null) delete f[mode];
   else {
      var e = TL_copy(entry);
      e.time = TL_now();
      e.labeler = "TrailBlink " + TL_VERSION_CORE;
      f[mode] = e;
   }
   d.updated = TL_now();
}

// Banding of a row (or column) profile p (n values; ok[i] = 1 where p[i] is valid): the profile
// minus its running mean over +-half samples, RMS over the samples at least `edge` from both ends
function TL_hpRms(p, ok, n, half, edge) {
   var S = new Float64Array(n + 1), C = new Float64Array(n + 1), i, a, b, m, s = 0, c = 0, r;
   for (i = 0; i < n; i++) { S[i + 1] = S[i] + (ok[i] ? p[i] : 0); C[i + 1] = C[i] + (ok[i] ? 1 : 0); }
   for (i = edge; i < n - edge; i++) {
      if (!ok[i]) continue;
      a = Math.max(0, i - half); b = Math.min(n, i + half + 1);
      m = (S[b] - S[a]) / Math.max(1, C[b] - C[a]);
      r = p[i] - m; s += r * r; c++;
   }
   return c > 0 ? Math.sqrt(s / c) : 0;
}

// Row and column banding of a frame, in units of sig (noise per pixel).  rs/rn, cs/cn: per-row
// and per-column sums and counts of (pixel - smooth background), pixels beyond 3 sig excluded.
function TL_bandStats(rs, rn, cs, cn, W, H, sig) {
   var rows = new Float64Array(H), rok = new Uint8Array(H), cols = new Float64Array(W), cok = new Uint8Array(W), i;
   for (i = 0; i < H; i++) if (rn[i] > 0.2 * W) { rows[i] = rs[i] / rn[i]; rok[i] = 1; }
   for (i = 0; i < W; i++) if (cn[i] > 0.2 * H) { cols[i] = cs[i] / cn[i]; cok[i] = 1; }
   return { rows: TL_hpRms(rows, rok, H, 64, 64) / sig, cols: TL_hpRms(cols, cok, W, 64, 64) / sig };
}
var TL_VERSION_CORE = "1.2";
// ==== CORE END

// ============================================================================
// PixInsight part: files, images, dialog
// ============================================================================

function TL_listDir(dir, wantDirs, ext) {
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

function TL_findRoot(d) {
   var c = d.replace(/\\/g, "/").replace(/\/+$/, ""), i;
   for (i = 0; i < 3 && c.length > 0; i++) {
      if (File.directoryExists(c + "/registered") || File.directoryExists(c + "/" + TL_DEBAND_DIR)) return c;
      var j = c.lastIndexOf("/");
      if (j <= 0) break;
      c = c.substring(0, j);
   }
   return null;
}

// Frames of the folder: stage "trail" (registered/ + detrailed/, for Review and Hunt) and stage
// "deband" (debanded/ + the DebandDesat_WBPP report, for Deband QC; reg = the frame before deband)
function TL_scan(root) {
   var frames = TL_scanTrail(root), deb = TL_scanDeband(root), i;
   for (i = 0; i < deb.length; i++) frames.push(deb[i]);
   return frames;
}

function TL_readReport(path, keyCol) {
   var out = {}, rows, i;
   if (!File.exists(path)) return out;
   try {
      rows = TL_parseCSV(File.readTextFile(path));
      for (i = 0; i < rows.length; i++) out[rows[i][keyCol] || ""] = rows[i];
   } catch (e) { console.warningln("TrailBlink: cannot read " + path + ": " + e.message); }
   return out;
}

function TL_scanDeband(root) {
   var dd = root + "/" + TL_DEBAND_DIR, frames = [], groups = File.directoryExists(dd) ? TL_listDir(dd, true) : [], gi, i;
   for (gi = 0; gi < groups.length; gi++) {
      var g = groups[gi], files = TL_listDir(dd + "/" + g, false, ".xisf");
      if (files.length === 0) continue;
      var rpd = dd + "/" + g + "/" + TL_DEBAND_REPORT;
      if (!File.exists(rpd)) rpd = dd + "/" + g + "/" + TL_DEBAND_REPORT_OLD;
      var report = TL_readReport(rpd, "file");
      for (i = 0; i < files.length; i++) {
         var f = files[i], r = report[f] || {}, rms = parseFloat(r.rms_removed), ratio = parseFloat(r.ratio_to_median);
         frames.push({ key: g + "/" + f, group: g, short: TL_shortName(g), index: i, file: f, stage: "deband",
                       reg: r.input || null, det: dd + "/" + g + "/" + f, ref: null,
                       action: r.input ? "debanded" : "debanded (not in the report: input unknown)",
                       details: (rms === rms) ? "removed RMS " + rms.toExponential(3)
                          + ((ratio === ratio) ? " (x" + ratio.toFixed(2) + " the group median)" : "") : "",
                       rms: (rms === rms) ? rms : 0, ratio: (ratio === ratio) ? ratio : 0 });
      }
   }
   return frames;
}

function TL_scanTrail(root) {
   var reg = root + "/registered", det = root + "/detrailed", frames = [], groups = File.directoryExists(reg) ? TL_listDir(reg, true) : [], gi, i;
   for (gi = 0; gi < groups.length; gi++) {
      var g = groups[gi], files = TL_listDir(reg + "/" + g, false, ".xisf");
      if (files.length === 0) continue;
      var dd = det + "/" + g, report = {}, rp = dd + "/Desat_report.csv";
      if (!File.exists(rp)) rp = dd + "/SatelliteTrailRemover_report.csv";   // its name before the rename
      if (File.exists(rp)) {
         try {
            var rows = TL_parseCSV(File.readTextFile(rp));
            for (i = 0; i < rows.length; i++) report[rows[i].file || ""] = rows[i];
         } catch (e) { console.warningln("TrailBlink: cannot read " + rp + ": " + e.message); }
      }
      var ref = dd + "/STR_reference.xisf";
      if (!File.exists(ref)) { ref = root + "/master/masterLight_" + g + ".xisf"; if (!File.exists(ref)) ref = null; }
      for (i = 0; i < files.length; i++) {
         var f = files[i], dp = dd + "/" + f, r = report[f] || {};
         frames.push({ key: g + "/" + f, group: g, short: TL_shortName(g), index: i, file: f, stage: "trail",
                       reg: reg + "/" + g + "/" + f, det: File.exists(dp) ? dp : null, ref: ref,
                       action: r.action || "", details: r.details || "" });
      }
   }
   return frames;
}

// Image file -> PJSR Image (not shown)
function TL_readImage(path) {
   var F = new FileFormat(".xisf", true, false);
   if (F.isNull) throw new Error("No installed file format can read .xisf files.");
   var f = new FileFormatInstance(F);
   if (f.isNull) throw new Error("Unable to instantiate the XISF format.");
   var d = f.open(path, "verbosity 0");
   if (!d || d.length < 1) throw new Error("Unable to open file: " + path);
   var img = new Image(1, 1, 1, 0, 32, 1);
   if (!f.readImage(img)) { f.close(); throw new Error("Unable to read file: " + path); }
   f.close();
   return img;
}

// Mean of the channels over a rectangle -> Float32Array
function TL_crop(img, x0, y0, x1, y1) {
   var w = x1 - x0, h = y1 - y0, n = w * h, out = new Float32Array(n), C = img.numberOfChannels, c, i;
   if (C === 1) { img.getSamples(out, new Rect(x0, y0, x1, y1), 0); return out; }
   var buf = new Float32Array(n);
   for (c = 0; c < C; c++) {
      img.getSamples(buf, new Rect(x0, y0, x1, y1), c);
      for (i = 0; i < n; i++) out[i] += buf[i];
   }
   for (i = 0; i < n; i++) out[i] /= C;
   return out;
}

// B x B binned means, by strips of rows
function TL_binned(img, B) {
   var W = img.width, H = img.height, bw = Math.floor(W / B), bh = Math.floor(H / B), out = new Float32Array(bw * bh);
   var rows = B * 64, by0, y0, y1, a, x, y, bx, by, nb, inv = 1 / (B * B);
   for (by0 = 0; by0 < bh; by0 += 64) {
      nb = Math.min(64, bh - by0); y0 = by0 * B; y1 = y0 + nb * B;
      a = TL_crop(img, 0, y0, bw * B, y1);
      var rowW = bw * B, o, k, sum, base;
      for (y = 0; y < nb * B; y++) {
         o = (by0 + Math.floor(y / B)) * bw; base = y * rowW;
         for (bx = 0; bx < bw; bx++) {
            sum = 0;
            for (k = 0; k < B; k++) sum += a[base + bx * B + k];
            out[o + bx] += sum;
         }
      }
   }
   for (x = 0; x < out.length; x++) out[x] *= inv;
   return out;
}

// One frame, ready to display
function TL_FrameData(fr, mode, refCache) {
   var t0 = Date.now(), i, B = TL_BIN, deband = mode === "deband";
   this.fr = fr; this.mode = mode;
   if (deband && (!fr.reg || !File.exists(fr.reg)))
      throw new Error("the frame before deband is not available" + (fr.reg ? ":\n" + fr.reg : " (not in " + TL_DEBAND_REPORT + ")")
         + "\nDeband QC compares it with the debanded copy.");
   var aPath = (mode === "review" || deband || !fr.det) ? fr.reg : fr.det;
   this.aIsDet = aPath === fr.det;
   this.imgA = TL_readImage(aPath);
   this.imgB = ((mode === "review" || deband) && fr.det) ? TL_readImage(fr.det) : null;
   if (this.imgB !== null && (this.imgB.width !== this.imgA.width || this.imgB.height !== this.imgA.height)) {
      this.imgA.free(); this.imgB.free();
      throw new Error("the two frames differ in size");
   }
   this.W = this.imgA.width; this.H = this.imgA.height;
   this.bw = Math.floor(this.W / B); this.bh = Math.floor(this.H / B);
   var n = this.bw * this.bh;
   this.A = TL_binned(this.imgA, B);
   this.B = this.imgB !== null ? TL_binned(this.imgB, B) : null;
   var valid = new Uint8Array(n);
   for (i = 0; i < n; i++) valid[i] = this.A[i] > 0 ? 1 : 0;
   this.st = TL_stretch(this.A, valid);
   var ref = deband ? false : (refCache.group === fr.group ? refCache.ref : undefined);   // no reference before registration
   if (ref === undefined) {
      if (refCache.ref && refCache.ref.img) refCache.ref.img.free();
      ref = false;
      if (fr.ref) {
         var ri = TL_readImage(fr.ref);
         if (ri.width === this.W && ri.height === this.H) ref = { img: ri, R: TL_binned(ri, B) };
         else ri.free();
      }
      refCache.group = fr.group; refCache.ref = ref;
   }
   this.imgR = null; this.R = null; this.bg = null; this.gain = 1;
   var v = new Uint8Array(n), src = this.B !== null ? this.B : this.A, res = new Float32Array(n), rb;
   if (ref) {
      this.imgR = ref.img; this.R = ref.R;
      for (i = 0; i < n; i++) v[i] = (valid[i] && this.R[i] > 0) ? 1 : 0;
      this.gain = TL_gainFit(this.A, this.R, v, this.bw, this.bh);
      for (i = 0; i < n; i++) res[i] = src[i] - this.gain * this.R[i];
      rb = TL_robustBg(res, v, this.bw, this.bh);
      this.bg = rb.bg; this.sigB = rb.s;
   } else {
      for (i = 0; i < n; i++) v[i] = valid[i];
      rb = TL_robustBg(src, v, this.bw, this.bh);
      this.sigB = rb.s;
      // Deband QC: the debanded frame's smooth background, removed from both panels (Detail view)
      if (deband) this.bg = rb.bg;
   }
   // full-resolution noise on a central 1024 x 1024 crop (Deband QC: of the debanded frame)
   var x0 = Math.max(0, (this.W >> 1) - 512), y0 = Math.max(0, (this.H >> 1) - 512);
   var x1 = Math.min(this.W, x0 + 1024), y1 = Math.min(this.H, y0 + 1024), cw = x1 - x0, ch = y1 - y0;
   var a = TL_crop((deband && this.imgB) ? this.imgB : this.imgA, x0, y0, x1, y1), z = new Float32Array(cw * ch), ok = new Uint8Array(cw * ch), nOk = 0, yy, xx;
   if (this.imgR !== null) {
      var r = TL_crop(this.imgR, x0, y0, x1, y1);
      for (yy = 0; yy < ch; yy++) for (xx = 0; xx < cw; xx++) {
         i = yy * cw + xx;
         z[i] = a[i] - this.gain * r[i] - this.bgAt(x0 + xx, y0 + yy);
      }
   } else {
      var one = new Float32Array(cw * ch);
      for (i = 0; i < cw * ch; i++) one[i] = 1;
      var m15 = TL_boxMean(a, one, cw, ch, 15);
      for (i = 0; i < cw * ch; i++) z[i] = a[i] - m15[i];
   }
   for (i = 0; i < cw * ch; i++) if (a[i] > 0) { ok[i] = 1; nOk++; }
   this.sigF = nOk > 1000 ? TL_madn(z, ok, 1).s : this.sigB * B;
   this.dets = deband ? [] : TL_parseDetails(fr.details);
   this.bands = null;
   if (deband && this.imgB !== null && this.bg !== null)
      this.bands = { before: this.bandsOf(this.imgA), after: this.bandsOf(this.imgB) };
   this.binCache = {};
   this.loadS = (Date.now() - t0) / 1000;
}
// Row and column banding of img (full resolution, by strips of rows): pixels minus the smooth
// background, stars and other outliers beyond 3 sigma excluded, in noise units per pixel
TL_FrameData.prototype.bandsOf = function(img) {
   var W = this.W, H = this.H, B = TL_BIN, bw = this.bw, bh = this.bh, lim = 3 * this.sigF;
   var rs = new Float64Array(H), rn = new Float64Array(H), cs = new Float64Array(W), cn = new Float64Array(W);
   var bxOf = new Int32Array(W), x, y, y0, y1, a, o, row, bgRow, v, p;
   for (x = 0; x < W; x++) bxOf[x] = Math.min(Math.floor(x / B), bw - 1);
   for (y0 = 0; y0 < H; y0 += 256) {
      y1 = Math.min(H, y0 + 256);
      a = TL_crop(img, 0, y0, W, y1);
      for (y = y0; y < y1; y++) {
         o = (y - y0) * W; bgRow = Math.min(Math.floor(y / B), bh - 1) * bw;
         for (x = 0; x < W; x++) {
            p = a[o + x];
            if (!(p > 0)) continue;
            v = p - this.bg[bgRow + bxOf[x]];
            if (v > -lim && v < lim) { rs[y] += v; rn[y]++; cs[x] += v; cn[x]++; }
         }
      }
   }
   return TL_bandStats(rs, rn, cs, cn, W, H, this.sigF);
};
TL_FrameData.prototype.bgAt = function(x, y) {
   var bx = Math.min(Math.floor(x / TL_BIN), this.bw - 1), by = Math.min(Math.floor(y / TL_BIN), this.bh - 1);
   return this.bg[by * this.bw + bx];
};
TL_FrameData.prototype.free = function() {
   if (this.imgA) this.imgA.free();
   if (this.imgB) this.imgB.free();
   this.imgA = this.imgB = null; this.A = this.B = null; this.binCache = {};
};
// Binned display values of panel src ("a" or "b") and its summed-area table; null if unavailable
TL_FrameData.prototype.binnedDisplay = function(src, view, k) {
   var key = src + "|" + view + "|" + k, c = this.binCache[key];
   if (c !== undefined) return c;
   var n = this.bw * this.bh, Bv = src === "b" ? this.B : null, X = Bv !== null ? Bv : this.A, D;
   if (view === "removed" && src === "b" && Bv !== null)
      D = TL_display(view, k, X, this.A, Bv, null, null, 1, this.sigB, this.st, n, true);
   else if (view !== "image" && this.R === null && this.bg === null) D = null;
   else D = TL_display(view, k, X, this.A, Bv, this.R, this.bg, this.gain, this.sigB, this.st, n, false);
   c = D === null ? null : { D: D, S: TL_sat(D, this.bw, this.bh) };
   var keys = [], kk;
   for (kk in this.binCache) if (this.binCache.hasOwnProperty(kk)) keys.push(kk);
   if (keys.length >= 4) delete this.binCache[keys[0]];
   this.binCache[key] = c;
   return c;
};
// Full-resolution display values over [x0, x1) x [y0, y1); null if unavailable
TL_FrameData.prototype.fullDisplay = function(src, view, k, x0, y0, x1, y1) {
   var w = x1 - x0, h = y1 - y0, n = w * h, A = TL_crop(this.imgA, x0, y0, x1, y1);
   var Bv = (src === "b" && this.imgB !== null) ? TL_crop(this.imgB, x0, y0, x1, y1) : null, X = Bv !== null ? Bv : A, i, xx, yy;
   if (view === "removed" && src === "b" && Bv !== null) return TL_display(view, k, X, A, Bv, null, null, 1, this.sigF, this.st, n, true);
   if (view === "image") return TL_display(view, k, X, A, null, null, null, 1, this.sigF, this.st, n, false);
   if (this.imgR === null && this.bg === null) return null;
   var R = this.imgR !== null ? TL_crop(this.imgR, x0, y0, x1, y1) : null, bg = new Float32Array(n);
   for (yy = 0; yy < h; yy++) for (xx = 0; xx < w; xx++) bg[yy * w + xx] = this.bgAt(x0 + xx, y0 + yy);
   return TL_display(view, k, X, A, null, R, bg, this.gain, this.sigF, this.st, n, false);
};

// ---------------------------------------------------------------------------
// Labels file
// ---------------------------------------------------------------------------
function TL_loadLabels(path, root) {
   var d = null;
   if (File.exists(path)) d = JSON.parse(File.readTextFile(path));
   if (!d) d = TL_newLabels(root);
   d.conventions = TL_CONVENTIONS;
   if (!d.frames) d.frames = {};
   return d;
}
function TL_saveLabels(path, d) {
   var tmp = path + ".tmp";
   File.writeTextFile(tmp, TL_jsonAscii(d));
   if (File.exists(path)) File.remove(path);
   File.move(tmp, path);
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
var TL_SETTINGS = "BlackRig/TrailBlink/";

function TL_Dialog() {
   this.__base__ = Dialog;
   this.__base__();
   var d = this;
   this.windowTitle = "TrailBlink " + TL_VERSION;
   this.userResizable = true;

   // state
   this.root = null; this.labelsPath = null; this.labels = null;
   this.frames = []; this.list = []; this.i = 0;
   this.mode = "review"; this.group = "All"; this.view = "image"; this.contrast = 5;
   this.showDets = true; this.showCentre = false; this.gap = 30; this.advance = true; this.strongFirst = false;
   this.entry = { flags: [], trails: [], note: "" }; this.armed = null; this.p0 = null; this.mouse = null;
   this.entryFrame = null; this.entryMode = null;   // the frame and mode the edited entry belongs to
   this.s = 0.1; this.ox = 0; this.oy = 0; this.atFit = true; this.press = null; this.fast = false;
   this.data = null; this.refCache = { group: null, ref: undefined }; this.coords = ""; this.loading = false;
   this.bmpCache = [null, null]; this.buttonSets = null; this.flagButtons = {};

   // ---- top bar
   this.openButton = new PushButton(this);
   this.openButton.text = "Open folder...";
   this.openButton.onClick = function() { d.askRoot(); };
   this.modeBox = new Control(this);
   this.reviewRadio = new RadioButton(this.modeBox); this.reviewRadio.text = "Review cleaned frames";
   this.huntRadio = new RadioButton(this.modeBox); this.huntRadio.text = "Hunt all frames";
   this.debandRadio = new RadioButton(this.modeBox); this.debandRadio.text = "Deband QC";
   this.modeBox.sizer = new HorizontalSizer; this.modeBox.sizer.spacing = 6;
   this.modeBox.sizer.add(this.reviewRadio); this.modeBox.sizer.add(this.huntRadio); this.modeBox.sizer.add(this.debandRadio);
   this.reviewRadio.checked = true;
   this.reviewRadio.onCheck = function(c) { if (c && d.mode !== "review") d.setMode("review"); };
   this.huntRadio.onCheck = function(c) { if (c && d.mode !== "hunt") d.setMode("hunt"); };
   this.debandRadio.onCheck = function(c) { if (c && d.mode !== "deband") d.setMode("deband"); };
   this.strongCheck = new CheckBox(this); this.strongCheck.text = "Strongest first";
   this.strongCheck.toolTip = "Deband QC: list the frames with the strongest removed pattern (relative to their group) first";
   this.strongCheck.onCheck = function(c) { d.strongFirst = c; d.rebuildList(false); };
   this.strongCheck.hide();
   this.groupLabel = new Label(this); this.groupLabel.text = "Group:"; this.groupLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.groupCombo = new ComboBox(this);
   this.groupCombo.addItem("All");
   this.groupCombo.onItemSelected = function(idx) { d.group = d.groupCombo.itemText(idx); d.rebuildList(false); };
   this.viewBox = new Control(this);
   this.viewRadios = {};
   this.viewBox.sizer = new HorizontalSizer; this.viewBox.sizer.spacing = 6;
   var views = [["image", "Image (1)"], ["residual", "Residual (2)"], ["removed", "Removed (3)"]], vi;
   for (vi = 0; vi < views.length; vi++) {
      var rb = new RadioButton(this.viewBox); rb.text = views[vi][1];
      this.viewBox.sizer.add(rb); this.viewRadios[views[vi][0]] = rb;
   }
   this.viewRadios.image.checked = true;
   this.viewRadios.image.onCheck = function(c) { if (c) d.setView("image"); };
   this.viewRadios.residual.onCheck = function(c) { if (c) d.setView("residual"); };
   this.viewRadios.removed.onCheck = function(c) { if (c) d.setView("removed"); };
   this.contrastLabel = new Label(this); this.contrastLabel.text = "Contrast:"; this.contrastLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.contrastSpin = new SpinBox(this); this.contrastSpin.setRange(1, 10); this.contrastSpin.value = 5;
   this.contrastSpin.onValueUpdated = function(v) { d.contrast = v; d.redraw(); };
   this.detsCheck = new CheckBox(this); this.detsCheck.text = "Script detections (D)"; this.detsCheck.checked = true;
   this.detsCheck.onCheck = function(c) { d.showDets = c; d.redraw(); };
   this.centreCheck = new CheckBox(this); this.centreCheck.text = "centre line";
   this.centreCheck.onCheck = function(c) { d.showCentre = c; d.redraw(); };
   this.gapLabel = new Label(this); this.gapLabel.text = "gap (screen px):"; this.gapLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.gapSpin = new SpinBox(this); this.gapSpin.setRange(0, 400); this.gapSpin.stepSize = 5; this.gapSpin.value = 30;
   this.gapSpin.onValueUpdated = function(v) { d.gap = v; d.redraw(); };
   this.top = new HorizontalSizer; this.top.spacing = 8;
   this.top.add(this.openButton); this.top.add(this.modeBox); this.top.add(this.groupLabel); this.top.add(this.groupCombo);
   this.top.add(this.strongCheck);
   this.top.addSpacing(8); this.top.add(this.viewBox); this.top.add(this.contrastLabel); this.top.add(this.contrastSpin);
   this.top.add(this.detsCheck); this.top.add(this.centreCheck); this.top.add(this.gapLabel); this.top.add(this.gapSpin);
   this.top.addStretch();

   this.info = new Label(this); this.info.styleSheet = "QLabel { font-weight: bold; }";
   this.dinfo = new Label(this); this.dinfo.styleSheet = "QLabel { color: #555555; }";

   // ---- image panels
   this.panels = [];
   for (var ci = 0; ci < 2; ci++) this.panels.push(this.makePanel(ci));
   this.mid = new HorizontalSizer; this.mid.spacing = 3;
   this.mid.add(this.panels[0], 100); this.mid.add(this.panels[1], 100);

   // ---- bottom bar
   this.flagBox = new Control(this);
   this.flagBox.sizer = new HorizontalSizer; this.flagBox.sizer.spacing = 4;
   this.flagButtons = {};
   this.undoButton = new PushButton(this); this.undoButton.text = "Undo trail (Backspace)";
   this.undoButton.onClick = function() { d.undoTrail(); };
   this.clearButton = new PushButton(this); this.clearButton.text = "Clear trails";
   this.clearButton.onClick = function() { d.clearTrails(); };
   this.noteLabel = new Label(this); this.noteLabel.text = "Note:"; this.noteLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.noteEdit = new Edit(this); this.noteEdit.setScaledMinWidth(260);
   this.noteEdit.onEditCompleted = function() { d.commit(); };
   this.noteEdit.onReturnPressed = function() { d.commit(); try { d.panels[0].hasFocus = true; } catch (e) {} };
   this.advanceCheck = new CheckBox(this); this.advanceCheck.text = "Advance after Correct / No trail / Clean"; this.advanceCheck.checked = true;
   this.advanceCheck.onCheck = function(c) { d.advance = c; };
   this.prevButton = new PushButton(this); this.prevButton.text = "< Prev"; this.prevButton.onClick = function() { d.go(-1); };
   this.nextButton = new PushButton(this); this.nextButton.text = "Next >"; this.nextButton.onClick = function() { d.go(1); };
   this.nextUnButton = new PushButton(this); this.nextUnButton.text = "Next unlabeled >>"; this.nextUnButton.onClick = function() { d.nextUnlabeled(); };
   this.bottom = new HorizontalSizer; this.bottom.spacing = 4;
   this.bottom.add(this.flagBox); this.bottom.add(this.undoButton); this.bottom.add(this.clearButton);
   this.bottom.add(this.noteLabel); this.bottom.add(this.noteEdit, 100); this.bottom.addSpacing(8);
   this.bottom.add(this.advanceCheck); this.bottom.add(this.prevButton); this.bottom.add(this.nextButton); this.bottom.add(this.nextUnButton);
   this.status = new Label(this); this.status.styleSheet = "QLabel { border-top: 1px solid #a0a0a0; padding: 2px; }";

   this.sizer = new VerticalSizer; this.sizer.margin = 6; this.sizer.spacing = 4;
   this.sizer.add(this.top); this.sizer.add(this.info); this.sizer.add(this.dinfo);
   this.sizer.add(this.mid, 100); this.sizer.add(this.bottom); this.sizer.add(this.status);
   this.setScaledMinSize(1200, 800);

   this.onKeyPress = function(key, mods) { return d.handleKey(key, mods); };
   this.onClose = function() { d.commit(); if (d.data) d.data.free(); if (d.refCache.ref && d.refCache.ref.img) d.refCache.ref.img.free(); };
   this.makeFlagButtons();
}
TL_Dialog.prototype = new Dialog;

TL_Dialog.prototype.flags = function() {
   return this.mode === "review" ? TL_REVIEW_FLAGS : (this.mode === "deband" ? TL_DEBAND_FLAGS : TL_HUNT_FLAGS);
};

// Flag buttons of every mode are created once; those of the other modes are hidden
TL_Dialog.prototype.makeFlagButtons = function() {
   var d = this, m, i, tabs = { review: TL_REVIEW_FLAGS, hunt: TL_HUNT_FLAGS, deband: TL_DEBAND_FLAGS };
   function clicker(flag) { return function() { d.toggle(flag); }; }
   if (!this.buttonSets) {
      this.buttonSets = {};
      for (m in tabs) if (tabs.hasOwnProperty(m)) {
         this.buttonSets[m] = {};
         for (i = 0; i < tabs[m].length; i++) {
            var b = new PushButton(this.flagBox);
            b.onClick = clicker(tabs[m][i][0]);
            this.flagBox.sizer.add(b);
            this.buttonSets[m][tabs[m][i][0]] = b;
         }
      }
   }
   for (m in this.buttonSets) if (this.buttonSets.hasOwnProperty(m))
      for (var f in this.buttonSets[m]) if (this.buttonSets[m].hasOwnProperty(f)) {
         if (m === this.mode) this.buttonSets[m][f].show(); else this.buttonSets[m][f].hide();
      }
   this.flagButtons = this.buttonSets[this.mode];
   this.updateButtons();
};

TL_Dialog.prototype.updateButtons = function() {
   var fl = this.flags(), i, b, on;
   for (i = 0; i < fl.length; i++) {
      b = this.flagButtons[fl[i][0]];
      if (!b) continue;
      on = TL_inArray(this.entry.flags, fl[i][0]);
      b.text = (this.armed === fl[i][0] ? "* " : "") + fl[i][1] + " (" + fl[i][2] + ")";
      b.styleSheet = on ? "QPushButton { background-color: " + fl[i][3] + "; color: white; font-weight: bold; }" : "";
   }
   this.viewRadios.removed.enabled = this.mode !== "hunt";
   this.viewRadios.residual.text = this.mode === "deband" ? "Detail (2)" : "Residual (2)";
   this.updateStatus();
};

// ---- data set and navigation
TL_Dialog.prototype.askRoot = function() {
   var dd = new GetDirectoryDialog;
   dd.caption = "WBPP output folder (holds registered/ and detrailed/, or debanded/)";
   if (this.root) dd.initialPath = this.root;
   if (dd.execute()) this.openRoot(dd.directory);
};

TL_Dialog.prototype.openRoot = function(dir) {
   var root = TL_findRoot(dir);
   if (!root) { new MessageBox("No registered/ or " + TL_DEBAND_DIR + "/ folder in or above\n" + dir, "TrailBlink", StdIcon_Error, StdButton_Ok).execute(); return; }
   this.commit();
   this.entryFrame = null;
   this.root = root;
   this.frames = TL_scan(root);
   this.labelsPath = root + "/" + TL_LABEL_FILE;
   try { this.labels = TL_loadLabels(this.labelsPath, root); }
   catch (e) {
      new MessageBox("Cannot read " + this.labelsPath + ":\n" + e.message, "TrailBlink", StdIcon_Error, StdButton_Ok).execute();
      this.labels = null; return;
   }
   if (this.data) { this.data.free(); this.data = null; }
   Settings.write(TL_SETTINGS + "root", DataType_UCString, root);
   var groups = {}, i, names = [];
   for (i = 0; i < this.frames.length; i++) groups[this.frames[i].short] = 1;
   for (var g in groups) if (groups.hasOwnProperty(g)) names.push(g);
   names.sort();
   this.groupCombo.clear(); this.groupCombo.addItem("All");
   for (i = 0; i < names.length; i++) this.groupCombo.addItem(names[i]);
   this.groupCombo.currentItem = 0; this.group = "All";
   this.windowTitle = "TrailBlink " + TL_VERSION + "  -  " + root + "  -  labels: " + this.labelsPath;
   var nTrail = 0, nDeb = 0;
   for (i = 0; i < this.frames.length; i++) { if (this.frames[i].stage === "deband") nDeb++; else nTrail++; }
   console.writeln("TrailBlink: " + nTrail + " registered frames, " + nDeb + " debanded frames in " + root);
   // a folder with only debanded frames opens in Deband QC; with only registered frames, not in it
   // (mode first: checking a radio button may call its onCheck, which then has nothing to do)
   if (nTrail === 0 && nDeb > 0 && this.mode !== "deband") { this.setMode("deband"); this.debandRadio.checked = true; return; }
   if (nDeb === 0 && nTrail > 0 && this.mode === "deband") { this.setMode("review"); this.reviewRadio.checked = true; return; }
   this.rebuildList(true);
};

TL_Dialog.prototype.setMode = function(mode) {
   this.commit();
   this.mode = mode; this.armed = null; this.p0 = null;
   this.makeFlagButtons();
   if (mode === "hunt") {
      this.panels[1].hide(); this.showDets = false;
      if (this.view === "removed") { this.view = "residual"; this.viewRadios.residual.checked = true; }
   } else { this.panels[1].show(); this.showDets = mode === "review"; }
   this.detsCheck.checked = this.showDets;
   this.detsCheck.enabled = this.centreCheck.enabled = this.gapSpin.enabled = mode !== "deband";
   if (mode === "deband") this.strongCheck.show(); else this.strongCheck.hide();
   this.atFit = true;
   if (this.data) { this.data.free(); this.data = null; }
   this.rebuildList(true);
};

TL_Dialog.prototype.setView = function(v) {
   if (v === "removed" && this.mode === "hunt") return;
   this.view = v;
   if (!this.viewRadios[v].checked) this.viewRadios[v].checked = true;
   this.redraw();
};

TL_Dialog.prototype.rebuildList = function(firstUnlabeled) {
   var cur = this.list.length ? this.list[this.i].key : null, review = this.mode === "review", i;
   var stage = this.mode === "deband" ? "deband" : "trail";
   this.list = [];
   for (i = 0; i < this.frames.length; i++) {
      var f = this.frames[i];
      if (f.stage === stage && (this.group === "All" || f.short === this.group) && (f.det || !review)) this.list.push(f);
   }
   if (this.mode === "deband" && this.strongFirst)
      this.list.sort(function(a, b) { return (b.ratio - a.ratio) || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)); });
   if (this.list.length === 0) {
      this.entryFrame = null;
      if (this.data) { this.data.free(); this.data = null; }
      this.info.text = "No frame to show in this mode" + (review ? " (no cleaned frame: has the script run on this folder?)"
         : (this.mode === "deband" ? " (no " + TL_DEBAND_DIR + "/ folder: has the DebandDesat_WBPP builder run on this folder?)" : ""));
      this.dinfo.text = "";
      this.redraw();
      return;
   }
   var idx = 0;
   if (cur !== null && !firstUnlabeled) for (i = 0; i < this.list.length; i++) if (this.list[i].key === cur) idx = i;
   if (firstUnlabeled) for (i = 0; i < this.list.length; i++) if (!TL_labelled(this.labels, this.list[i], this.mode)) { idx = i; break; }
   this.showFrame(idx);
};

TL_Dialog.prototype.go = function(step) {
   if (this.list.length) this.showFrame(Math.max(0, Math.min(this.list.length - 1, this.i + step)));
};

TL_Dialog.prototype.nextUnlabeled = function() {
   var n = this.list.length, j, k;
   for (j = 1; j <= n; j++) {
      k = (this.i + j) % n;
      if (!TL_labelled(this.labels, this.list[k], this.mode)) { this.showFrame(k); return; }
   }
   new MessageBox("Every frame in this list is labelled.", "TrailBlink", StdIcon_Information, StdButton_Ok).execute();
};

TL_Dialog.prototype.showFrame = function(i) {
   this.commit();
   if (this.list.length === 0) return;
   var same = this.data && this.data.fr.key === this.list[i].key && this.data.mode === this.mode;
   this.i = i;
   var fr = this.list[i], e = TL_entryOf(this.labels, fr, this.mode);
   this.entry = e ? TL_copy(e) : { flags: [], trails: [], note: "" };
   if (!this.entry.flags) this.entry.flags = [];
   if (!this.entry.trails) this.entry.trails = [];
   this.noteEdit.text = this.entry.note || "";
   this.entryFrame = fr; this.entryMode = this.mode;
   this.armed = null; this.p0 = null;
   var showing = this.mode === "review" ? "registered | detrailed"
      : (this.mode === "deband" ? "before deband | debanded"
      : (fr.det ? "detrailed (cleaned by the script)" : "registered (not cleaned by the script)"));
   this.info.text = fr.short + " #" + fr.index + "   " + TL_frameTime(fr.file) + "   [" + (i + 1) + " / " + this.list.length
      + "]   showing: " + showing + "   -   " + fr.file;
   this.dinfo.text = (this.mode === "deband" ? "Deband: " : "Script: ") + (fr.action || "not in report") + "   " + fr.details.substring(0, 400);
   this.updateButtons();
   if (!same) {
      if (this.data) { this.data.free(); this.data = null; }
      this.bmpCache = [null, null];
      this.loading = true; this.redraw(); processEvents();
      try {
         console.writeln("TrailBlink: loading " + fr.key);
         this.data = new TL_FrameData(fr, this.mode, this.refCache);
         console.writeln(format("  %.1f s, gain %.3f, noise %.3g per px", this.data.loadS, this.data.gain, this.data.sigF));
         if (this.data.bands) console.writeln("  " + this.bandText());
      } catch (ex) {
         this.data = null;
         new MessageBox("Cannot load " + fr.key + ":\n" + ex.message, "TrailBlink", StdIcon_Error, StdButton_Ok).execute();
      }
      this.loading = false;
      gc();
   }
   if (this.data && this.data.bands) this.dinfo.text += "   |   " + this.bandText();
   if (this.atFit || !same) this.fit(); else this.redraw();
};

// Deband QC: banding before and after (high-passed row and column means, noise units per pixel)
TL_Dialog.prototype.bandText = function() {
   var b = this.data.bands;
   return format("row bands %.3f -> %.3f, column bands %.3f -> %.3f (noise per px)",
      b.before.rows, b.after.rows, b.before.cols, b.after.cols);
};

// ---- labels
// Saves the edited entry to the frame and mode it was loaded for (never to another frame: when a
// folder is opened or the list changes, the blank initial state must not overwrite a label).
TL_Dialog.prototype.commit = function() {
   if (this.entryFrame === null || this.labels === null) return;
   var fr = this.entryFrame, mode = this.entryMode, e = this.entry;
   e.note = this.noteEdit.text.trim();
   var empty = e.flags.length === 0 && e.trails.length === 0 && e.note === "";
   var old = TL_entryOf(this.labels, fr, mode);
   if (empty && old === null) return;
   if (old !== null && JSON.stringify(old.flags) === JSON.stringify(e.flags)
       && JSON.stringify(old.trails || []) === JSON.stringify(e.trails) && (old.note || "") === e.note) return;
   var size = (this.data && this.data.fr.key === fr.key) ? [this.data.W, this.data.H] : null;
   TL_put(this.labels, fr, mode, empty ? null : e, size);
   try { TL_saveLabels(this.labelsPath, this.labels); }
   catch (ex) { console.criticalln("TrailBlink: cannot save " + this.labelsPath + ": " + ex.message); }
   this.updateStatus();
};

TL_Dialog.prototype.ask = function(text) {
   return new MessageBox(text, "TrailBlink", StdIcon_Question, StdButton_Yes, StdButton_No).execute() === StdButton_Yes;
};

TL_Dialog.prototype.toggle = function(flag) {
   if (!this.list.length || this.labels === null) return;
   var st = { entry: this.entry, armed: this.armed, p0: this.p0 }, r = TL_toggle(st, flag, this.mode);
   if (r.ask) {
      if (!this.ask(r.ask.text)) return;
      r.ask.then(); r.changed = true;
   }
   this.armed = st.armed; this.p0 = st.p0;
   this.commit();
   this.updateButtons();
   this.redraw();
   if (r.advance && this.advance) this.go(1);
};

TL_Dialog.prototype.addPoint = function(x, y) {
   x = Math.min(Math.max(x, 0), this.data.W - 1); y = Math.min(Math.max(y, 0), this.data.H - 1);
   if (this.p0 === null) this.p0 = [x, y];
   else {
      if (Math.sqrt((x - this.p0[0]) * (x - this.p0[0]) + (y - this.p0[1]) * (y - this.p0[1])) >= 3) {
         this.entry.trails.push({ kind: this.armed, x0: Math.round(this.p0[0] * 10) / 10, y0: Math.round(this.p0[1] * 10) / 10,
                                  x1: Math.round(x * 10) / 10, y1: Math.round(y * 10) / 10 });
         this.commit();
      }
      this.p0 = null;
   }
   this.redraw();
};

TL_Dialog.prototype.undoTrail = function() {
   if (this.p0 !== null) this.p0 = null;
   else if (this.entry.trails.length) { this.entry.trails.pop(); this.commit(); }
   this.redraw();
};

TL_Dialog.prototype.clearTrails = function() {
   if (this.entry.trails.length && this.ask("Remove all " + this.entry.trails.length + " drawn trail(s)?")) {
      this.entry.trails = []; this.p0 = null; this.commit(); this.redraw();
   }
};

// ---- view geometry
TL_Dialog.prototype.fit = function() {
   if (!this.data) { this.redraw(); return; }
   var cv = this.panels[0], cw = Math.max(cv.width, 50), ch = Math.max(cv.height, 50);
   this.s = Math.min(cw / this.data.W, ch / this.data.H);
   this.ox = (this.data.W - cw / this.s) / 2; this.oy = (this.data.H - ch / this.s) / 2;
   this.atFit = true;
   this.redraw();
};
TL_Dialog.prototype.toImg = function(ex, ey) { return [this.ox + ex / this.s, this.oy + ey / this.s]; };
TL_Dialog.prototype.toScr = function(x, y) { return [(x - this.ox) * this.s, (y - this.oy) * this.s]; };
TL_Dialog.prototype.zoomAt = function(ex, ey, f) {
   if (!this.data) return;
   var cv = this.panels[0], fit = Math.min(Math.max(cv.width, 50) / this.data.W, Math.max(cv.height, 50) / this.data.H);
   var p = this.toImg(ex, ey);
   this.atFit = false;
   this.s = Math.min(Math.max(this.s * f, fit * 0.5), 16);
   this.ox = p[0] - ex / this.s; this.oy = p[1] - ey / this.s;
   this.redraw();
};

TL_Dialog.prototype.redraw = function() {
   this.panels[0].repaint();
   if (this.mode !== "hunt") this.panels[1].repaint();
   this.updateStatus();
};

TL_Dialog.prototype.updateStatus = function() {
   var msg = [], n, i;
   if (this.armed) msg.push("DRAWING " + TL_KIND_SHORT[this.armed] + ": click both ends of the trail (Esc stops, Backspace undoes)"
      + (this.p0 ? "  - first end set" : ""));
   if (this.list.length && this.labels !== null) {
      n = 0; for (i = 0; i < this.list.length; i++) if (TL_labelled(this.labels, this.list[i], this.mode)) n++;
      msg.push("labelled " + n + " / " + this.list.length);
   }
   if (this.data) {
      msg.push(format("zoom %.3g  (%s)", this.s, (this.s >= 1 && !this.fast) ? "full resolution" : TL_BIN + "x" + TL_BIN + " binned"));
      msg.push(format("noise: %.3g per px, %.3g per bin", this.data.sigF, this.data.sigB));
   }
   if (this.coords) msg.push(this.coords);
   this.status.text = msg.join("   |   ");
};

TL_Dialog.prototype.panelTitle = function(ci) {
   var v = this.view;
   if (this.mode === "deband") {
      if (ci === 0) return "Before deband" + (v === "image" ? "" : " - background (noise units)");
      return v === "image" ? "Debanded" : (v === "residual" ? "Debanded - background (noise units)" : "Removed by deband (before - debanded)");
   }
   if (this.mode !== "review")
      return ((this.data && this.data.aIsDet) ? "Detrailed" : "Registered") + (v === "image" ? "" : " - matched reference (noise units)");
   if (ci === 0) return "Registered" + (v === "image" ? "" : " - matched reference");
   return v === "image" ? "Detrailed" : (v === "residual" ? "Detrailed - matched reference" : "Removed by the script (registered - detrailed)");
};

// Bitmap of panel ci for the current view; or a message string; or null
TL_Dialog.prototype.renderPanel = function(ci, cw, ch) {
   var dt = this.data, s = this.s, src = ci === 0 ? "a" : "b", k = this.contrast, view = this.view;
   var key = [dt.fr.key, this.mode, view, k, s, this.ox, this.oy, cw, ch, this.fast, src].join("|");
   if (this.bmpCache[ci] && this.bmpCache[ci].key === key) return this.bmpCache[ci].bmp;
   var out = new Float32Array(cw * ch), sx, sy, i, X, Y, BG = 0.13, bmp;
   for (i = 0; i < out.length; i++) out[i] = BG;
   if (s < 1 || this.fast) {
      var bd = dt.binnedDisplay(src, view, k);
      if (bd === null) return "Residual needs the reference stack (STR_reference.xisf)";
      var B = TL_BIN, bw = dt.bw, bh = dt.bh, f = 1 / (s * B), x0, x1, y0, y1, ix0, ix1, iy0, iy1;
      for (sy = 0; sy < ch; sy++) {
         y0 = (this.oy + sy / s) / B; y1 = y0 + f;
         if (y1 <= 0 || y0 >= bh) continue;
         iy0 = Math.max(0, Math.floor(y0)); iy1 = Math.min(bh, Math.max(iy0 + 1, Math.round(y1)));
         for (sx = 0; sx < cw; sx++) {
            x0 = (this.ox + sx / s) / B; x1 = x0 + f;
            if (x1 <= 0 || x0 >= bw) continue;
            ix0 = Math.max(0, Math.floor(x0)); ix1 = Math.min(bw, Math.max(ix0 + 1, Math.round(x1)));
            out[sy * cw + sx] = TL_satSum(bd.S, bw, ix0, iy0, ix1, iy1) / ((ix1 - ix0) * (iy1 - iy0));
         }
      }
   } else {
      var X0 = Math.max(0, Math.floor(this.ox)), Y0 = Math.max(0, Math.floor(this.oy));
      var X1 = Math.min(dt.W, Math.ceil(this.ox + cw / s)), Y1 = Math.min(dt.H, Math.ceil(this.oy + ch / s));
      if (X1 > X0 && Y1 > Y0) {
         var D = dt.fullDisplay(src, view, k, X0, Y0, X1, Y1), w = X1 - X0;
         if (D === null) return "Residual needs the reference stack (STR_reference.xisf)";
         for (sy = 0; sy < ch; sy++) {
            Y = Math.floor(this.oy + (sy + 0.5) / s);
            if (Y < Y0 || Y >= Y1) continue;
            for (sx = 0; sx < cw; sx++) {
               X = Math.floor(this.ox + (sx + 0.5) / s);
               if (X < X0 || X >= X1) continue;
               out[sy * cw + sx] = D[(Y - Y0) * w + (X - X0)];
            }
         }
      }
   }
   var img = new Image(out, cw, ch);
   bmp = img.render();
   img.free();
   this.bmpCache[ci] = { key: key, bmp: bmp };
   return bmp;
};

TL_Dialog.prototype.paintPanel = function(ctl, ci) {
   var g = new Graphics(ctl), cw = ctl.width, ch = ctl.height;
   try {
      g.fillRect(0, 0, cw, ch, new Brush(0xff202020));
      g.pen = new Pen(0xffffffff);
      if (this.loading || !this.data) {
         g.drawTextRect(0, 0, cw, ch, this.loading ? "Loading..." : (this.list.length ? "" : "Open a WBPP output folder"), TextAlign_Center);
         return;
      }
      var r = this.renderPanel(ci, cw, ch);
      if (typeof r === "string") g.drawTextRect(0, 0, cw, ch, r, TextAlign_Center);
      else if (r) g.drawBitmap(0, 0, r);
      g.antialiasing = true;
      this.drawOverlays(g);
      var t = this.panelTitle(ci), tw = ctl.font.width(t) + 12;
      g.fillRect(0, 0, tw, 22, new Brush(0xff000000));
      g.pen = new Pen(0xffffff60);
      g.drawText(6, 16, t);
   } finally { g.end(); }
};

TL_Dialog.prototype.drawOverlays = function(g) {
   var i, a, b, t, col, p;
   if (this.showDets) {
      for (i = 0; i < this.data.dets.length; i++) {
         var det = this.data.dets[i];
         if (det.kind === "line") {
            var L = Math.sqrt((det.x1 - det.x0) * (det.x1 - det.x0) + (det.y1 - det.y0) * (det.y1 - det.y0)) || 1;
            var nx = -(det.y1 - det.y0) / L, ny = (det.x1 - det.x0) / L;
            a = this.toScr(det.x0, det.y0); b = this.toScr(det.x1, det.y1);
            var off = Math.max(det.hw * this.s, this.gap), offs = [off, -off], j;
            g.pen = new Pen(0xff30e0ff, 1, PenStyle_Dash);
            if (this.showCentre) offs.push(0);
            for (j = 0; j < offs.length; j++) {
               if (offs[j] === 0) g.pen = new Pen(0xff30e0ff, 1, PenStyle_Dot);
               g.drawLine(a[0] + offs[j] * nx, a[1] + offs[j] * ny, b[0] + offs[j] * nx, b[1] + offs[j] * ny);
            }
            g.pen = new Pen(0xff30e0ff);
            var mx = (a[0] + b[0]) / 2 + (off + 6) * nx, my = (a[1] + b[1]) / 2 + (off + 6) * ny, lab = "z " + det.z.toFixed(1);
            g.drawText(nx >= 0 ? mx : mx - g.font.width(lab), my + 5, lab);
         } else {
            a = this.toScr(det.cx, det.cy);
            var rr = Math.max(6, 0.5 * det.len * this.s);
            g.pen = new Pen(0xff30e0ff, 1, PenStyle_Dot);
            g.drawEllipse(a[0] - rr, a[1] - rr, a[0] + rr, a[1] + rr);
            g.pen = new Pen(0xff30e0ff);
            g.drawText(a[0] + rr + 4, a[1] + 5, "blob " + det.len + "x" + det.wid);
         }
      }
   }
   for (i = 0; i < this.entry.trails.length; i++) {
      t = this.entry.trails[i];
      a = this.toScr(t.x0, t.y0); b = this.toScr(t.x1, t.y1);
      col = TL_KIND_COLOR[t.kind] || 0xffffffff;
      g.pen = new Pen(col, 2);
      g.drawLine(a[0], a[1], b[0], b[1]);
      g.drawEllipse(a[0] - 4, a[1] - 4, a[0] + 4, a[1] + 4);
      g.drawEllipse(b[0] - 4, b[1] - 4, b[0] + 4, b[1] + 4);
      g.drawText((a[0] + b[0]) / 2 + 8, (a[1] + b[1]) / 2 + 5, TL_KIND_SHORT[t.kind] || "?");
   }
   if (this.p0 !== null && this.armed) {
      p = this.toScr(this.p0[0], this.p0[1]);
      g.pen = new Pen(TL_KIND_COLOR[this.armed], 2);
      g.drawEllipse(p[0] - 5, p[1] - 5, p[0] + 5, p[1] + 5);
      if (this.mouse) {
         g.pen = new Pen(TL_KIND_COLOR[this.armed], 1, PenStyle_Dash);
         g.drawLine(p[0], p[1], this.mouse[0], this.mouse[1]);
      }
   }
};

TL_Dialog.prototype.makePanel = function(ci) {
   var d = this, c = new Control(this);
   c.setScaledMinSize(300, 300);
   c.mouseTracking = true;
   c.focusStyle = FocusStyle_Click | FocusStyle_Wheel;
   c.cursor = new Cursor(StdCursor_Cross);
   c.onPaint = function() { d.paintPanel(this, ci); };
   c.onResize = function() { d.bmpCache = [null, null]; if (d.atFit) d.fit(); };
   c.onMousePress = function(x, y, button) {
      try { this.hasFocus = true; } catch (e) {}
      d.press = { x: x, y: y, button: button, ox: d.ox, oy: d.oy, dragged: false };
   };
   c.onMouseMove = function(x, y, buttons) {
      d.mouse = [x, y];
      if (d.data) { var p = d.toImg(x, y); d.coords = "x = " + Math.floor(p[0]) + "   y = " + Math.floor(p[1]); }
      if (d.press && buttons) {
         var dx = x - d.press.x, dy = y - d.press.y;
         if (!d.press.dragged && Math.abs(dx) + Math.abs(dy) < 5) return;
         d.press.dragged = true; d.atFit = false; d.fast = true;
         d.ox = d.press.ox - dx / d.s; d.oy = d.press.oy - dy / d.s;
         d.redraw();
         return;
      }
      if (d.p0 !== null) d.redraw(); else d.updateStatus();
   };
   c.onMouseRelease = function(x, y, button) {
      if (!d.press) return;
      var pr = d.press; d.press = null;
      if (pr.dragged) { d.fast = false; d.redraw(); }
      else if (button === MouseButton_Left && d.armed && d.data) { var p = d.toImg(x, y); d.addPoint(p[0], p[1]); }
   };
   c.onMouseWheel = function(x, y, dy) { d.zoomAt(x, y, Math.pow(1.25, dy / 120)); };
   c.onKeyPress = function(key, mods) { return d.handleKey(key, mods); };
   return c;
};

TL_Dialog.prototype.handleKey = function(key, mods) {
   if (this.noteEdit.hasFocus) return false;
   if (mods & (KeyModifier_Control | KeyModifier_Alt)) return false;
   var fl = this.flags(), i;
   for (i = 0; i < fl.length; i++) if (key === fl[i][2].charCodeAt(0)) { this.toggle(fl[i][0]); return true; }
   if (key === Key_Right || key === Key_PageDown || key === Key_N) { this.go(1); return true; }
   if (key === Key_Left || key === Key_PageUp || key === Key_P) { this.go(-1); return true; }
   if (key === Key_Backspace) { this.undoTrail(); return true; }
   if (key === Key_Escape) { this.armed = null; this.p0 = null; this.updateButtons(); this.redraw(); return true; }
   if (key >= 0x31 && key <= 0x33) { this.setView(["image", "residual", "removed"][key - 0x31]); return true; }
   if (key === 0x30 || key === Key_Home) { this.fit(); return true; }
   if (key === Key_D && this.mode !== "deband") { this.showDets = !this.showDets; this.detsCheck.checked = this.showDets; this.redraw(); return true; }
   if (key === Key_Plus || key === Key_Equal) { this.zoomAt(this.panels[0].width / 2, this.panels[0].height / 2, 1.5); return true; }
   if (key === Key_Minus) { this.zoomAt(this.panels[0].width / 2, this.panels[0].height / 2, 1 / 1.5); return true; }
   return false;
};

function main() {
   console.show();
   var dlg = new TL_Dialog();
   var last = Settings.read(TL_SETTINGS + "root", DataType_UCString);
   if (Settings.lastReadOK && last && (File.directoryExists(last + "/registered") || File.directoryExists(last + "/" + TL_DEBAND_DIR)))
      dlg.openRoot(last);
   dlg.execute();
}

main();
