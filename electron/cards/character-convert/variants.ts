// I-071 v2 第三步 转换, fix 8 (Codex T-240 F01): a name the user left for later must not reach the model in ANY written form. Fix 4
// took out the listed name itself ("团团"); the same person could still be in the text as "Tuan Tuan", "tuantuan", "Xiao Tuan",
// "Little Tuan Tuan", "小团团", an English rendering the user once wrote next to it ("团团（Little Dumpling）"), or another name the
// user merged with it on the page 「你生活里的人和事」 (I-088). This file builds that closure, once per conversion, from the source text
// itself: only forms that really occur in it are added (a form that is not in the source cannot reach the model), and a form equal
// to a name the user kept or chose is never taken out. translate.ts replaces every form before every call and checks the output
// against the same closure.
//
// Pinyin without a table of readings or a dependency: the system collation (ICU, zh pinyin order) sorts Han characters by their
// reading. One representative character per syllable (checked at load to sort in syllable order) gives a window per syllable; a
// Latin word "spells" a character when its syllable's window holds the character and the initial letter is the character's own
// (from the first character of each letter). A character next to a syllable boundary can also be taken for the neighbouring
// syllable (deliberately rare: only the immediate neighbour), a polyphone is read the way the collation reads it, and when the
// collation has no pinyin order (the self-check fails) no pinyin forms are found at all (the named forms still are).
import { isRoleWord } from './addresses';

const INITIAL_CHARS = Array.from('吖丷嚓咑妸发旮哈丌咔垃呣拏喔妑七呥仨他屲夕丫帀');
const INITIAL_LETTERS = Array.from('abcdefghjklmnopqrstwxyz');
/** Syllable + one character read that way (403 syllables; "v" is ü). Rare syllables without a safe character are left out. */
const SYLLABLE_TABLE = `a阿 ai哀 an安 ang肮 ao凹 ba八 bai掰 ban班 bang帮 bao包 bei杯 ben奔 beng崩 bi逼 bian边 biao标 bie憋 bin宾 bing冰 bo波 bu晡
ca擦 cai猜 can参 cang仓 cao操 ce册 cen岑 ceng噌 cha叉 chai拆 chan搀 chang昌 chao抄 che车 chen抻 cheng称 chi吃 chong冲 chou抽 chu出 chuai揣 chuan川 chuang窗 chui吹 chun春 chuo戳 ci疵 cong聪 cou凑 cu粗 cuan蹿 cui催 cun村 cuo搓
da搭 dai呆 dan丹 dang当 dao刀 de得 den扽 deng灯 di低 dia嗲 dian颠 diao刁 die爹 ding丁 diu丢 dong东 dou都 du嘟 duan端 dui堆 dun吨 duo多
e婀 ei诶 en恩 eng鞥 er儿 fa发 fan帆 fang方 fei飞 fen分 feng风 fou否 fu夫
ga嘎 gai该 gan甘 gang刚 gao高 ge哥 gei给 gen根 geng耕 gong工 gou沟 gu姑 gua瓜 guai乖 guan关 guang光 gui归 gun滚 guo锅
ha哈 hai嗨 han憨 hang夯 hao蒿 he喝 hei黑 hen痕 heng亨 hong轰 hou侯 hu呼 hua花 huai怀 huan欢 huang荒 hui灰 hun昏 huo豁
ji机 jia家 jian尖 jiang江 jiao交 jie接 jin今 jing京 jiong炯 jiu究 ju居 juan捐 jue撅 jun军
ka咖 kai开 kan刊 kang康 kao考 ke科 kei剋 ken肯 keng坑 kong空 kou抠 ku枯 kua夸 kuai快 kuan宽 kuang筐 kui亏 kun坤 kuo阔
la拉 lai来 lan兰 lang郎 lao捞 le乐 lei雷 leng冷 li离 lia俩 lian连 liang良 liao撩 lie列 lin林 ling灵 liu溜 long龙 lou楼 lu噜 luan峦 lun抡 luo啰 lv驴 lve略
ma妈 mai埋 man蛮 mang忙 mao猫 me么 mei眉 men闷 meng蒙 mi咪 mian眠 miao喵 mie咩 min民 ming名 miu谬 mo摸 mou哞 mu母
na拿 nai奶 nan南 nang囊 nao孬 ne讷 nei内 nen嫩 neng能 ni妮 nian蔫 niang娘 niao鸟 nie捏 nin您 ning宁 niu妞 nong农 nou耨 nu奴 nuan暖 nuo挪 nv女 nve虐
o喔 ou欧 pa趴 pai拍 pan潘 pang乓 pao抛 pei呸 pen喷 peng烹 pi批 pian篇 piao飘 pie撇 pin拼 ping乒 po坡 pou剖 pu扑
qi七 qia掐 qian千 qiang枪 qiao敲 qie切 qin亲 qing青 qiong穷 qiu秋 qu区 quan圈 que缺 qun群
ran然 rang嚷 rao饶 re惹 ren人 reng扔 ri日 rong荣 rou柔 ru如 ruan软 rui锐 run润 ruo若
sa仨 sai腮 san三 sang桑 sao骚 se涩 sen森 seng僧 sha沙 shai筛 shan山 shang商 shao烧 she奢 shen申 sheng生 shi师 shou收 shu书 shua刷 shuai摔 shuan拴 shuang双 shui水 shun顺 shuo说 si司 song松 sou搜 su苏 suan酸 sui虽 sun孙 suo缩
ta他 tai胎 tan贪 tang汤 tao涛 te特 teng疼 ti梯 tian天 tiao挑 tie贴 ting听 tong通 tou偷 tu突 tuan湍 tui推 tun吞 tuo拖
wa挖 wai歪 wan弯 wang汪 wei威 wen温 weng翁 wo窝 wu乌
xi西 xia虾 xian先 xiang香 xiao消 xie些 xin心 xing星 xiong兄 xiu修 xu需 xuan宣 xue靴 xun熏
ya丫 yan烟 yang央 yao腰 ye耶 yi一 yin音 ying英 yo哟 yong拥 you优 yu迂 yuan冤 yue约 yun晕
za匝 zai灾 zan簪 zang脏 zao遭 ze则 zei贼 zen怎 zeng增 zha渣 zhai摘 zhan沾 zhang张 zhao招 zhe遮 zhen针 zheng争 zhi之 zhong中 zhou州 zhu朱 zhua抓 zhuai拽 zhuan专 zhuang庄 zhui追 zhun准 zhuo捉 zi资 zong宗 zou邹 zu租 zuan钻 zui最 zun尊 zuo昨`;

