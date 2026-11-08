import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CharacterCardStore } from "../electron/character-cards";
import {
  BUNDLED_CHARACTER_MODEL,
  CHARACTER_CARD_FORMAT,
  CHARACTER_CARD_VERSION,
  MAX_CHARACTER_CARDS,
  compileCharacterPersona,
  validateCharacterDraft,
  type CharacterDraft,
} from "../shared/character-cards";

const draft = (
  name: string,
  fields: Partial<CharacterDraft> = {},
): CharacterDraft => ({
  name,
  description: "",
  personality: "",
  scenario: "",
  greeting: "",
  examples: "",
  systemPrompt: "",
  ...fields,
});
async function withStore(
  operation: (store: CharacterCardStore, directory: string) => Promise<void>,
  legacy = "Existing custom persona",
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "soft-character-test-"),
  );
  try {
    const store = new CharacterCardStore(directory, legacy);
    await store.load();
    await operation(store, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("first load preserves the full legacy persona and never rewrites connection settings", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "soft-character-migrate-"),
  );
  try {
    const settings =
      '{"provider":{"model":"untouched","apiKeyEncrypted":"opaque"},"model":{"path":"private.pmx"}}';
    await writeFile(path.join(directory, "settings.json"), settings);
    const legacy = "自定义人设".repeat(2400);
    assert.equal(legacy.length, 12000);
    const store = new CharacterCardStore(directory, legacy);
    const state = await store.load();
    assert.equal(state.cards.length, 1);
    assert.equal(state.activeId, state.cards[0].id);
    assert.equal(state.cards[0].systemPrompt, legacy);
    assert.equal(compileCharacterPersona(store.getActive()), legacy);
    assert.equal(
      await readFile(path.join(directory, "settings.json"), "utf8"),
      settings,
    );
    const restored = new CharacterCardStore(directory, "a different fallback");
    assert.deepEqual(await restored.load(), state);
    assert.deepEqual((await readdir(directory)).sort(), [
      "characters.json",
      "settings.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serialized concurrent saves persist unique inactive cards and return detached public state", async () => {
  await withStore(async (store, directory) => {
    const original = store.publicState().activeId;
    await Promise.all([
      store.save(draft("One")),
      store.save(draft("Two")),
      store.save(draft("Three")),
    ]);
    const state = store.publicState();
    assert.equal(state.cards.length, 4);
    assert.equal(new Set(state.cards.map((card) => card.id)).size, 4);
    assert.equal(state.activeId, original);
    state.cards[0].name = "must not mutate store";
    assert.notEqual(store.publicState().cards[0].name, state.cards[0].name);
    const active = store.getActive();
    active.systemPrompt = "must not mutate host record";
    assert.notEqual(store.getActive().systemPrompt, active.systemPrompt);
    assert.deepEqual(await readdir(directory), ["characters.json"]);
    const restored = new CharacterCardStore(directory, "unused");
    assert.deepEqual(await restored.load(), store.publicState());
  });
});

test("compiled persona includes role fields but keeps greeting out of model instructions", () => {
  const card = draft("Ada", {
    description: "Description",
    personality: "Curious",
    scenario: "At a desk",
    greeting: "GREETING_ONLY",
    examples: "Example conversation",
    systemPrompt: "Custom system",
  });
  const text = compileCharacterPersona(validateCharacterDraft(card));
  for (const value of [
    "Ada",
    "Description",
    "Curious",
    "At a desk",
    "Example conversation",
    "Custom system",
  ])
    assert.ok(text.includes(value));
  assert.ok(!text.includes("GREETING_ONLY"));
  assert.throws(() => validateCharacterDraft(draft(" ")));
  assert.throws(() => validateCharacterDraft(draft("x".repeat(81))));
  assert.throws(() =>
    validateCharacterDraft({ ...draft("Bad"), greeting: null }),
  );
  assert.throws(() =>
    validateCharacterDraft({ ...draft("Bad"), modelPath: "C:/private.pmx" }),
  );
  assert.throws(
    () =>
      validateCharacterDraft(
        draft("Long", {
          description: "d".repeat(4000),
          personality: "p".repeat(4000),
          examples: "e".repeat(8000),
        }),
      ),
    /组合后/,
  );
});

test("soft hearts, Tavern V2 and legacy flat JSON import text with new IDs and no activation", async () => {
  await withStore(async (store) => {
    const initial = store.publicState().activeId;
    const source = draft("Original", {
      description: "text",
      greeting: "Hello",
      systemPrompt: "custom",
    });
    await store.save(source);
    const original = store.publicState().cards.at(-1)!;
    const exported = store.export(original.id);
    assert.equal(JSON.parse(exported).format, CHARACTER_CARD_FORMAT);
    await store.import(exported);
    const duplicate = store.publicState().cards.at(-1)!;
    assert.notEqual(duplicate.id, original.id);
    assert.equal(duplicate.name, source.name);
    await store.import(
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "V2",
          description: "desc",
          personality: "kind",
          scenario: "desk",
          first_mes: "V2 greeting",
          mes_example: "V2 examples",
          system_prompt: "V2 system",
          creator_notes: "ignored metadata",
          extensions: {},
        },
      }),
    );
    const v2 = store.publicState().cards.at(-1)!;
    assert.equal(v2.greeting, "V2 greeting");
    assert.equal(v2.examples, "V2 examples");
    assert.equal(v2.systemPrompt, "V2 system");
    await store.import(
      JSON.stringify({
        name: "V1",
        first_mes: "V1 greeting",
        mes_example: "V1 examples",
      }),
    );
    assert.equal(store.publicState().cards.at(-1)!.greeting, "V1 greeting");
    assert.equal(store.publicState().activeId, initial);
  });
});

