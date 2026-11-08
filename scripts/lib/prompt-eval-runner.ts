// R28 prompt evaluation runner. Drives the app's own ordinary-chat pipeline:
// CompanionService (mood context, memories, reply protocol, archive, appraisal)
// → ChatSettingProposals (settings card protocol) → PersistentClaudeChat (the
// persistent Claude Code process with the app's isolation flags, environment
// filter and empty temp folder) or, with perMessage, the streamClaude path.
// Nothing here starts Electron or touches the user's profile: every scenario
// gets its own temp data folder, deleted afterwards.
import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ChatMessage, ProviderConfig } from '../../shared/contracts';
import type { MoodParameters } from '../../shared/mood';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { compileCharacterPersona, effectiveCharacterMood } from '../../shared/character-cards';
import { CompanionService, memoryProviderScope } from '../../electron/companion';
import { MoodHost } from '../../electron/mood';
import { MemoryStore } from '../../electron/memory';
import { ChatSettingProposals } from '../../electron/chat-settings';
import { preinstalledGeneDraft } from '../../electron/gene-preinstalled-card';
import { buildCodexChatPrompt } from '../../electron/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo } from '../../electron/claude-session';
import { claudeSessionSystemPrompt } from '../../electron/claude-session-prompt';
import { APP_REPLY_OPENING, type OpeningMode } from '../../electron/reply-opening';
import { ClaudeChatProcess } from '../../electron/claude-process';
import { serializeExpectation, type TurnRecord, type TurnUsage } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { emptyRelationship, type RelationshipData } from '../../shared/relationship';
import { isConversationOpening, memeContextSection } from '../../electron/diary/diary-data';
import { localDateKey, shiftDate } from '../../electron/diary/diary-dates';

/** 熟悉度 for an evaluation run: what the host would know about this character and the user (docs/claude/2026-11-02-familiarity.md). */
export interface EvalRelationship {
  /** The card's "关系慢慢升温". */
  slowWarmUp: boolean;
  /** 认识第 N 天: today is day N. */
  dayNumber: number;
  /** Days that already counted as time together (seeded before today). */
  togetherDays: number;
  nickname?: string;
  /** Finished chat rounds already today (she may only ask for a nickname after two). */
  todayRounds?: number;
  /** Meme lines as they stand in her diary block (newest first); sent in the opening block when the relationship allows them. */
  memes?: readonly string[];
}

/** The numbers a character with this history would have today. */
export function evalRelationshipData(relationship: EvalRelationship, now = Date.now()): RelationshipData {
  const today = localDateKey(now);
  const days = Array.from({ length: Math.min(relationship.togetherDays, Math.max(0, relationship.dayNumber - 1)) }, (_, index) => shiftDate(today, -(index + 1))).sort();
  const empty = emptyRelationship(today);
  return { ...empty, metDate: shiftDate(today, -(Math.max(1, relationship.dayNumber) - 1)), days, nickname: relationship.nickname ?? null,
    nicknameAsked: !!relationship.nickname, today: { ...empty.today, rounds: relationship.todayRounds ?? 0 } };
}