interface Pinyin { collator: Intl.Collator; syllables: [string, string][]; index: Map<string, number> }
let pinyin: Pinyin | null | undefined;
/** The collation's pinyin order: ü sorts as u, right after it ("lu" < "lü" < "luan" < "lüe" < "lun"). */
const orderKey = (syllable: string) => syllable.replace(/v/gu, 'u');
function loadPinyin(): Pinyin | null {
  if (pinyin !== undefined) return pinyin;
  try {
    const collator = new Intl.Collator('zh-CN');
    const syllables = SYLLABLE_TABLE.split(/\s+/u).filter(Boolean).map(row => [row.slice(0, -1), row.slice(-1)] as [string, string])
      .sort(([a], [b]) => orderKey(a) < orderKey(b) ? -1 : orderKey(a) > orderKey(b) ? 1 : a < b ? -1 : 1);
    // Self-check: the boundaries and the representatives must sort in pinyin order, else this collation has no pinyin order.
    const ordered = (chars: readonly string[]) => chars.every((char, index) => index === 0 || collator.compare(chars[index - 1]!, char) < 0);
    pinyin = ordered(INITIAL_CHARS) && ordered(syllables.map(([, char]) => char))
      ? { collator, syllables, index: new Map(syllables.map(([syllable], index) => [syllable, index])) } : null;
  } catch { pinyin = null; }
  return pinyin;
}

const HAN_CHAR = /^\p{Script=Han}$/u;
/** The first letter of a Han character's pinyin (by the collation); null for anything else, or when the collation has no pinyin order. */
export function pinyinInitial(char: string): string | null {
  const table = loadPinyin();
  if (!table || !HAN_CHAR.test(char) || table.collator.compare(char, INITIAL_CHARS[0]!) < 0) return null;
  let letter: string | null = null;
  for (const [index, first] of INITIAL_CHARS.entries()) if (table.collator.compare(char, first) >= 0) letter = INITIAL_LETTERS[index]!;
  return letter;
}

