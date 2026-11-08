import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createAtomicFileWriter, type AtomicFileWriter } from '../electron/atomic-file';
import { AssetRegistry } from '../electron/assets';
import { CharacterCardStore } from '../electron/character-cards';
import { KEY_SENTINEL, SettingsStore, type SecretStorage } from '../electron/settings';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';
import type { CharacterDraft } from '../shared/character-cards';

const secrets: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`fixture-sealed:${value}`),
  decryptString: value => {
    assert.ok(value.toString().startsWith('fixture-sealed:'));
    return value.toString().slice('fixture-sealed:'.length);
  },
};
const draft = (name: string): CharacterDraft => ({ name, description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function directory(t: TestContext) {
  const target = await mkdtemp(path.join(os.tmpdir(), 'soft-atomic-stores-'));
  t.after(async () => {
    assert.equal(path.dirname(target), os.tmpdir());
    assert.ok(path.basename(target).startsWith('soft-atomic-stores-'));
    await rm(target, { recursive: true, force: true });
  });
  return target;
}

test('settings short rename locks keep the old commit until replacement and never write any of the three plaintext keys', async t => {
  const target = await directory(t), file = path.join(target, 'settings.json');
  let remainingLocks = 0, attempts = 0, before = '', oldCurrent = structuredClone(DEFAULT_SETTINGS);
  let store!: SettingsStore;
  const sensitive = ['SYNTHETIC_CHAT_SECRET', 'SYNTHETIC_ASR_SECRET', 'SYNTHETIC_TTS_SECRET'];
  const waitTimes: number[] = [];
  const writer = createAtomicFileWriter({ platform: 'win32', wait: async ms => { waitTimes.push(ms); },
    rename: async (source, destination) => {
      if (remainingLocks) {
        attempts++; remainingLocks--;
        assert.equal(await readFile(file, 'utf8'), before);
        assert.deepEqual(store.current, oldCurrent);
        const staged = await readFile(source, 'utf8');
        for (const key of sensitive) assert.ok(!staged.includes(key));
        const stored = JSON.parse(staged);
        assert.equal(stored.provider.apiKey, undefined); assert.equal(stored.voiceInput.apiKey, undefined); assert.equal(stored.tts.apiKey, undefined);
        for (const name of ['voiceInputApiKeyEncrypted', 'ttsApiKeyEncrypted']) assert.equal(typeof stored[name], 'string');
        assert.equal(stored.apiKeyEncrypted, undefined, 'the retired chat key is never created');
        throw Object.assign(new Error('synthetic short replacement lock'), { code: 'EPERM' });
      }
      return rename(source, destination);
    },
  });
  store = new SettingsStore(target, secrets, new AssetRegistry(), writer); await store.load();
  await store.save(structuredClone(DEFAULT_SETTINGS)); before = await readFile(file, 'utf8'); oldCurrent = structuredClone(store.current);
  const next = structuredClone(store.current);
  // Claude-only: a stray renderer chat-key field is dropped, never encrypted or stored.
  next.provider = { kind: 'claude', baseUrl: 'https://fixture-chat.example/v1', model: 'fixture', apiKey: sensitive[0] } as typeof next.provider;
  next.voiceInput = { baseUrl: 'https://fixture-asr.example/v1', model: 'fixture', language: 'zh', apiKey: sensitive[1] };
  next.tts = { ...structuredClone(DEFAULT_TTS_CONFIG), provider: 'bailian', apiHost: 'https://fixture-tts.example', region: 'beijing', apiKey: sensitive[2] };
  remainingLocks = 2;
  const result = await store.save(next);
  assert.equal(attempts, 2); assert.deepEqual(waitTimes, [25, 50]);
  assert.equal('apiKey' in result.provider, false); assert.equal(result.voiceInput?.apiKey, KEY_SENTINEL); assert.equal(result.tts?.apiKey, KEY_SENTINEL);
  const stored = await readFile(file, 'utf8'); for (const key of sensitive) assert.ok(!stored.includes(key));
  assert.deepEqual(await readdir(target), ['settings.json']);
  const restored = new SettingsStore(target, secrets, new AssetRegistry()); await restored.load();
  assert.equal('apiKey' in restored.current.provider, false); assert.equal(restored.current.voiceInput?.apiKey, sensitive[1]); assert.equal(restored.current.tts?.apiKey, sensitive[2]);
});

test('settings exhausted replacement lock preserves disk and current and a later save can recover', async t => {
  const target = await directory(t), file = path.join(target, 'settings.json');
  const lockedError = Object.assign(new Error('synthetic persistent lock'), { code: 'EACCES' });
  let locked = false, attempts = 0, waits = 0;
  const writer = createAtomicFileWriter({ platform: 'win32', wait: async () => { waits++; },
    rename: async (source, destination) => { if (locked) { attempts++; throw lockedError; } return rename(source, destination); },
  });
  const store = new SettingsStore(target, secrets, new AssetRegistry(), writer); await store.load();
  await store.save(structuredClone(DEFAULT_SETTINGS));
  const before = await readFile(file, 'utf8'), current = structuredClone(store.current), next = structuredClone(current); next.voice.rate = 1.2;
  locked = true;
  await assert.rejects(store.save(next), error => error === lockedError);
  assert.equal(attempts, 6); assert.equal(waits, 5);
  assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(store.current, current);
  assert.deepEqual(await readdir(target), ['settings.json']);
  locked = false; await store.save(next);
  assert.equal(store.current.voice.rate, 1.2); assert.equal(JSON.parse(await readFile(file, 'utf8')).voice.rate, 1.2);
});

test('card queue holds later mutations during a short rename lock and commits each revision once', async t => {
  const target = await directory(t), file = path.join(target, 'characters.json');
  const entered = deferred(), release = deferred();
  let remainingLocks = 0, waitCount = 0, before = '', store!: CharacterCardStore;
  let oldState: ReturnType<CharacterCardStore['publicState']>;
  const revisions: number[] = [];
  const atomic = createAtomicFileWriter({ platform: 'win32',
    wait: async () => { if (++waitCount === 1) { entered.resolve(); await release.promise; } },
    rename: async (source, destination) => {
      if (remainingLocks) {
        remainingLocks--; assert.deepEqual(store.publicState(), oldState); assert.equal(await readFile(file, 'utf8'), before);
        throw Object.assign(new Error('synthetic short card lock'), { code: 'EBUSY' });
      }
      return rename(source, destination);
    },
  });
  const writer: AtomicFileWriter = async (destination, data) => { revisions.push(JSON.parse(data).revision); await atomic(destination, data); };
  store = new CharacterCardStore(target, 'Original persona', writer); await store.load();
  before = await readFile(file, 'utf8'); oldState = store.publicState(); remainingLocks = 2;
  const first = store.save(draft('First accepted card'));
  try {
    await entered.promise;
    const second = store.save(draft('Second queued card'));
    await Promise.resolve();
    assert.deepEqual(revisions, [oldState.revision, oldState.revision! + 1], 'the queued second mutation cannot begin its write yet');
    assert.deepEqual(store.publicState(), oldState);
    release.resolve();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.revision, oldState.revision! + 1); assert.equal(two.revision, oldState.revision! + 2);
    assert.deepEqual(revisions, [oldState.revision, oldState.revision! + 1, oldState.revision! + 2]);
    assert.equal(two.activeId, oldState.activeId); assert.equal(two.cards.length, oldState.cards.length + 2);
    assert.deepEqual(two.cards.slice(1).map(card => card.name), ['First accepted card', 'Second queued card']);
    assert.deepEqual(two.cards[0], oldState.cards[0]);
    assert.deepEqual(await readdir(target), ['characters.json']);
  } finally { release.resolve(); await first.catch(() => {}); }
});

test('an exhausted card lock leaves its revision unchanged and does not poison the next queued save', async t => {
  const target = await directory(t), file = path.join(target, 'characters.json');
  const lockedError = Object.assign(new Error('synthetic exhausted card lock'), { code: 'EPERM' });
  let remainingLocks = 0, before = '', store!: CharacterCardStore;
  let oldState: ReturnType<CharacterCardStore['publicState']>;
  const writer = createAtomicFileWriter({ platform: 'win32', wait: async () => {},
    rename: async (source, destination) => {
      if (remainingLocks) {
        remainingLocks--; assert.deepEqual(store.publicState(), oldState); assert.equal(await readFile(file, 'utf8'), before);
        throw lockedError;
      }
      return rename(source, destination);
    },
  });
  store = new CharacterCardStore(target, 'Keep original persona', writer); await store.load();
  before = await readFile(file, 'utf8'); oldState = store.publicState(); remainingLocks = 6;
  const failed = assert.rejects(store.save(draft('Must never be committed')), error => error === lockedError);
  const succeeding = store.save(draft('Queue recovered'));
  await failed; const state = await succeeding;
  assert.equal(state.revision, oldState.revision! + 1); assert.equal(state.activeId, oldState.activeId);
  assert.deepEqual(state.cards.map(card => card.name), [oldState.cards[0].name, 'Queue recovered']);
  assert.ok(!(await readFile(file, 'utf8')).includes('Must never be committed'));
  assert.deepEqual(await readdir(target), ['characters.json']);
});