test("imported code remains literal text while paths, keys and prototype fields are rejected", async () => {
  await withStore(async (store, directory) => {
    const malicious =
      '{"name":"Literal","description":"<script>globalThis.CARD_EXECUTED=true</script>","modelPath":"C:/private/stolen.pmx","modelName":"private/stolen.pmx","apiKey":"SECRET_NOT_IMPORTED","provider":{"kind":"evil"},"__proto__":{"CARD_POLLUTED":true}}';
    await assert.rejects(store.import(malicious), /未支持字段/);
    await store.import(JSON.stringify({ name: 'Literal', description: '<script>globalThis.CARD_EXECUTED=true</script>' }));
    const state = store.publicState();
    const card = state.cards.at(-1)!;
    assert.equal(
      card.description,
      "<script>globalThis.CARD_EXECUTED=true</script>",
    );
    assert.equal(
      (globalThis as Record<string, unknown>).CARD_EXECUTED,
      undefined,
    );
    assert.equal(({} as Record<string, unknown>).CARD_POLLUTED, undefined);
    assert.equal(card.modelName, undefined);
    await store.activate(card.id);
    assert.equal(store.getActive().modelPath, undefined);
    const saved = await readFile(
      path.join(directory, "characters.json"),
      "utf8",
    );
    for (const value of [
      "SECRET_NOT_IMPORTED",
      "stolen.pmx",
      "CARD_POLLUTED",
      '"provider"',
    ])
      assert.ok(!saved.includes(value));
  });
});

test("host-only model binding survives edits but is omitted from public export and can be cleared", async () => {
  await withStore(async (store, directory) => {
    const id = store.publicState().activeId;
    const privatePath = path.join(directory, "private-models", "own-model.pmx");
    await store.bindModel(id, privatePath, privatePath);
    assert.equal(store.publicState().cards[0].modelName, "own-model.pmx");
    assert.equal(
      Object.hasOwn(store.publicState().cards[0], "modelPath"),
      false,
    );
    assert.equal(store.getActive().modelPath, privatePath);
    await store.save(draft("Renamed", { personality: "warm" }), id);
    assert.equal(store.getActive().modelPath, privatePath);
    const text = store.export(id);
    assert.ok(
      !text.includes(privatePath) &&
        !text.includes("modelPath") &&
        !text.includes("modelName") &&
        !text.includes(id),
    );
    const restored = new CharacterCardStore(directory, "unused");
    await restored.load();
    assert.equal(restored.getActive().modelPath, privatePath);
    await restored.bindModel(id, null);
    assert.equal(restored.getActive().modelPath, undefined);
    assert.equal(restored.publicState().cards[0].modelName, undefined);
  });
});