/** Can `char` be read as `syllable` (its window between the neighbouring syllables, and the same initial letter)? */
function reads(char: string, syllable: string): boolean {
  const table = loadPinyin();
  const at = table?.index.get(syllable);
  if (!table || at === undefined || pinyinInitial(char) !== syllable[0]) return false;
  const before = table.syllables[at - 1], after = table.syllables[at + 1];
  return (!before || table.collator.compare(char, before[1]) > 0) && (!after || table.collator.compare(char, after[1]) < 0);
}

/** Can `latin` (lowercase letters only) be split into exactly one syllable per character of `chars` (the same character: the same syllable)? */
function spells(latin: string, chars: readonly string[]): boolean {
  const table = loadPinyin();
  if (!table || !latin || !chars.length) return false;
  const go = (rest: string, at: number, taken: string[]): boolean => {
    if (at === chars.length) return rest === '';
    for (let length = Math.min(6, rest.length); length >= 1; length--) {
      const syllable = rest.slice(0, length);
      const same = chars.slice(0, at).indexOf(chars[at]!);
      if (same >= 0 ? taken[same] !== syllable : !reads(chars[at]!, syllable)) continue;
      if (go(rest.slice(length), at + 1, [...taken, syllable])) return true;
    }
    return false;
  };
  return go(latin, 0, []);
}

const ENGLISH_SMALL = new Set(['little', 'lil']);
/** The words of a Latin phrase as plain pinyin letters: ü (any tone) is "v", tone marks and tone digits go, case goes. */
function wordsOf(phrase: string): { plain: string; capital: boolean }[] {
  return phrase.normalize('NFC').split(/[\s'’-]+/u).filter(Boolean).map(word => ({
    plain: word.replace(/[üǖǘǚǜÜǕǗǙǛ]/gu, 'v').normalize('NFD').replace(/\p{M}/gu, '').replace(/[1-5]/gu, '').toLowerCase(),
    capital: /^\p{Lu}/u.test(word),
  }));
}

/**
 * True when the Latin `phrase` writes the Han `name` in pinyin: spaced or joined, with or without tone marks or digits ("Tuan Tuan",
 * "tuantuan", "Tuán Tuán"); with 小 written as Xiao / Little / Lil, or added in front ("Xiao Tuan Tuan"); a doubled name written once
 * after such a prefix ("Xiao Tuan"). An English prefix needs the name after it capitalized ("Little Cheng", not "little can").
 * A name of one character is never matched (too many ordinary words).
 */
export function romanizes(phrase: string, name: string): boolean {
  const chars = Array.from(name.trim());
  if (chars.length < 2 || !chars.every(char => HAN_CHAR.test(char)) || !loadPinyin()) return false;
  const words = wordsOf(phrase);
  if (!words.length || words.some(word => !/^[a-z]+$/u.test(word.plain))) return false;
  const all = words.map(word => word.plain).join('');
  if (spells(all, chars)) return true;
  const [first, ...rest] = words;
  const restText = rest.map(word => word.plain).join('');
  const english = !!first && ENGLISH_SMALL.has(first.plain) && rest.length > 0 && rest[0]!.capital;
  const small = chars[0] === '小', base = small ? chars.slice(1) : chars;
  // 小 written in English: "Little Cheng" for 小橙; or a 小 / Xiao / Little added to a name without one: "Xiao Tuan Tuan".
  if (english && spells(restText, base)) return true;
  if (!small && (all.startsWith('xiao') && spells(all.slice(4), chars))) return true;
  // A doubled name written once after a prefix: "Xiao Tuan", "Little Tuan" for 团团.
  const doubled = chars.length === 2 && chars[0] === chars[1];
  if (doubled && rest.length && (first!.plain === 'xiao' || english) && spells(restText, [chars[0]!])) return true;
  return false;
}

