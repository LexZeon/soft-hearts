import test from "node:test";
import assert from "node:assert/strict";
import { suggestCodexTask, validateCodexTaskPrompt } from "../shared/codex-tasks";

// The Codex app-server task service (electron/codex-tasks.ts) was retired on 2026-11-02;
// tasks run through electron/claude-tasks/ (tests/claude-tasks.test.ts). These shared
// helpers keep their Codex-era names and are still used by the task UI and main.ts.
test("task suggestions are local hints, with no trigger for normal chat or explanations", () => {
  for (const text of ["早上好", "解释代码重构的原理", "如何修改配置文件", "what is a test file?"]) assert.equal(suggestCodexTask(text), null);
  assert.equal(suggestCodexTask("帮我修复项目里的代码")?.mode, "workspace-write");
  assert.equal(suggestCodexTask("检查项目日志")?.mode, "read-only");
  assert.equal(suggestCodexTask("打开浏览器登录网站")?.needsComputer, true);
  assert.equal(suggestCodexTask("Fix the code in this project")?.needsComputer, false);
  assert.throws(() => validateCodexTaskPrompt(" "));
  assert.throws(() => validateCodexTaskPrompt("x".repeat(32_001)));
});