export interface RunOptions {
  label: string;
  /** Claude Code model alias; '' means Claude Code's own default (no --model). */
  model: string;
  repeat: number;
  scenarios: readonly EvalScenario[];
  /** Claude Code executable (or node for the fake). */
  binary: string;
  binaryArgs?: readonly string[];
  /** Use the one-process-per-message path instead of the persistent session. */
  perMessage?: boolean;
  /** Wait after starting a spare process before a scenario's first turn (the app pre-warms). */
  prewarmMs?: number;
  /** Keep only the first N turns of every scenario. */
  maxTurns?: number;
  /**
   * Interleaved A/B of one text difference inside a single run (same time
   * window): every scenario runs once per variant, in order. A variant's
   * rewrite edits the user message on its way to Claude Code's stdin and must
   * only remove or add prompt text, never touch the conversation data.
   */
  variants?: ReadonlyArray<{ label: string; rewrite?: (prompt: string) => string }>;
  /**
   * The character to talk to (persona text and mood template); the preinstalled Gene card when omitted.
   * Used by the fidelity suite (scripts/lib/fidelity-*.ts).
   */
  card?: { persona: string; mood: MoodParameters; relationship?: EvalRelationship; realer?: boolean };
  /** Replaces the persistent process's fixed system prompt (A/B of prompt wording); the app's own when omitted. */
  systemPrompt?: string;
  /** Called before every real turn; throw to stop (budget guard). */
  beforeTurn?: () => void;
  /**
   * Before a turn's companion.begin: set up host state the app would have at that moment (the draft-leak probe seeds
   * F2's judgment of the user here, docs/claude/2026-11-03-draft-leak-fix.md).
   */
  prepareTurn?: (input: { scenario: EvalScenario; index: number; companion: CompanionService; characterId: string }) => void | Promise<void>;
  /**
   * Host-owned private context electron/main.ts appends to this turn's composed persona after companion.begin (G1 猜拳's
   * one line, `turn.persona += '\n\n' + rpsContext`); null adds nothing.
   */
  hostContext?: (input: { scenario: EvalScenario; index: number; user: string }) => string | null;
  /** Frames attached to a turn as the app attaches a shared screen or camera frame (data URLs, synthetic images only). */
  images?: (input: { scenario: EvalScenario; index: number }) => string[];
  /**
   * I-046: the turn asks for an opening marker and shows only what follows it (CompanionService.setReplyOpening), and with 'fixed' the
   * fixed system prompt names the marker. Omitted: as the app runs (APP_REPLY_OPENING, the same switch electron/main.ts uses).
   */
  replyOpening?: OpeningMode | false;
  /** The turn carries the memorial proposal's private instruction (main.ts: a message the text-memorial host accepted). */
  textMemorial?: (input: { scenario: EvalScenario; index: number; user: string }) => boolean;
  /** The first visible delta of turn `id` arrived (I-037's A/B starts haiku here, as electron/main.ts does). */
  onFirstDelta?: (id: string) => void;
  /** Awaited, so the fidelity suite can score a scenario as soon as its last reply is in. */
  onTurn?: (record: TurnRecord) => unknown;
}

interface Sink {
  t0: number;
  dispatchMs: number | null;
  info: ClaudeTimingInfo | null;
  initModel: string | null;
  initInfo: Record<string, string | number | boolean> | null;
  blocks: string[];
  thinking: string;
  usage: TurnUsage | null;
  prompt: string | null;
  rewrite?: (prompt: string) => string;
  /** The variant's rewrite failed: the prompt went out unchanged and the run stops after this turn. */
  rewriteError?: string;
}
let sink: Sink | null = null;

/** Observes (never alters) what the app's process writes and reads: the stdin prompt, init model, usage. */
function tappedSpawn(command: string, args: readonly string[], options: SpawnOptions) {
  const child = spawn(command, args, options);
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { continue; }
      if (!sink) continue;
      if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') sink.initModel = event.model;
      if (event.type === 'system' && event.subtype === 'init') {
        // Scalars only (version, model, output style, permission mode…); never lists, paths or ids.
        const info: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(event)) {
          if (['type', 'subtype', 'session_id', 'uuid', 'cwd'].includes(key)) continue;
          if (typeof value === 'string' && value.length <= 80 && !/[\\/]/u.test(value)) info[key] = value;
          else if (typeof value === 'number' || typeof value === 'boolean') info[key] = value;
        }
        sink.initInfo = info;
      }
      if (event.type === 'stream_event') {
        // What the model actually streamed besides the reply text: block kinds, and any thinking text.
        const inner = event.event ?? {};
        if (inner.type === 'content_block_start' && typeof inner.content_block?.type === 'string') sink.blocks.push(`${inner.index}:${inner.content_block.type}`);
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta' && typeof inner.delta.thinking === 'string' && sink.thinking.length < 6000)
          sink.thinking += inner.delta.thinking;
      }
      if (event.type === 'result') {
        const usage = event.usage ?? {};
        sink.usage = {
          inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0),
          cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0), cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
          costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
          apiMs: typeof event.duration_api_ms === 'number' ? event.duration_api_ms : null,
        };
      }
    }
  });
  const stdin = child.stdin;
  if (stdin) {
    const write = stdin.write.bind(stdin) as (...values: unknown[]) => boolean;
    (stdin as unknown as { write: (...values: unknown[]) => boolean }).write = (...values: unknown[]) => {
      try {
        const event = JSON.parse(String(values[0]));
        if (sink && event?.type === 'user') {
          if (sink.rewrite) {
            try {
              for (const block of event.message.content) if (block.type === 'text') block.text = sink.rewrite(block.text);
              values[0] = JSON.stringify(event) + '\n';
            } catch (error) { sink.rewriteError = error instanceof Error ? error.message : String(error); }
          }
          sink.prompt = event.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
        }
      } catch { /* Control messages and partial writes are not prompts. */ }
      return write(...values);
    };
  }
  return child;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Same persona and mood template a fresh install's Gene card compiles to. */
