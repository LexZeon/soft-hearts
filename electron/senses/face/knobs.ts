/**
 * I-135 认出"不是你": every threshold of the face check in one place (docs/claude/2026-11-14-i135-face-plan.md).
 *
 * Decisions (2026-11-14): only the user's own face is enrolled; when unsure it counts as the user — side face, dark, blurry, no face,
 * a middling score all count as the user; only a clear frontal face with a low similarity, twice in a row, is "not you".
 *
 * The cosine numbers start from OpenCV's guidance for SFace (cosine ≥ 0.363 = same person, opencv_zoo
 * models/face_recognition_sface) and are NOT yet calibrated on the user's real face: calibrate `match.*`, `quality.*`
 * and `augment.minCosine` on real checks before trusting them (the counts in the journal are there for that).
 */
export const FACE_KNOBS = Object.freeze({
  detector: Object.freeze({
    /** YuNet 2023mar is exported with a fixed 1×3×640×640 input. */
    inputSize: 640,
    /** Candidates below this are dropped before NMS (OpenCV's default is 0.9; the "clear" bar below is separate). */
    scoreThreshold: 0.6,
    nmsThreshold: 0.3,
    topK: 20,
  }),
  /** A "clear" face: only a clear face can ever count as "not you" (or be enrolled / added). */
  quality: Object.freeze({
    minDetScore: 0.9,
    /** Face box width in the source frame (frames are ≤ 640×480; the sensor and the small pictures are 320×240). */
    minFaceWidthPx: 56,
    /** 0..1 from the five landmarks (1 = looking straight at the camera). */
    minFrontal: 0.7,
    /** Variance of the Laplacian on the 112×112 aligned grey crop (0..255 scale). To calibrate on real frames. */
    minSharpness: 30,
    /** Mean grey level of the aligned crop. */
    minBrightness: 45,
    maxBrightness: 225,
  }),
  match: Object.freeze({
    /** At or above: clearly the user (OpenCV SFace cosine threshold). */
    sameCosine: 0.363,
    /**
     * Below, on a clear face: clearly not the user. 2026-11-25 (the user's own test: a stranger was not told apart): was 0.20, a line far
     * under OpenCV's 0.363, so everyone scoring 0.20..0.363 passed as the user. Now 0.363 minus a buffer of about 0.06, so one noisy frame
     * on the user's own face (which seldom falls under 0.30) does not tip it. Source of 0.363: opencv_zoo sface.py (cosine >= 0.363 = same person).
     */
    clearlyNotCosine: 0.3,
    /**
     * A clear face scoring between clearlyNotCosine and sameCosine (the grey band under the official line) is a "weak low": it does not
     * break a streak of lows and counts this much of one clear low, so a few of them in a row (4 at 0.5) are enough, but a single one never is.
     */
    weakNotWeight: 0.5,
    /** Weight of consecutive lows (a clear low = 1, a weak low = weakNotWeight) before the state becomes 'not-you'. */
    notYouStreak: 2,
    /**
     * While 'not-you': consecutive uncertain checks (no face, side face, blurry, middling) that bring it back to 'you'.
     * 2 rather than 1 so one blurry frame while the stranger types does not flip her back mid-conversation; a clear match
     * returns at once. Decision recorded in docs/claude/2026-11-14-i135-face-build.md.
     */
    unsureToReturn: 2,
    /** 'not-you' with no check at all for this long (camera stalled) goes back to 'you'. */
    notYouExpireMs: 60_000,
  }),
  /** Occasionally add one more embedding when a match is very confident and looks different from what is stored. */
  augment: Object.freeze({
    cap: 12,
    minCosine: 0.55,
    minFrontal: 0.85,
    minDetScore: 0.95,
    minSharpness: 45,
    /** Diversity: skip it when it is this similar (or more) to one already stored. */
    maxSimilarToStored: 0.85,
    minIntervalMs: 10 * 60_000,
  }),
  enrol: Object.freeze({
    /** "Look at the camera for a few seconds": this many good samples… */
    samples: 5,
    /** …at least this many, or the enrolment fails and nothing is stored. */
    minSamples: 3,
    timeoutMs: 20_000,
    intervalMs: 350,
    /** A sample this similar to one already taken is the same frame again: skipped. */
    duplicateCosine: 0.97,
  }),
  schedule: Object.freeze({
    /** Low-rate continuous check while the camera is on. */
    continuousMs: 2_500,
    /** After this many checks in a row without a face, check less often. */
    idleAfterNoFace: 4,
    idleMs: 6_000,
    /** After a leave, someone appears or talks: a short burst of checks. */
    burstChecks: 3,
    burstGapMs: 700,
    /** The scheduler's own tick (only while the feature and the camera are on). */
    tickMs: 500,
    /** A photo about to be sent is checked at most this long; then the current state stands. */
    photoTimeoutMs: 1_500,
    /** One analysis in the worker that takes longer than this is abandoned. */
    analyzeTimeoutMs: 5_000,
  }),
});

export type FaceKnobs = typeof FACE_KNOBS;