const LATIN_RUN = /\p{Script=Latin}[\p{Script=Latin}\p{M}'’1-5]*(?:[ \t-]+\p{Script=Latin}[\p{Script=Latin}\p{M}'’1-5]*)*/gu;
/** A Latin phrase written right next to a name: "团团（Little Dumpling）", "Little Dumpling（团团）", "团团/Dumpling", "团团，英文叫 Dumpling". */
const LATIN_PHRASE = String.raw`[A-Za-z][A-Za-z'’]*(?:[ -][A-Za-z][A-Za-z'’]*){0,3}`;
const NEXT_AFTER = [
  new RegExp(String.raw`^\s*[（(]\s*["“'‘]?(${LATIN_PHRASE})["”'’]?\s*[)）]`, 'u'),
  new RegExp(String.raw`^\s*[/／]\s*(${LATIN_PHRASE})(?![A-Za-z])`, 'u'),
  new RegExp(String.raw`^\s*[，,]?\s*(?:英文(?:名)?(?:叫|是)?|又叫|也叫|也就是|也写作|aka|a\.k\.a\.|also called)\s*[：:]?\s*["“'‘]?(${LATIN_PHRASE})(?![A-Za-z])`, 'iu'),
];
const NEXT_BEFORE = [
  { before: new RegExp(String.raw`(?<![A-Za-z])(${LATIN_PHRASE})\s*[（(]\s*$`, 'u'), after: /^\s*[)）]/u },
  { before: new RegExp(String.raw`(?<![A-Za-z])(${LATIN_PHRASE})\s*[/／]\s*$`, 'u'), after: /^/u },
];
const MAX_FORMS = 12;
const fold = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase();
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** Where `form` occurs in `text` as itself (a Latin form as whole words). */
function occursIn(form: string, text: string): boolean {
  if (!/^[A-Za-z]/u.test(form)) return text.includes(form);
  return new RegExp(`(?<![A-Za-z])${escapeRegex(form)}(?![A-Za-z])`, 'iu').test(text);
}

/**
 * Every written form of the left-out `name` that occurs in `texts` (the source the conversion reads: persona and memories), the
 * name first: 小+name, its pinyin forms (`romanizes`), a Latin phrase written right next to any Han form of it, "Little"/"Lil" plus
 * such a phrase, and the other names of its people-and-things group (`groups`, with the user's merges). `keep`: names the user kept
 * or chose (her name, other names and their translations); a form equal to one of them is never part of the closure.
 */
export function leftOutFormClosure(name: string, texts: readonly string[], groups: readonly (readonly string[])[] = [], keep: readonly string[] = []): string[] {
  const kept = new Set(keep.map(fold).filter(Boolean));
  const forms: string[] = [];
  const add = (form: string) => {
    const text = form.normalize('NFC').trim();
    if (!text || Array.from(text).length < 2 || Array.from(text).length > 24 || kept.has(fold(text)) || isRoleWord(text)) return;
    if (!forms.some(other => fold(other) === fold(text))) forms.push(text);
  };
  add(name);
  if (!forms.length) return [];
  const seeds = [name];
  for (const group of groups) if (group.some(other => fold(other) === fold(name))) for (const other of group) if (texts.some(text => occursIn(other, text))) { add(other); seeds.push(other); }
  for (const seed of [...new Set(seeds)]) {
    const chars = Array.from(seed.trim());
    if (!chars.every(char => HAN_CHAR.test(char))) continue;
    if (chars[0] !== '小' && texts.some(text => text.includes(`小${seed}`))) add(`小${seed}`);
    // Pinyin forms: every run of up to four Latin words that writes this name.
    for (const text of texts) for (const run of text.matchAll(LATIN_RUN)) {
      const words = [...run[0].matchAll(/[^\s-]+/gu)];
      for (let start = 0; start < words.length; start++) for (let end = start; end < Math.min(words.length, start + 4); end++) {
        const from = words[start]!.index!, to = words[end]!.index! + words[end]![0].length;
        const phrase = run[0].slice(from, to);
        if (romanizes(phrase, seed)) add(phrase);
      }
    }
  }
  // An English (or any Latin) rendering written right next to a Han form, and "Little"/"Lil" + that rendering.
  const latin: string[] = [];
  for (const form of forms.filter(item => /\p{Script=Han}/u.test(item))) for (const text of texts) {
    for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + form.length)) {
      const before = text.slice(Math.max(0, at - 40), at), after = text.slice(at + form.length, at + form.length + 50);
      for (const pattern of NEXT_AFTER) { const match = pattern.exec(after); if (match) latin.push(match[1]!); }
      for (const { before: pattern, after: closing } of NEXT_BEFORE) { const match = pattern.exec(before); if (match && closing.test(after)) latin.push(match[1]!); }
    }
  }
  for (const phrase of latin) {
    add(phrase);
    if (!/^(?:little|lil|xiao)\b/iu.test(phrase)) for (const text of texts) {
      const match = new RegExp(`(?<![A-Za-z])(?:Little|Lil)\\s+${escapeRegex(phrase)}(?![A-Za-z])`, 'iu').exec(text);
      if (match) add(match[0]);
    }
  }
  return forms.slice(0, MAX_FORMS);
}
