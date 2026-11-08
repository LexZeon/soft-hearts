// Pose feasibility bench: confusion matrices for the rock-paper-scissors comparison (RTMW hand keypoints vs MediaPipe). NOT product code.
// Usage: node analyze-gesture.mjs <runs/gesture-*.json> [more.json ...]
// RTMW rule thresholds are checked on a held-out half: the ratio threshold is chosen on the even-indexed images of each class
// and reported on the odd-indexed ones (plus the untouched default 1.15 on everything).
import { readFileSync } from "node:fs";
import { rpsFromWholeBody } from "./lib/pose.mjs";

const LABELS = ["rock", "paper", "scissors", "none"];
const matrix = () => Object.fromEntries(LABELS.map((t) => [t, Object.fromEntries(LABELS.map((p) => [p, 0]))]));
function stats(m) {
  const per = {}; let ok = 0, n = 0;
  for (const t of LABELS) { const row = m[t]; const tot = LABELS.reduce((a, p) => a + row[p], 0); ok += row[t]; n += tot; per[t] = tot ? row[t] / tot : NaN; }
  return { accuracy: n ? ok / n : NaN, recallPerClass: per, n };
}
const show = (name, m) => {
  const s = stats(m);
  console.log(`\n${name}  (n=${s.n}, accuracy ${(100 * s.accuracy).toFixed(1)}%)`);
  console.log("| truth \\ predicted | rock | paper | scissors | none | recall |");
  console.log("|---|---|---|---|---|---|");
  for (const t of LABELS) { const tot = LABELS.reduce((a, p) => a + m[t][p], 0); if (!tot) continue; console.log(`| ${t} | ${LABELS.map((p) => m[t][p]).join(" | ")} | ${(100 * s.recallPerClass[t]).toFixed(0)}% |`); }
};
const handsOf = (rw) => {
  const flat = (hand) => ({ k: hand.flatMap((p) => [p[0], p[1]]), s: hand.map((p) => p[2]) });
  const L = flat(rw.left), R = flat(rw.right);
  // rebuild a 133-long layout with hands at 91.. and 112.. so rpsFromWholeBody can be reused unchanged
  const kpts = new Float32Array(133 * 2), scores = new Float32Array(133);
  kpts.set(L.k, 91 * 2); kpts.set(R.k, 112 * 2); scores.set(L.s, 91); scores.set(R.s, 112);
  return { kpts, scores };
};

// ---- rule v2 (written AFTER seeing the first results, so it is tuned on the even images and scored only on the odd ones):
// adds a thumb test, requires all four fingers for paper, and lets a thumb-out fist (thumbs-up) fall into "none".
function handFeatures(hand) {
  const P = (i) => hand[i], d = (a, b) => Math.hypot(P(a)[0] - P(b)[0], P(a)[1] - P(b)[1]);
  const palm = d(0, 9) || 1; // wrist to middle-finger knuckle = hand size
  const f = {};
  for (const [name, [m, p, , t]] of Object.entries({ index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] })) f[name] = d(0, t) / (d(0, p) || 1);
  f.thumb = d(4, 5) / palm; // thumb tip to index knuckle, relative to hand size
  f.score = hand.reduce((a, p) => a + p[2], 0) / 21;
  return f;
}
function ruleV2(f, { fingerThr, thumbThr, paperMin, thumbMatters }) {
  const ext = { index: f.index >= fingerThr, middle: f.middle >= fingerThr, ring: f.ring >= fingerThr, pinky: f.pinky >= fingerThr };
  const n = Object.values(ext).filter(Boolean).length, thumbOut = f.thumb >= thumbThr;
  if (n === 0) return thumbMatters && thumbOut ? "none" : "rock";
  if (ext.index && ext.middle && !ext.ring && !ext.pinky) return "scissors";
  if (n >= paperMin) return "paper";
  return "none";
}
function bestHand(rw) { const l = handFeatures(rw.left), r = handFeatures(rw.right); return l.score >= r.score ? l : r; }
function v2Report(r, rows, v, set) {
  const idx = new Map(); const tune = [], test = [];
  for (const row of rows) { const c = idx.get(row.cls) ?? 0; idx.set(row.cls, c + 1); (c % 2 === 0 ? tune : test).push(row); }
  const feats = (row) => bestHand(row.rtmw[v]);
  let best = null;
  for (const fingerThr of [1.0, 1.1, 1.15, 1.2, 1.3]) for (const thumbThr of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) for (const paperMin of [3, 4]) for (const thumbMatters of [false, true]) {
    const m = matrix(); const o = { fingerThr, thumbThr, paperMin, thumbMatters };
    for (const row of tune) m[row.truth][ruleV2(feats(row), o)]++;
    const a = stats(m).accuracy; if (!best || a > best.acc) best = { acc: a, o };
  }
  const m = matrix(); for (const row of test) m[row.truth][ruleV2(feats(row), best.o)]++;
  show(`RTMW ${v} rule v2 ${JSON.stringify(best.o)} tuned on even images (${(100 * best.acc).toFixed(1)}%), scored on odd images`, m);
}

