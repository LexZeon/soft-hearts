// Read-only status tools of the internal channel (docs/claude/2026-11-17-app-tools-split.md): get_status, get_her_state (her mood in
// plain words, no chat, diary or profile text) and get_diagnostics (numbers only). Nothing here changes anything.
import { herStateWords } from '../../../../shared/mood/her-state-words';
import type { HerStateSource } from '../../../../shared/mood';
import type { AgentToolDefinition } from '../registry';
import { noArgs } from '../validate';
import type { LatencyNumbers } from './app-bridge';
import { title, unavailable, type ToolContext } from './common';
import { paidVoice, PROVIDER_LABEL } from './setting-values';

export function statusTools(context: ToolContext): AgentToolDefinition<any, any>[] {
  const { bridge, interconnected } = context;
  return [
    {
      name: 'get_status', title: title('get_status'), tier: 'read', validate: noArgs,
      run: () => {
        const settings = bridge.settings(), cards = bridge.characters(), windows = bridge.windows();
        const active = cards.cards.find(item => item.id === cards.activeId);
        const provider = paidVoice(settings);
        return {
          app: 'soft hearts', version: bridge.version(),
          character: active ? { id: active.id, name: active.name } : null,
          model: settings.model ? { name: settings.model.name } : null,
          voice: { provider, providerLabel: PROVIDER_LABEL[provider],
            readAloud: settings.voice.enabled, volumePercent: Math.round(settings.voice.volume * 100) },
          windows: { pet: windows.pet, controls: windows.controls, petVisibleSetting: settings.pet.visible },
          // I-014: whether the user keeps Claude, her chat and the settings in step; what is being sensed (on/off only).
          interconnect: interconnected(),
          ...(interconnected() && bridge.perception ? { perception: (() => { try { return bridge.perception!(); } catch { return null; } })() } : {}),
          // Overhaul step 7: which parts are switched off alone (closed `<part>/<unit>` words); empty when all run.
          ...(bridge.partsOff ? { partsOff: (() => { try { return bridge.partsOff!(); } catch { return []; } })() } : {}),
        };
      },
    },
    {
      // how she is, in plain words (no chat, diary or profile text, no raw numbers).
      name: 'get_her_state', title: title('get_her_state'), tier: 'read', validate: noArgs,
      run: () => {
        if (!bridge.herState) throw unavailable('这个版本还不能读她的状态。');
        let source: HerStateSource | null = null;
        try { source = bridge.herState(); } catch { source = null; }
        if (!source) throw unavailable('现在读不到她的状态（桌宠还没准备好）。');
        const words = herStateWords(source, (bridge.now ?? Date.now)());
        const card = bridge.characters().cards.find(item => item.id === bridge.characters().activeId);
        return { character: card ? card.name : null, ...words };
      },
    },
    {
      name: 'get_diagnostics', title: title('get_diagnostics'), tier: 'read', validate: noArgs,
      run: () => {
        const facts = bridge.diagnostics(), records = facts.replyLatency.slice(-20);
        const numbers = (key: keyof LatencyNumbers) => records.map(record => record[key]).filter((v): v is number => typeof v === 'number');
        const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
          return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
        const last = records.at(-1);
        const memory = (bridge.memory ?? (() => { const usage = process.memoryUsage(); return { rss: usage.rss, heapUsed: usage.heapUsed }; }))();
        return {
          replyLatency: {
            samples: records.length,
            complete: records.filter(record => record.status === 'complete').length,
            stoppedOrError: records.filter(record => record.status !== 'complete').length,
            medianFirstContentMs: median(numbers('firstContentMs')),
            medianFirstVisibleMs: median(numbers('firstVisibleMs')),
            medianAllVisibleMs: median(numbers('allVisibleMs')),
            last: last ? { firstContentMs: last.firstContentMs, firstVisibleMs: last.firstVisibleMs,
              firstSentenceVisibleMs: last.firstSentenceVisibleMs, allVisibleMs: last.allVisibleMs, chars: last.chars, deltas: last.deltas } : null,
          },
          chat: { reportedModel: facts.chatModel ?? null }, // 2026-11-26: the model Claude Code says answers her (null until a turn ran; diagnostic only, never shown in a window)
          memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) },
          uptimeSeconds: Math.round(bridge.uptimeSeconds?.() ?? process.uptime()),
          petWindowDiagnostics: { enabled: facts.petWindow.enabled, entries: facts.petWindow.entries },
          frameClock: null,
          ...(bridge.partsOff ? { partsOff: (() => { try { return bridge.partsOff!(); } catch { return []; } })() } : {}), // step 7
          notes: ['回复延迟只在开发者模式下记录。', '帧时钟只在渲染端画布上（data-frame-clock），主进程读不到。'],
        };
      },
    },
  ];
}
