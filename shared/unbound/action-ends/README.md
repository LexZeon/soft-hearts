# action-ends：什么能打断她正在做的动作（全屏 Unbound）

手册 `handbook/how-we-work.md`「动作的打断」。

**一处判断**：每种动作写明哪些原因能结束它（`ACTION_ENDS`），每个输入只归类一次（按住她：`pressSize`；别的：主机的互动名），然后页面和主机都只问 `endsAction(动作, 原因)`。不在各处单独打补丁。

| 文件 | 做什么 |
|---|---|
| `rules.ts` | 动作（kiss、hug、look 是"贴近"这一家；walk、life、beat、opening、act）× 原因（pointer、wheel、tug、pull、click、typing、keys、call、play、waiting、reply、reading）的表；`pressSize` 小幅（tug）还是大幅（pull）；`tugPoint`、`tugTarget` 小幅拉时身子跟着的点（按她身高算、有上限） |
| `knobs.ts` | `largePullPx`（多少像素算大幅，默认 60）、`tugShare`（小幅拉到头被带动她身高的几成，默认 0.06） |
| `words.ts` | 你打断了她时，她下一轮听到的一句（哪个动作、被什么，封闭词，只是信息） |

从不结束任何动作的：动鼠标、她在做事时的滚轮、小幅按住或拉（身子、头发、衣服照样跟着晃一下，动作接着做）、打字、键盘。点她身上不结束亲、抱、凑近看；她别的动作照旧（她停下转向你）。大幅拉结束它，之后就是原来的拉她。

谁在用：页面 `src/unbound/pull-input.ts`（小幅/大幅）、`src/unbound/action-now.ts`（此刻在做什么、大幅拉结束谁）；主机 `electron/unbound/peek.ts`（凑近这一家）、`shared/unbound/life/host.ts`（她自己的小动作、她选的走路）、`shared/unbound/her-position/gates.ts`。

被你打断（大幅拉、点她）：体验记录一行 `action-interrupted`（动作、原因），下一轮一句（`electron/unbound/history-host.ts`）。

测试：`tests/action-ends.test.ts`、`tests/action-ends-gene.test.ts`（Gene 真实帧循环里抱抱时小幅拉）、`tests/close-beat-order.test.ts`；变异 `AE1`～`AE13`（`scripts/dev/mutations/unbound.json`）。
