// Development: what the showcase finds on another MMD model (read only): the bones it drives (body, arms, every finger joint, the
// eyes), the expression slots it writes (through the universal aliases, as the intent layer finds them) and the named shapes,
// whether the hand reach can work, and her height. Prints JSON; writes nothing.
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-model-check.ts <model.pmx>
import { MORPH_ALIASES, type MorphSlot } from '../../shared/foundation/universal-skeleton';
import { ArmReach } from '../../src/unbound/arm-reach';
import { geneFigure } from '../../tests/helpers/unbound-gene';

const SLOTS: MorphSlot[] = ['mouthSmile', 'smileEyes', 'a', 'i', 'u', 'e', 'o', 'mouthPucker', 'shy', 'surprise', 'browUp', 'jitome', 'blink'];
const NAMED = ['mouthSmileLeft|mouth_smile_l|mouthsmile_l', '驚き(総|surprised|eyeWide', 'jawOpen|jaw_open|mouthOpen', 'mouthFunnel|mouth_funnel|う', 'cheekPuff|cheek_puff|ぷくー|ぷく|頬膨らみ'];
const BODY = ['センター', '下半身', '上半身', '上半身2', '首', '頭', '左目', '右目', '左肩', '右肩', '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首', '左足ＩＫ', '右足ＩＫ', '左つま先ＩＫ', '右つま先ＩＫ'];
const ARM = (side: string) => ['腕', '腕捩', 'ひじ', '手捩', '手首'].map(n => side + n);
const FINGERS = (side: string) => [...['０', '１', '２'].map(d => `${side}親指${d}`), ...['人指', '中指', '薬指', '小指'].flatMap(f => ['１', '２', '３'].map(d => `${side}${f}${d}`))];

const { fixture, figure } = await geneFigure({ modelPath: process.argv[2] });
try {
  const mesh = fixture.mesh, bones = new Set(mesh.skeleton.bones.map(b => b.name));
  const has = (name: string) => bones.has(name) || bones.has(name.replace(/[０-９]/g, d => String('０１２３４５６７８９'.indexOf(d))));
  const dict = mesh.morphTargetDictionary ?? {}, keys = Object.keys(dict);
  const slot = (s: MorphSlot) => MORPH_ALIASES[s].map(a => keys.find(k => k.toLowerCase() === a.toLowerCase())).find(Boolean) ?? null;
  const named = (spec: string) => spec.split('|').find(n => dict[n] !== undefined) ?? null;
  const missing = (names: string[]) => names.filter(n => !has(n));
  console.log(JSON.stringify({
    heightM: +figure.heightM.toFixed(3), morphCount: keys.length, boneCount: bones.size,
    bodyMissing: missing(BODY), armsMissing: [...missing(ARM('左')), ...missing(ARM('右'))],
    fingersMissing: [...missing(FINGERS('左')), ...missing(FINGERS('右'))],
    reachAvailable: new ArmReach(mesh).available,
    slots: Object.fromEntries(SLOTS.map(s => [s, slot(s)])),
    named: Object.fromEntries(NAMED.map(n => [n, named(n)])),
  }, null, 1));
} finally { figure.dispose(); fixture.close(); }