export function genePersona(): { persona: string; mood: ReturnType<typeof effectiveCharacterMood> } {
  const card = preinstalledGeneDraft();
  return { persona: compileCharacterPersona(card), mood: effectiveCharacterMood(card) };
}

/** Pre-dates mood state and archives one older chat, as if the user had been away. */
async function seedAway(directory: string, characterId: string, provider: ProviderConfig, away: NonNullable<EvalScenario['away']>, mood: MoodParameters): Promise<void> {
  const past = Date.now() - away.hours * 3_600_000;
  const host = new MoodHost(directory, () => {}, () => past);
  await host.load();
  host.activate(characterId, mood);
  host.event({ type: 'chat', id: 'seed-chat', reason: '收到用户聊天' }, characterId);
  await host.flush();
  const store = new MemoryStore(directory);
  await store.load();
  const scope = { characterId, providerScope: memoryProviderScope(provider) };
  await store.beginTurn(scope, { id: 'seed-turn', userText: away.archived.user, at: past - 60_000, conversationId: 'seed-conversation' });
  await store.appendAssistant(scope, 'seed-turn', away.archived.assistant, past - 55_000);
  await store.finishTurn(scope, 'seed-turn', 'complete', past - 50_000);
  await store.seal(scope);
  await store.flush();
}