for (const file of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  console.log(`\n=== ${file}\nrows: ${r.rows?.length}  variants: ${r.variants}  mp delegates: ${r.mpDelegates}`);
  const setNames = [...new Set(r.rows.map((x) => x.set))];
  for (const set of setNames) {
    const rows = r.rows.filter((x) => x.set === set);
    console.log(`\n--- image set: ${set} (${rows.length} images)`);
    for (const v of r.variants ?? []) {
      const m = matrix();
      for (const row of rows) m[row.truth][row.rtmw[v].label]++;
      show(`RTMW ${v} (rule as run, ratio 1.15)`, m);
      // held-out threshold check
      const idx = new Map(); const tuneRows = [], testRows = [];
      for (const row of rows) { const c = (idx.get(row.cls) ?? 0); idx.set(row.cls, c + 1); (c % 2 === 0 ? tuneRows : testRows).push(row); }
      let best = { thr: 1.15, acc: -1 };
      for (const thr of [0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4]) {
        const m2 = matrix();
        for (const row of tuneRows) { const { kpts, scores } = handsOf(row.rtmw[v]); m2[row.truth][rpsFromWholeBody(kpts, scores, { ratioThr: thr }).label]++; }
        const a = stats(m2).accuracy; if (a > best.acc) best = { thr, acc: a };
      }
      const m3 = matrix();
      for (const row of testRows) { const { kpts, scores } = handsOf(row.rtmw[v]); m3[row.truth][rpsFromWholeBody(kpts, scores, { ratioThr: best.thr }).label]++; }
      show(`RTMW ${v} threshold ${best.thr} chosen on even images, scored on the odd images`, m3);
      v2Report(r, rows, v, set);
      const noPerson = rows.filter((x) => x.rtmw[v].noPerson).length;
      console.log(`(no person found by the detector on ${noPerson}/${rows.length} images)`);
    }
    for (const dl of r.mpDelegates ?? []) {
      if (!rows[0]?.mp?.[dl]) continue;
      const m = matrix();
      for (const row of rows) m[row.truth][row.mp[dl].label]++;
      show(`MediaPipe Gesture Recognizer (${dl} delegate)`, m);
      { // same odd-index half the RTMW rules were scored on, for a like-for-like comparison
        const idx = new Map(); const mo = matrix();
        for (const row of rows) { const c = idx.get(row.cls) ?? 0; idx.set(row.cls, c + 1); if (c % 2 === 1) mo[row.truth][row.mp[dl].label]++; }
        show(`MediaPipe (${dl}) on the odd-index half only`, mo);
      }
      const raw = {};
      for (const row of rows) raw[row.mp[dl].raw] = (raw[row.mp[dl].raw] ?? 0) + 1;
      console.log("raw categories:", JSON.stringify(raw));
    }
  }
  console.log("\ntiming (ms):", JSON.stringify(r.timing, null, 1));
}
