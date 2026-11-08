import assert from "node:assert/strict";
import test from "node:test";
import type { MoodInput, MoodView } from "../shared/mood-runtime";
import { DEFAULT_MOOD_PARAMETERS } from "../shared/mood";
import { MoodInputQueue } from "../src/ui/MoodCompanion";
import { moodExtendedDifferences } from "../src/ui/MoodPanel";

const view = (token: string, revision = 1) => ({ token, revision } as MoodView);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test("input bridge sends phases and acceptance in exact order through asynchronous IPC", async () => {
  const waiting = deferred<MoodView>();
  const sent: MoodInput[] = [], received: MoodView[] = [];
  const queue = new MoodInputQueue(async input => { sent.push(input); return sent.length === 1 ? waiting.promise : view("one", sent.length); }, result => received.push(result), error => assert.fail(error));
  queue.setToken("one");
  void queue.push({ type: "phase", phase: "food-ready", sessionId: "s" });
  void queue.push({ type: "food", id: "food-1", sessionId: "s" });
  void queue.push({ type: "phase", phase: "food-eating", sessionId: "s" });
  await flush(); assert.deepEqual(sent.map(input => input.type), ["phase"]);
  waiting.resolve(view("one")); await queue.settled();
  assert.deepEqual(sent.map(input => input.type === "phase" ? input.phase : input.type), ["food-ready", "food", "food-eating"]);
  assert.equal(received.length, 3);
});

test("token change rejects a late result and all pending events from the old role or model", async () => {
  const waiting = deferred<MoodView>(); const sent: MoodInput[] = [], received: MoodView[] = [], errors: string[] = [];
  const queue = new MoodInputQueue(async input => { sent.push(input); return input.token === "old" ? waiting.promise : view("new", 3); }, result => received.push(result), error => errors.push(error));
  queue.setToken("old"); void queue.push({ type: "phase", phase: "rua", sessionId: "s-old" });
  void queue.push({ type: "rua", id: "dose-old", sessionId: "s-old", activeMs: 200 });
  await flush(); queue.setToken("new");
  void queue.push({ type: "phase", phase: "rua", sessionId: "s-new" });
  waiting.resolve(view("old", 2)); await queue.settled();
  assert.deepEqual(sent.map(input => input.sessionId), ["s-old", "s-new"]);
  assert.deepEqual(received.map(result => result.token), ["new"]);
  assert.deepEqual(errors, []);
});

test("explicit reset invalidates same-token pending work but permits the cancellation phase", async () => {
  const waiting = deferred<MoodView>(); const sent: MoodInput[] = [], received: MoodView[] = [];
  const queue = new MoodInputQueue(async input => { sent.push(input); return sent.length === 1 ? waiting.promise : view("one", 4); }, result => received.push(result), error => assert.fail(error));
  queue.setToken("one"); void queue.push({ type: "phase", phase: "rua", sessionId: "s" });
  void queue.push({ type: "rua", id: "stale", sessionId: "s", activeMs: 200 });
  await flush(); queue.invalidate();
  void queue.push({ type: "phase", phase: "idle", sessionId: "s" });
  waiting.resolve(view("one", 2)); await queue.settled();
  assert.deepEqual(sent.map(input => input.type === "phase" ? input.phase : input.type), ["rua", "idle"]);
  assert.equal(received.length, 1);
});

test("failed input does not stall following cancellations and disposed queues ignore late work", async () => {
  const errors: string[] = [], sent: MoodInput[] = [];
  const queue = new MoodInputQueue(async input => { sent.push(input); if (sent.length === 1) throw new Error("expired input"); return view("one"); }, () => {}, message => errors.push(message));
  queue.setToken("one"); void queue.push({ type: "food", id: "bad", sessionId: "s" }); await queue.push({ type: "phase", phase: "idle", sessionId: "s" });
  assert.equal(errors.length, 1); assert.equal(sent.length, 2);
  queue.dispose(); await queue.push({ type: "phase", phase: "rua", sessionId: "no" }); assert.equal(sent.length, 2);
});

test("extended parameter confirmation lists new differences and leaves existing accepted values alone", () => {
  const current = structuredClone(DEFAULT_MOOD_PARAMETERS);
  assert.deepEqual(moodExtendedDifferences(current, current), []);
  const candidate = structuredClone(current);
  candidate.sensitivity.O = 2; candidate.weights.close = 3; candidate.baseline.D = 70; candidate.intensity.text = 100; candidate.halfLifeMs.O = 30_000;
  const differences = moodExtendedDifferences(candidate, current);
  assert.equal(differences.length, 5);
  assert.ok(differences.some(text => text.includes("O 事件敏感度") && text.includes("1倍 → 2倍")));
  assert.ok(differences.some(text => text.includes("O 恢复半衰期") && text.includes("0.5分钟")));
  assert.deepEqual(moodExtendedDifferences(candidate, candidate), []);
  assert.deepEqual(moodExtendedDifferences(null, current), []);
});