export async function runEval(options: RunOptions): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  const provider: ProviderConfig = { ...DEFAULT_SETTINGS.provider, model: options.model };
  // I-046: the protocol and the fixed system prompt agree on the marker (a 'fixed' marker asked for with the gate off would show).
  const opening = options.replyOpening ?? APP_REPLY_OPENING;
  const systemPrompt = options.systemPrompt ?? (opening === 'fixed' ? claudeSessionSystemPrompt({ opening: true }) : claudeSessionSystemPrompt({ opening: false }));
  const chat = new PersistentClaudeChat({
    enabled: !options.perMessage,
    provider: () => provider,
    chattedBefore: () => true,
    binary: async () => options.binary,
    ...(options.binaryArgs ? { binaryArgs: options.binaryArgs } : {}),
    systemPrompt,
    startProcess: processOptions => ClaudeChatProcess.start({ ...processOptions, spawn: tappedSpawn as typeof spawn }),
    timing: {
      dispatched: (_id, info) => { if (sink) { sink.info = info; sink.dispatchMs = Math.round(performance.now() - sink.t0); } },
      firstDelta: () => {},
    },
    log: () => {},
  });
  const { persona, mood } = options.card ?? genePersona();
  const relationship = options.card?.relationship;
  const variants = options.variants?.length ? options.variants : [{ label: options.label }];
  const runs = options.scenarios.flatMap(scenario => variants.map(variant => ({ scenario, variant })));
  try {
    for (const { scenario, variant } of runs) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-prompt-eval-'));
      const characterId = randomUUID();
      try {
        if (scenario.away) await seedAway(directory, characterId, provider, scenario.away, mood);
        const companion = new CompanionService(directory, () => {});
        companion.setReplyOpening(opening);
        await companion.load();
        await companion.context(characterId, provider, persona, mood);
        // F6 "更真实的情绪": the app's own source, as main.ts sets it from the card store.
        if (options.card?.realer) companion.setRealerEmotionsSource(id => id === characterId);
        if (relationship) {
          // The scope is scanned first (an empty archive here), so the seeded numbers are not moved by the older chat the "away" scenarios plant.
          companion.relationship.setCardSource(() => ({ slowWarmUp: relationship.slowWarmUp, tendencies: { ...mood.weights } }));
          await companion.relationship.prepare(companion.currentScope(), () => ({ first: null, rounds: new Map() }));
          await companion.relationship.seed(characterId, evalRelationshipData(relationship));
        }
        const settings = new ChatSettingProposals({ settings: () => structuredClone(DEFAULT_SETTINGS), send: () => {} });
        settings.connect(async () => ({ ok: false, error: { code: 'failed', message: 'evaluation only' } }) as never);
        // A new conversation, like the app: the old session closes and a spare starts.
        chat.close('context');
        if (!options.perMessage && options.prewarmMs) await sleep(options.prewarmMs);
        const messages: ChatMessage[] = [...(scenario.history ?? [])];
        for (const [index, step] of scenario.turns.slice(0, options.maxTurns ?? Infinity).entries()) {
          options.beforeTurn?.();
          const id = `eval-${scenario.id}-${index + 1}-${randomUUID().slice(0, 8)}`;
          const settingTurn = settings.beginTurn(step.user);
          let liveVisible = '';
          await options.prepareTurn?.({ scenario, index, companion, characterId });
          const turn = await companion.begin(id, step.user, persona, (type, text) => { if (type === 'delta') liveVisible += text; },
            { textMemorial: options.textMemorial?.({ scenario, index, user: step.user }) === true, settingProposal: settingTurn });
          const hostContext = options.hostContext?.({ scenario, index, user: step.user });
          if (hostContext) turn.persona += '\n\n' + hostContext;
          messages.push({ role: 'user', content: step.user });
          const nonce = /<sh-state-([a-f0-9]{32})>/u.exec(turn.persona)?.[1] ?? '';
          const chunks: Array<[number, string]> = [];
          const current: Sink = { t0: performance.now(), dispatchMs: null, info: null, initModel: null, initInfo: null, blocks: [], thinking: '', usage: null, prompt: null,
            ...(variant.rewrite ? { rewrite: variant.rewrite } : {}) };
          sink = current;
          let error: string | null = null;
          const window = [...messages];
          // The memes of her diary ride along in the opening block of a conversation, as electron/user-profile.ts adds them.
          const memeBlock = relationship?.memes?.length && turn.relationshipMemes !== false && isConversationOpening(window) ? memeContextSection(relationship.memes) : null;
          try {
            await chat.stream({
              kind: 'chat', model: options.model, workingDirectory: directory, writable: false,
              get prompt() { return buildCodexChatPrompt(turn.persona, window, memeBlock); },
              imageDataUrls: options.images?.({ scenario, index }) ?? [], replyId: id,
              session: { key: companion.currentSpeechScope(), basePersona: persona, persona: turn.persona, openingContext: turn.relationshipOpening, openingKey: turn.relationshipTag,
                // As the app: the session records the reply as shown (liveVisible below), so a cut draft does not reopen it.
                messages: window, language: null, data: () => memeBlock, shown: () => turn.shownReply?.() ?? null },
            }, new AbortController().signal, (type, text) => {
              if (type === 'delta') { chunks.push([Math.round(performance.now() - current.t0), text]); if (chunks.length === 1) options.onFirstDelta?.(id); }
              turn.push(type, text);
            });
          } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
          if (current.rewriteError) error ??= current.rewriteError;
          const endMs = Math.round(performance.now() - current.t0);
          sink = null;
          await turn.finish(error ? 'error' : 'complete');
          if (!error) settings.offer(settingTurn.ticket, 1, id, turn.settingProposal?.());
          messages.push({ role: 'assistant', content: liveVisible });
          const record: TurnRecord = {
            label: variant.label, model: options.model, repeat: options.repeat, scenario: scenario.id, title: scenario.title,
            turn: index + 1, user: step.user, expect: serializeExpectation(step.expect),
            process: options.perMessage ? 'per-message' : current.info?.process ?? null, sessionTurn: current.info?.sessionTurn ?? null,
            initModel: current.initModel, nonce, settingOffered: settingTurn.instruction !== null,
            ...(opening ? { opening } : {}), ...(/<sh-memorial-[a-f0-9]{32}>/u.test(turn.persona) ? { memorial: true } : {}),
            dispatchMs: current.dispatchMs, endMs, chunks, liveVisible, prompt: current.prompt, usage: current.usage, error,
            blocks: current.blocks, ...(current.thinking ? { thinking: current.thinking } : {}), ...(current.initInfo ? { initInfo: current.initInfo } : {}),
          };
          records.push(record);
          await options.onTurn?.(record);
          // Any failed turn (429, quota, login, safety stop...) ends the run: what finished is
          // already recorded, and nothing is retried or re-requested.
          if (error) throw new Error(`评测在 ${scenario.id}#${index + 1} 遇到错误后停止（已完成的轮次已记录）：${error}`);
        }
        await companion.flush();
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
  } finally {
    sink = null;
    chat.dispose();
  }
  return records;
}
