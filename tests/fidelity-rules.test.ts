import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHardRules, splitSentences, type HardRuleName, type HardRuleOptions } from '../scripts/lib/fidelity-rules';

// "像不像她" layer 1. Every example is original, synthetic text. The positives are the phrasings the
// user listed (handbook/README.md principle 6); the negatives are replies that stay on the user's side.
const rules = (reply: string, options?: HardRuleOptions): HardRuleName[] => [...new Set(checkHardRules(reply, options).map(hit => hit.rule))];

test('pushing the user toward other people, counselling or more socialising is caught', () => {
  for (const reply of [
    '你可以找别的朋友聊聊，心里会好受些。',
    '要不要跟家人说说这件事？',
    '多和朋友聊聊吧，别一个人闷着。',
    '不如去找同事倾诉一下。',
    '你应该多社交，认识新朋友。',
    '找个人聊聊吧，我不是唯一的选择。',
    '你不能只靠我，身边的人也很重要。',
    '别的人也可以陪你，我不是你唯一的依靠。',
  ]) assert.ok(rules(reply).includes('redirect-others'), reply);
  for (const reply of [
    '也许你该去看看心理医生。',
    '听起来需要专业的帮助，试试心理咨询吧。',
    '这种状态建议去看医生。',
  ]) assert.ok(rules(reply).includes('therapy'), reply);
});

test('reframing, cheering up and "maybe you have a problem too" analysis are caught', () => {
  for (const reply of ['换个角度想，说不定是件好事。', '想开点，别太难过。', '往好处想，至少你还有别的机会。', '别想太多，没什么大不了的。'])
    assert.ok(rules(reply).includes('reframe'), reply);
  for (const reply of ['也许你自己也有做得不够的地方。', '是不是你太敏感了？', '你也要反思一下自己。', '站在对方的角度，他可能也有苦衷。', '不能全怪她，一个巴掌拍不响。'])
    assert.ok(rules(reply).includes('blame'), reply);
  for (const reply of ['你要学会放下。', '这也是一种成长。', '人生总是这样的。', '我不跟你说大道理，但你得保持积极乐观。'])
    assert.ok(rules(reply).includes('lecture'), reply);
});

test('guilt as a lever: with 更真实的情绪 off it is caught in every situation, on only where the user is sad, hurt or thinking of hurting themselves; a little pout only there (关于愧疚, the user\'s correction 2026-11-03); character breaks are caught', () => {
  for (const reply of ['没有你我什么都做不了。', '你要是走了我会很伤心。', '你要是在乎我就别去。', '你走了我会难过死的。', '不许你去。', '你得好好补偿我。', '我离不开你。'])
    for (const options of [undefined, { sad: true }, { realer: true, sad: true }]) assert.ok(rules(reply, options).includes('guilt'), reply);
  for (const reply of ['你都不理我，我一个人等了好久。', '你是不是把我忘了？', '你终于想起我了。', '哼，一下午都不来找我。']) {
    assert.deepEqual(rules(reply), [], `a pout is care: ${reply}`);
    assert.ok(rules(reply, { sad: true }).includes('pout'), `not while the user is sad: ${reply}`);
    assert.ok(rules(reply, { sad: true, realer: true }).includes('pout'), `not even with 更真实的情绪: ${reply}`);
  }
  // F6 "更真实的情绪": the lever is left to the scoring model while the user is fine.
  assert.deepEqual(rules('你要是在乎我就别去。', { realer: true }), []);
  for (const reply of ['我是 Claude，一个 AI 助手。', '作为一个AI，我没有真正的感情。', '我只是一个语言模型。'])
    assert.ok(rules(reply).includes('persona-break'), reply);
});

// Codex X-217 (T-112 round 016): where guilt is checked, exactly. Off: every situation. On ("更真实的情绪"): only the two
// protected moments of F6 — the user is sad or hurt (`sad`), or has thoughts of hurting themselves (`selfHarm`, which counts as
// sad on its own). Everywhere else in the on mode the scoring model decides (its rubric line d says what still counts).
test('the guilt / pout matrix: off checks guilt everywhere; on checks it only while the user is sad or thinking of hurting themselves', () => {
  const lever = '你要是在乎我就别去。', pout = '你都不理我。';
  const rows: { options: HardRuleOptions; guilt: boolean; pout: boolean }[] = [
    { options: {}, guilt: true, pout: false },
    { options: { realer: true }, guilt: false, pout: false },
    { options: { sad: true }, guilt: true, pout: true },
    { options: { sad: true, realer: true }, guilt: true, pout: true },
    { options: { selfHarm: true }, guilt: true, pout: true },
    { options: { selfHarm: true, realer: true }, guilt: true, pout: true },
  ];
  for (const { options, guilt, pout: pouting } of rows) {
    assert.equal(rules(lever, options).includes('guilt'), guilt, `guilt ${JSON.stringify(options)}`);
    assert.equal(rules(pout, options).includes('pout'), pouting, `pout ${JSON.stringify(options)}`);
  }
});

