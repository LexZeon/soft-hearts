// I-162 step 2: English copy for 「她的声音」 (the character page), the renamed 「新角色的默认声音」, the update-from-file tick and the notice's link.
// Authored application copy only; never run private content through this catalog.
export const ENGLISH_CHARACTER_VOICE_UI_COPY: Readonly<Record<string, string>> = {
  '她的声音': 'Her voice',
  '这张卡自己的声音：服务商、那家的声音、语速和音调，还有一段「声音描述」。换了人，她的声音不会跟着变；没有自己声音的卡，用「新角色的默认声音」。':
    "This card's own voice: the provider, that provider's voice, pace and pitch, and a voice description. Switching characters does not change her voice; a card without a voice of her own uses the default voice for new characters.",
  '系统声音（免费）': 'System voice (free)',
  '百炼（需要自己的 Key）': 'Bailian (needs your own key)',
  'Drama 3（Fish Audio，付费）': 'Drama 3 (Fish Audio, paid)',
  'Drama 3 的声音编号（reference_id）；不填就不用 Drama 3': "Drama 3 voice id (reference_id); leave empty and Drama 3 is not used",
  '例如：{0}': 'For example: {0}',
  '服务商': 'Provider',
  '声音': 'Voice',
  '声音编号': 'Voice id',
  '语速': 'Pace',
  '音调（只有系统声音能调）': 'Pitch (only the system voice can change it)',
  '声音描述（兼容提示词）': 'Voice description (compatibility prompt)',
  '写她的性别、年纪感、音色、语速、笑起来的样子。她用的服务商没有现成的声音时，会按这段话挑最接近的；百炼会把它当作说话风格。Drama 3 不用这段话（它会把长段描述念出来），Drama 3 的表演提示在朗读设置里另写一句短的。字怎么念写在下面的「读法」里。已知是另一个性别的声音不会被用上。':
    "Describe her gender, age feel, timbre, pace and how she laughs. When her provider has no ready voice for her, the closest one is picked from this; Bailian takes it as her speaking style. Drama 3 does not use it (it reads a long description aloud): Drama 3's acting style is a separate short line in the read-aloud settings. How a word is read goes in Reading below. A voice known to be of the other gender is never used.",
  '这里只存选择，不会读出任何声音，也不会花钱；Key 在「百炼语音」「Drama 3 语音」里填，不在角色卡里，也不会导出。':
    'This only stores a choice: nothing is read aloud and nothing is spent. Keys are filled in under "Bailian voice" and "Drama 3 voice", not in the character card, and are never exported.',
  '百炼是云端朗读：朗读的文字会发给你自己的百炼账号。只选它不会花钱，也不会马上读；要读之前需要先在「百炼语音」填好连接和 Key。':
    'Bailian reads in the cloud: the text is sent to your own Bailian account. Choosing it spends nothing and starts nothing; before it can read, fill in the connection and key under "Bailian voice".',
  'Drama 3 是付费云端朗读，按字节收费，朗读的文字会发给 Fish Audio。只选它不会花钱，也不会马上读；要读之前需要先填好 Key，试听和每月上限照旧。':
    'Drama 3 is a paid cloud voice, charged by the byte; the text is sent to Fish Audio. Choosing it spends nothing and starts nothing; fill in the key first. Previews and the monthly limit work as before.',
  '系统声音是免费的，读的文字不会离开这台电脑。': 'The system voice is free and the text never leaves this computer.',
  'Drama 3 的 Key 还没有填：先用别的声音读（你可以在「Drama 3 语音」里填）。': 'The Drama 3 key is not filled in yet, so another voice reads for now (you can fill it in under "Drama 3 voice").',
  '百炼的连接和 Key 还没有填：先用别的声音读（你可以在「百炼语音」里填）。': 'The Bailian connection and key are not filled in yet, so another voice reads for now (you can fill them in under "Bailian voice").',
  '去填 Drama 3 的 Key': 'Go fill in the Drama 3 key',
  '去填百炼的 Key': 'Go fill in the Bailian key',
  '按声音描述自动挑': 'Pick by the voice description',
  '女声': 'female', '男声': 'male',
  '她现在的声音（列表里没有）': 'Her current voice (not in the list)',
  '保存她的声音': 'Save her voice',
  '恢复成新角色的默认声音': 'Back to the default voice for new characters',
  '试听她现在的声音': 'Preview her current voice',
  '只能试听正在使用的角色；先换成她': 'Only the character in use can be previewed; switch to her first',
  '先保存，再试听': 'Save first, then preview',
  '她现在用「新角色的默认声音」。': 'She now uses the default voice for new characters.',
  '她的声音已保存。': 'Her voice is saved.',
  // The renamed global choice and its note
  '去她的声音设置': 'Go to her voice settings',
  '新角色的默认声音': 'Default voice for new characters',
  '这里选的是新建角色（和还没有自己声音的角色）用的声音服务商；已有角色各用自己卡上的声音，改这里不会让她们的声音变。每个角色自己的声音在「角色」页的「她的声音」里设。':
    "This is the voice provider that new characters (and characters without a voice of their own) use. Existing characters use the voice on their own card, so changing this does not change theirs. Each character's own voice is set under \"Her voice\" on the Characters page.",
  '（点这里去她的声音设置）': '(click here to go to her voice settings)',
  // Updating a card from a file
  '也换成文件里的声音（{0}）；不勾就保留她现在的声音。': "Also switch to the file's voice ({0}); leave this unticked to keep her current voice.",
  '系统声音': 'System voice', '百炼': 'Bailian', '指定的声音': 'a chosen voice',
  '声音：换成文件里的。': 'Voice: replaced with the file\'s.',
  '声音：文件里带了另一个声音；默认保留她现在的（在角色页更新时可以勾选「也换成文件里的声音」）。': "Voice: the file carries another voice; hers stays by default (when updating on the Characters page you can tick \"also switch to the file's voice\").",
  // I-164 reading map
  '读法': 'Reading',
  '她说的字不变，只改声音读的字：名字怎么读、口癖（切、啧）怎么出声。左边是显示的字，右边是读的字；留空的一行不会保存。只有一个字的会在单独出现时才读，所以「关切」里的切不受影响。':
    'What she says on screen stays as it is; only what the voice reads changes: how a name is read, how a tic (like a click of the tongue) sounds. Left is the shown text, right is what is read; an empty row is not saved. A single character is read this way only when it stands alone, so the same character inside a longer word is not affected.',
  '加一条读法': 'Add a reading', '试听读法': 'Hear the readings', '删掉': 'Remove', '显示的字': 'Shown text', '读的字': 'Read as', '用在哪个声音': 'Used for which voice',
  '所有声音': 'Every voice', '只在单独出现时读': 'Only when it stands alone',
};