test("active deletion selects a remaining card and the final card cannot be removed", async () => {
  await withStore(async (store) => {
    const initial = store.publicState().activeId;
    await assert.rejects(store.remove(initial), /至少保留/);
    await store.save(draft("Second"));
    const second = store.publicState().cards.at(-1)!.id;
    await store.activate(second);
    const state = await store.remove(second);
    assert.equal(state.activeId, initial);
    assert.equal(state.cards.length, 1);
    await assert.rejects(store.activate(second), /不存在/);
    await assert.rejects(store.save(draft("Missing"), second), /不存在/);
  });
});

test("the single host-only bundled Gene reference survives portable updates but is never imported or exported", async () => {
  await withStore(async (store, directory) => {
    const id = store.publicState().activeId;
    await store.bindModel(id, BUNDLED_CHARACTER_MODEL);
    assert.equal(store.getActive().modelPath, BUNDLED_CHARACTER_MODEL);
    assert.equal(store.publicState().cards[0].modelName, "Gene");
    assert.ok(!store.export(id).includes(BUNDLED_CHARACTER_MODEL));
    const restored = new CharacterCardStore(directory, "unused");
    await restored.load();
    assert.equal(restored.getActive().modelPath, BUNDLED_CHARACTER_MODEL);
    await assert.rejects(restored.import(
      JSON.stringify({ name: "Imported", modelPath: BUNDLED_CHARACTER_MODEL }),
    ));
    await restored.import(JSON.stringify({ name: 'Imported' }));
    const imported = restored.publicState().cards.at(-1)!;
    await restored.activate(imported.id);
    assert.equal(restored.getActive().modelPath, undefined);
    await assert.rejects(
      restored.bindModel(imported.id, "bundled:other"),
      /已选择/,
    );
    await assert.rejects(
      restored.bindModel(imported.id, "https://example.com/model.pmx"),
      /已选择/,
    );
  });
});

test("import and card-count bounds reject malformed data without replacing stored cards", async () => {
  await withStore(async (store) => {
    for (const value of [
      "not JSON",
      "[]",
      '{"name":1}',
      '{"name":"Invalid","greeting":null}',
      JSON.stringify({ spec: "chara_card_v3", name: "Unsupported" }),
      JSON.stringify({
        format: CHARACTER_CARD_FORMAT,
        version: CHARACTER_CARD_VERSION + 1,
        card: draft("Unsupported"),
      }),
      "中".repeat(334000),
    ])
      await assert.rejects(store.import(value));
    assert.equal(store.publicState().cards.length, 1);
    for (let index = 1; index < MAX_CHARACTER_CARDS; index++)
      await store.save(draft(`Card ${index}`));
    assert.equal(store.publicState().cards.length, MAX_CHARACTER_CARDS);
    await assert.rejects(store.save(draft("Too many")), /最多保存/);
    await assert.rejects(
      store.import(JSON.stringify(draft("Too many imported"))),
      /最多保存/,
    );
    assert.equal(store.publicState().cards.length, MAX_CHARACTER_CARDS);
  });
});

test("corrupted persisted cards fail without overwriting the original file", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "soft-character-corrupt-"),
  );
  try {
    const file = path.join(directory, "characters.json");
    await writeFile(file, "corrupt original content");
    await assert.rejects(
      new CharacterCardStore(directory, "legacy").load(),
      /原文件已保留/,
    );
    assert.equal(await readFile(file, "utf8"), "corrupt original content");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