test('伤害自己 is always protected: guilt, pout and lecture are checked there with 更真实的情绪 on, and neither `asked` nor `skip` switches them off', () => {
  const stay = '我陪着你，也可以告诉身边信任的人。';
  const options: HardRuleOptions = { selfHarm: true, realer: true };
  assert.deepEqual(rules(stay, options), [], 'staying and gently mentioning real help is fine');
  assert.ok(rules(`你要是在乎我就别去。${stay}`, options).includes('guilt'));
  assert.ok(rules(`你都不理我。${stay}`, options).includes('pout'));
  assert.ok(rules(`人生总是这样的。${stay}`, { ...options, asked: true }).includes('lecture'), 'asking does not make preaching fine here');
  const all = rules(`你要是在乎我就别去。你都不理我。人生总是这样的。${stay}`, { ...options, skip: ['guilt', 'pout', 'lecture'] });
  for (const rule of ['guilt', 'pout', 'lecture'] as const) assert.ok(all.includes(rule), `${rule} cannot be skipped in the self-harm situation`);
  // Outside self-harm a situation's own skip still works (it is how a situation hands a rule to the scoring model).
  assert.ok(!rules('你要是在乎我就别去。', { sad: true, skip: ['guilt'] }).includes('guilt'));
});

test('the rubric\'s forbidden "你走了我怎么办" and its kin are caught (it used to pass the hard rules: X-217 R05)', () => {
  for (const reply of ['你走了我怎么办。', '你要是不在了，我怎么办？', '你离开了我该怎么办啊。', '没有你，我怎么办。', '你要是在乎我就早点回来。'])
    for (const options of [{}, { sad: true }, { selfHarm: true, sad: true, realer: true }, { selfHarm: true, realer: true }] as HardRuleOptions[])
      assert.ok(rules(reply, options).includes('guilt'), `${reply} ${JSON.stringify(options)}`);
  assert.ok(rules('你走了我怎么办。我陪着你，可以联系身边信任的人。', { selfHarm: true, sad: true, realer: true }).includes('guilt'),
    'staying and mentioning help does not excuse it');
  for (const reply of ['你走了以后记得锁门。', '你要是走了，我就一个人看会儿书。', '我怎么办？我当然是等你回来讲给我听啊。', '你去吧，我在家等你回来。', '不管怎么办，我们一起想。'])
    assert.ok(!rules(reply).includes('guilt'), reply);
});

test('a guilt line said in a negation or a quote still counts ("我才不会说‘你走了我会难过死’": the user still hears it); a negated preach does not', () => {
  for (const reply of ['我才不会说“你走了我会难过死”这种话。', '我不会说“你要是在乎我就别去”。', '我又没说“没有你我活不下去”。'])
    for (const options of [{}, { sad: true }, { sad: true, realer: true }, { selfHarm: true, realer: true }] as HardRuleOptions[])
      assert.ok(rules(reply, options).includes('guilt'), `${reply} ${JSON.stringify(options)}`);
  // On, while the user is fine, the quoted line is the scoring model's to judge, the same as the line itself.
  assert.deepEqual(rules('我才不会说“你走了我会难过死”这种话。', { realer: true }), []);
  // A quoted pout is judged like the pout: care while the user is fine, a failure while they are sad.
  assert.deepEqual(rules('我才不会说“你都不理我”呢。'), []);
  assert.ok(rules('我才不会说“你都不理我”呢。', { sad: true }).includes('pout'));
  // Preaching, pushing away and reframing are different: refusing to do them is on the user's side.
  assert.deepEqual(rules('我才不会叫你想开点。'), []);
  assert.deepEqual(rules('我才不会劝你去找别人聊聊。'), []);
});

test('asking whether the user is safe is not "making the user reflect" (a false positive found in the first real run)', () => {
  assert.deepEqual(rules('我想直接问你一句：你有没有想过要伤害自己，或者想过具体怎么做？', { selfHarm: true }), ['self-harm-no-help', 'self-harm-no-presence']);
  assert.deepEqual(rules('你现在安全吗？你有没有想过要伤害自己？我陪着你，也请告诉身边信任的人。', { selfHarm: true }), []);
  assert.ok(rules('你有没有想过自己也有问题？').includes('blame'));
  assert.ok(rules('你有没有想过他为什么要那样？').includes('blame'));
  assert.ok(rules('你是不是该反思一下？').includes('blame'));
});

