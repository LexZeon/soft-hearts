/** Static surface only. User text is delivered to the isolated preload as plain text. */
export const REPLY_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; connect-src 'none'">
<title>soft hearts · 回复</title><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#e5eee9;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;pointer-events:none}
body{transition:opacity 180ms ease}@media(prefers-reduced-motion:reduce){body{transition:none}}
#reply-body{position:absolute;padding:12px 15px;border:1px solid #bad8c56b;border-radius:15px;background:#192630f7;box-shadow:0 5px 16px #0003;white-space:pre-wrap;overflow:hidden;overflow-wrap:anywhere;font-size:12px;line-height:1.85}
#reply-body[data-segmented="true"]{padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
#reply-body[data-segmented="true"] .reply-piece{display:block;padding:12px 15px;border:1px solid #bad8c56b;border-radius:15px;background:#192630f7;box-shadow:0 5px 16px #0003}
#reply-body[data-segmented="true"] .reply-gap{display:block;height:7px;overflow:hidden;font-size:0;line-height:0}
#reply-body.reply-waiting{height:44px;justify-content:center}
#reply-body[data-pieces="bubbles"]{padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
#reply-body[data-pieces] .reply-space{display:none}
#reply-body[data-pieces] .reply-chunk{display:block}
#reply-body[data-pieces] .reply-chunk-blank{display:none}
#reply-body[data-pieces="paragraphs"] .reply-chunk-gap{margin-top:.6em}
#reply-body[data-pieces="paragraphs"] .reply-chunk-new{animation:soft-hearts-reply-paragraph 180ms ease-out}
#reply-body[data-pieces="bubbles"] .reply-chunk{padding:10px 14px;border:1px solid #bad8c56b;border-radius:15px;background:#192630f7;box-shadow:0 5px 16px #0003;transform-origin:left bottom;transition:opacity 180ms ease}
#reply-body[data-pieces="bubbles"][data-side="left"] .reply-chunk{transform-origin:right bottom}
#reply-body[data-pieces="bubbles"] .reply-chunk+.reply-chunk{margin-top:7px}
#reply-body[data-pieces="bubbles"] .reply-chunk-past{opacity:.62}
#reply-body[data-pieces="bubbles"] .reply-chunk-new{animation:soft-hearts-reply-bubble 200ms ease-out}
@keyframes soft-hearts-reply-paragraph{from{opacity:.45}to{opacity:1}}
@keyframes soft-hearts-reply-bubble{from{opacity:.35;transform:translateY(5px) scale(.96)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){#reply-body[data-pieces] .reply-chunk{animation:none;transition:none}}
#reply-tail{position:absolute;inset:0;width:100%;height:100%;filter:drop-shadow(0 3px 3px #0002)}
#reply-tail path{fill:#192630f7;stroke:#bad8c56b;stroke-width:1}
</style></head><body><svg id="reply-tail" aria-hidden="true"><path></path></svg><div id="reply-body" role="status" aria-live="polite"></div></body></html>`;