test("advanced confirmation covers every documented freshness, B/M, quota, evidence and root threshold range", () => {
  const minute = 60_000, hour = 60 * minute;
  const cases: [string, string, number, string][] = [
    ["freshness", "retention", 0.9, "重复保留比例"],
    ["freshness", "floor", 0.01, "重复最低保留比例"],
    ["freshness", "ruaMs", minute, "摸头新鲜度恢复"],
    ["freshness", "foodMs", 5 * minute, "喂食新鲜度恢复"],
    ["freshness", "chatMs", 2 * minute, "重复话题新鲜度恢复"],
    ["", "fastThreshold", 20, "快变判定门槛"],
    ["evidence", "level", 2, "当前水平响应"],
    ["evidence", "trend", 0, "快变响应"],
    ["boredom", "graceMs", 0, "无聊积累宽限"],
    ["boredom", "perMinute", 10, "无聊增速"],
    ["boredom", "lookAt", 10, "无聊注视门槛"],
    ["boredom", "motionAt", 80, "无聊小动作门槛"],
    ["boredom", "speechAt", 99, "无聊主动说话门槛"],
    ["longing", "graceMs", hour, "想念积累宽限"],
    ["longing", "perHour", 0, "想念增速"],
    ["longing", "longingAt", 10, "想念候选门槛"],
    ["longing", "sadAt", 80, "想念伤感门槛"],
    ["longing", "cryAt", 99, "想念哭泣门槛"],
    ["longing", "cryCooldownMs", hour, "哭泣冷却"],
    ["longing", "cryDurationMs", 30_000, "明显哭泣时长"],
    ["frequency", "motionIntervalMs", minute, "主动小动作间隔"],
    ["frequency", "speechIntervalMs", 5 * minute, "主动发言间隔"],
    ["frequency", "speechPerHour", 10, "滚动一小时主动发言上限"],
    ["frequency", "speechWithoutReply", 5, "无人回应期间主动发言上限"],
  ];
  for (const [group, key, value, label] of cases) {
    const current = structuredClone(DEFAULT_MOOD_PARAMETERS);
    const candidate = structuredClone(current);
    const fields = group ? (candidate as unknown as Record<string, Record<string, number>>)[group] : candidate as unknown as Record<string, number>;
    fields[key] = value;
    const result = moodExtendedDifferences(candidate, current);
    assert.equal(result.length, 1, `${group}.${key}`);
    assert.ok(result[0].startsWith(`${label}：`), `${group}.${key}`);
    assert.deepEqual(moodExtendedDifferences(candidate, candidate), [], `unchanged ${group}.${key}`);
  }
});

test("documented common boundaries including zero quotas need no extra confirmation", () => {
  const minute = 60_000, hour = 60 * minute;
  const bounds: [string, string, number, number][] = [
    ["freshness", "retention", 0.4, 0.8], ["freshness", "floor", 0.05, 0.4],
    ["freshness", "ruaMs", 2 * minute, 15 * minute], ["freshness", "foodMs", 10 * minute, 120 * minute], ["freshness", "chatMs", 5 * minute, 60 * minute],
    ["", "fastThreshold", 3, 12], ["evidence", "level", 0.5, 1.5], ["evidence", "trend", 0.5, 1.5],
    ["boredom", "graceMs", 2 * minute, 15 * minute], ["boredom", "perMinute", 0.5, 4], ["boredom", "lookAt", 20, 45], ["boredom", "motionAt", 40, 70], ["boredom", "speechAt", 65, 90],
    ["longing", "graceMs", 4 * hour, 48 * hour], ["longing", "perHour", 0.5, 4], ["longing", "longingAt", 20, 45], ["longing", "sadAt", 45, 75], ["longing", "cryAt", 75, 95],
    ["longing", "cryCooldownMs", 12 * hour, 72 * hour], ["longing", "cryDurationMs", 3_000, 15_000],
    ["frequency", "motionIntervalMs", 3 * minute, 15 * minute], ["frequency", "speechIntervalMs", 20 * minute, 120 * minute], ["frequency", "speechPerHour", 0, 3], ["frequency", "speechWithoutReply", 0, 2],
  ];
  for (const [group, key, low, high] of bounds) for (const value of [low, high]) {
    const candidate = structuredClone(DEFAULT_MOOD_PARAMETERS);
    const fields = group ? (candidate as unknown as Record<string, Record<string, number>>)[group] : candidate as unknown as Record<string, number>;
    fields[key] = value;
    assert.deepEqual(moodExtendedDifferences(candidate, DEFAULT_MOOD_PARAMETERS), [], `${group}.${key}=${value}`);
  }
});

test("experimental fields without documented common ranges do not invent new confirmation requirements", () => {
  const candidate = structuredClone(DEFAULT_MOOD_PARAMETERS);
  candidate.fastWindowMs = 20_000;
  candidate.freshness.quietMs = 2000;
  candidate.interaction.ruaDoseMs = 8000;
  candidate.interaction.afterglowMs = 10_000;
  candidate.interaction.foodBoredomRelief = 20;
  assert.deepEqual(moodExtendedDifferences(candidate, DEFAULT_MOOD_PARAMETERS), []);
});