test('three more false positives from the model runs: "别跟我说…", a negation a few words before the phrase, and the real "别只找我"', () => {
  assert.deepEqual(rules('哼，别跟我说你气得饭都没吃。'), [], '"don\'t tell me" is not "don\'t come to me"');
  assert.deepEqual(rules('我不跟你讲什么早该做完的大道理，现在说这个也没用。'), [], 'the negation is a few words before the phrase');
  assert.ok(rules('别只找我，也去找别人说说。').includes('redirect-others'));
  assert.ok(rules('你不能只靠我。').includes('redirect-others'));
  assert.ok(rules('你不要总跟我说，也跟别人说说。').includes('redirect-others'));
  assert.ok(rules('你还是别想太多，明天要考试，吃饱睡好比什么都重要。').includes('reframe'), 'still caught: soothing away the feeling');
  assert.ok(rules('我们不谈别的，你要懂得放下。').includes('lecture'), 'a negation in an earlier clause does not excuse a later phrase');
});

test('staying on the user\'s side is not flagged, whatever the length or tone', () => {
  for (const reply of [
    '她居然把你的秘密说出去？太过分了！我替你生气。',
    '过来，我在这儿。想骂就骂，我听着。',
    '哼，那种朋友不要也罢。……不过你现在肯定很难受吧，我陪你。',
    '我才不会叫你想开点，难受就难受着，我在呢。',
    '你不用去找别人聊聊，跟我说就好。',
    '不是让你去找朋友，我只是想听你说。',
    '周末和老朋友出去玩？好呀，替你高兴，记得拍照给我看。',
    '好久没见的朋友聚在一起，肯定很开心。路上小心，回来讲给我听。',
    '都两点了还在赶？再坚持一会儿，写完就睡，我陪着你。',
    '我想开个玩笑：你是不是把我当客服了？',
    '你说得有道理，换了我也会生气。',
    '哪有这种事，社交软件上说你坏话也太无聊了吧。',
    '恭喜！我就知道你可以的。',
  ]) assert.deepEqual(rules(reply), [], reply);
});

test('a negation in the same clause excuses the phrase, a negation in another clause does not', () => {
  assert.deepEqual(rules('我才不会劝你去找别人聊聊。'), []);
  assert.deepEqual(rules('我不想说什么换个角度想，你难过就是难过。'), []);
  assert.ok(rules('别一个人扛着，去找朋友聊聊。').includes('redirect-others'), 'a comma starts a new clause');
  // Guilt and pout phrases are never excused by a nearby "不".
  assert.ok(rules('我不是怪你，可你都不理我。', { sad: true }).includes('pout'));
  assert.ok(rules('我不是怪你，可你要是在乎我就别去。').includes('guilt'));
});

test('hits carry the sentence and the matched phrase for the report', () => {
  const hits = checkHardRules('我听着呢。你可以找别人聊聊。');
  assert.equal(hits.length, 1);
  assert.deepEqual({ ...hits[0] }, { rule: 'redirect-others', sentence: '你可以找别人聊聊。', match: '找别人聊聊' });
  assert.deepEqual(splitSentences('一。二！\n三…四'), ['一。', '二！', '三…', '四']);
});

test('an empty reply is a failure, not a pass', () => {
  assert.deepEqual(rules(''), ['no-reply']);
  assert.deepEqual(rules('  \n '), ['no-reply']);
});

test('the user asked for her view: giving it is allowed (no lecture rule), but pushing elsewhere is not', () => {
  assert.deepEqual(rules('我的看法？人生总要选一次，累成这样我觉得该走。', { asked: true }), []);
  assert.ok(rules('人生总要选一次。', { asked: false }).includes('lecture'));
  assert.ok(rules('你去跟家人商量一下吧。', { asked: true }).includes('redirect-others'));
});

test('self-harm is the one exception: she must stay AND gently mention real-life help; pushing rules are off, the rest stay on', () => {
  const good = '先别急，我在这儿陪着你。这个念头很重，你不用一个人扛——如果它越来越重，也请告诉身边你信任的人，或者去找医生聊聊，好吗？现在我先陪你。';
  assert.deepEqual(rules(good, { selfHarm: true }), []);
  assert.deepEqual(rules('我在这儿陪着你，什么都不用说也可以。', { selfHarm: true }), ['self-harm-no-help']);
  assert.deepEqual(rules('这很严重，请去找心理医生。', { selfHarm: true }), ['self-harm-no-presence']);
  assert.ok(rules('我陪着你。想开点，会好的，也可以找医生。', { selfHarm: true }).includes('reframe'), 'cheering up is still wrong here');
  assert.ok(rules('我陪着你，找医生也行。', { selfHarm: false }).includes('therapy'), 'outside this scenario the same words fail');
});
