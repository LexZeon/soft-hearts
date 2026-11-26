// Unbound v1 step 1 (docs/claude/2026-11-15-unbound-v1-step1-entry.md): the tray item, the control window's button, the
// permission page and the notice after entering (electron/unbound/permission-bundle.ts).
export const ENGLISH_UNBOUND_UI_COPY: Readonly<Record<string, string>> = {
  '让她出来': 'Let her out',
  '回到小窗': 'Back to the small window',
  '让她离开小窗，在你的电脑上生活（Ctrl+Alt+U）。进去前会先列出要打开的权限，你确认了才开。':
    'Let her leave the small window and live on your computer (Ctrl+Alt+U). First you see which permissions it turns on; nothing turns on until you confirm.',
  '让她回到桌宠小窗（Ctrl+Alt+U），权限恢复成你原来的设置。': 'Bring her back to the small window (Ctrl+Alt+U); permissions go back to your earlier settings.',
  '让她出来，在你的电脑上生活': 'Let her out to live on your computer',
  '她会离开桌宠小窗，站到屏幕后面的世界里。为了让她在你的电脑上生活，下面这些会一起打开：':
    'She leaves the small window and stands in the world behind your screen. So she can live on your computer, these turn on together:',
  '摄像头（姿势识别）：看你在不在、有没有看她，她会注意到你、抬头看你。只在这台电脑上识别，画面不离开电脑、不保存。':
    'Camera (pose recognition): whether you are there and looking at her, so she notices you and looks up. Recognised on this computer only; the picture never leaves it and is not saved.',
  '摄像头（发图片）：她能通过摄像头看到你，看你时画面会发给 Claude。只在她出来时开着，回到小窗就恢复成你进来前的样子。':
    'Camera (send pictures): she can see you through the camera; when she looks at you, the picture is sent to Claude. On only while she is out; when she is back in the small window it returns to how it was before.',
  '麦克风：你可以直接开口跟她说话。你的声音在本机转成文字，录音不保存。': 'Microphone: you can simply talk to her. Your voice becomes text on this computer; no recording is kept.',
  '屏幕：她能看看你在做什么。': 'Screen: she can see what you are doing.',
  '电脑的声音：和你一起听歌、看剧。': 'Computer sound: she listens to music and watches shows with you.',
  '认出是不是你（Beta）：用摄像头在这台电脑上认你的脸，看到不是你时她会知道。': 'Recognise you (Beta): the camera recognises your face on this computer, so she knows when it is not you.',
  '（已经开着）': ' (already on)',
  '（认脸组件还没下载。这里不会替你下载，这一项先不开；想用的话在设置的「隐私」里打开它）':
    ' (its face components are not downloaded. Nothing is downloaded from here, so this one stays off; to use it, turn it on under Privacy in the settings)',
  '（你还没登记自己的脸，登记之前它什么都不做）': ' (you have not enrolled your face yet; until you do, it does nothing)',
  '她在外面时，这些一直开着（暂时不能单独关）；回到小窗时，会恢复成你进来前的设置，任何一项随时都能在设置里自己关掉。':
    'While she is out these stay on (they cannot be switched off one by one for now); when she goes back to the small window they return to your earlier settings, and you can turn any of them off yourself in the settings at any time.',
  '花钱的语音（百炼）、Claude 任务执行和密钥不会因为这里打开；你本来开着的朗读，照常用。':
    'Paid voice (Bailian), Claude tasks and keys are not turned on by this; read-aloud keeps working if you already had it on.',
  '随时按 Ctrl+Alt+U、点托盘或控制窗口里的「回到小窗」，她就回来。': 'Press Ctrl+Alt+U, or choose Back to the small window in the tray or the controls, and she comes back at any time.',
  '以后直接进，不再问': 'Go straight in next time, do not ask again',
  '取消': 'Cancel',
  '她出来了': 'She is out',
  '她没能出来': 'She could not come out',
  '这次没有替你打开摄像头、麦克风、屏幕或电脑的声音（它们只在她出来以后才开）；你自己原来开着的，照旧开着。':
    'Nothing was turned on this time: not the camera, microphone, screen or computer sound (they only turn on once she is out). Whatever you already had on stays on.',
  '这几样没打开：{items}。可能缺少本机组件，或者还没设置好；可以在设置的「输入与共享」和「隐私」里看看。':
    'These did not turn on: {items}. A local component may be missing or not set up yet; see Input & sharing and Privacy in the settings.',
  '摄像头（姿势识别）': 'Camera (pose recognition)', '摄像头（发图片）': 'Camera (send pictures)', '麦克风': 'Microphone', '屏幕': 'Screen', '电脑的声音': 'Computer sound', '认出是不是你（Beta）': 'Recognise you (Beta)',
  '知道了': 'OK',
  // I-154 / I-176: Unbound's engine in the companion window and the preview (src/unbound/window-style-slider.ts, window-mode/)
  '桌宠窗口和这个窗口的预览都由 Unbound 的引擎来画；这里调"个人感"的强度（0 是不加）。不会打开摄像头、麦克风、屏幕或电脑的声音，这些照旧只由你自己开。':
    "The companion window and this window's preview are both drawn by Unbound's engine; this sets how strong the personal feel is (0 adds none). It does not turn on the camera, microphone, screen or computer sound; those stay yours alone to turn on.",
  '个人感 ': 'Personal feel ',
  '没存上（这台电脑的页面存储不可用），个人感保持原样。': 'Could not save (page storage is unavailable on this computer); the personal feel stays as it was.',
  '桌宠正在用 Unbound 引擎（实验），这一项还没搬过来': 'The companion window is using the Unbound engine (experimental); this one is not moved over yet',
  '动作载入失败：{0}': 'Motion failed to load: {0}',
  '模型载入失败：{0}': 'Model failed to load: {0}',
  '请选择 PMX / PMD / VRM 模型': 'Choose a PMX / PMD / VRM model',
  '模型已载入 · 部分纹理缺失': 'Model loaded · some textures missing',
  '模型已载入 · 纹理加载中…': 'Model loaded · textures loading…',
  'VRM 模型已载入 · 这个格式的动作和表情还在做': 'VRM model loaded · motions and expressions for this format are still being built',
  '模型加载失败：{0}': 'Could not load the model: {0}',
  '模型未加载': 'No model loaded',
  '这个 .vrm 读不出来（不是 GLB 文件）': 'This .vrm cannot be read (it is not a GLB file)',
  '正在加载模型与纹理…': 'Loading the model and textures…',
  '显卡上下文已丢失，请重新打开窗口恢复模型。': 'The graphics context was lost. Reopen the window to restore the model.',
  // The small input box (src/unbound/input.ts; the three lines the host returns are electron/unbound/typing.ts SUBMIT_HINTS)
  'soft hearts · 对她说': 'soft hearts · Say something',
  '对她说点什么…': 'Say something to her…',
  '对{0}说点什么…': 'Say something to {0}…', // I-209 step 3: the box of the one you clicked, with several on stage
  'Enter 发送 · Esc 关闭': 'Enter to send · Esc to close',
  '没能发出去，再试一次。': 'Could not send that; try again.',
  '没发出去，再试一次。': 'That did not go out; try again.', '发送中…': 'Sending…', '这句已经收回了，没有再发。': 'That line was taken back; it was not sent.', // 2026-11-22 shared/brain/send-drop.ts SEND_DROP_HINT: the box (and the chat boxes) a dropped line went back to
  '现在发不出去（Claude 暂时用不了），过一会儿再试。': 'Cannot send right now (Claude is unavailable for the moment); try again in a little while.',
  '她已经回小窗了。': 'She has gone back to the small window.',
  // The box's 打电话 button (2026-11-19; the reasons are the call's own, electron/voice/voice-call/controller.ts)
  '打电话': 'Call', '挂断': 'Hang up', '现在打不了电话。': 'Cannot call right now.', '电话没打成，再试一次。': 'The call did not go through; try again.',
  '请先让这个窗口显示出来，再打电话。': 'Show this window first, then call.', '她睡着了，先别打电话吧。': 'She is asleep; maybe do not call just now.',
  '麦克风没有打开，通话没有开始：可能还没有本机语音识别，设置里会有说明。': 'The microphone did not turn on, so the call did not start: local speech recognition may not be installed yet (Settings explains).',
  '麦克风没有打开，通话没有开始。': 'The microphone did not turn on, so the call did not start.',
  // I-159: the senses light's hover, the line beside her after entering, the control window's 「下次进来时再问我」
  '摄像头开着': 'Camera is on', '麦克风开着': 'Microphone is on', '屏幕开着': 'Screen is on', '电脑的声音开着': 'Computer sound is on',
  '她在外面时它们一直开着；想关，先回小窗。': 'These stay on while she is out; to turn one off, go back to the small window first.',
  '这次打开了：{items}。她在外面时一直开着，回小窗后恢复。': 'Turned on this time: {items}. They stay on while she is out and go back when she is back.',
  '下次进来时再问我': 'Ask me again next time',
  '让她出来时重新显示权限说明页（取消「以后直接进，不再问」）。': 'Show the permission page again the next time she goes out (clears "Go straight in from now on").',
  '好，下次会再问。': 'OK, the page comes again next time.',
  '本来就会再问。': 'It was going to ask anyway.',
  // I-154 batch 2: her face on the window engine, the developer line of what it cannot show (src/unbound/window-mode/window-face.ts, window-blush.ts).
  '当前模型缺少可识别头骨': 'This model has no head bone the stage can find',
  '手选头部动作保持播放，自动情绪姿态让位；直接 rua 附加仍保留': 'The picked head motion keeps playing and her automatic mood posture steps aside; a pat still adds on top',
  '手选表情优先，自动面部让位': 'The picked expression comes first; her automatic face steps aside',
  '未识别到笑意 morph，使用眼神和姿态': 'No smile morph found; she uses her eyes and posture instead',
  '角色页关了"能脸红"：脸红不开': 'The character page has "Can blush" off: no blush',
  '体检卡没开"能闭眼"：疲倦眼皮不开': 'The model check card does not have "Can close eyes" on: no tired eyelids',
  '体检卡没开"困的脸"：困的脸不开': 'The model check card does not have "Sleepy face" on: no sleepy face',
  // I-154 batch 6: tears on the window engine (window-blush.ts, window-tears.ts).
  '角色页关了"能流泪"：流泪不开': 'The character page has "Can cry" off: no tears',
  '泪水定位尚未就绪': 'Tear placement is not ready yet',
  '红晕需要可识别头骨与双眼参考点': 'A blush needs a head bone and both eyes the stage can find',
  // I-154 batch 7: the control window's preview, the pictures and the physics form on the window engine (window-stage.ts, window-stage-previews.ts, window-physics.ts).
  '预览已暂停 · 重开窗口自动恢复': 'Preview paused · it comes back when the window opens again',
  '模型预览没有可见尺寸。': 'The model preview has no visible size.',
  '头像暂时截不了。': 'The avatar cannot be taken right now.',
  '模型已经变化。': 'The model has changed.',
  '模型预览还没准备好，稍后再截头像。': 'The model preview is not ready yet; take the avatar a little later.',
  '当前模型预览还不能作为参考，请等待载入并结束镜头调整。': 'The model preview cannot be used as a reference yet; wait for it to load and finish adjusting the camera.',
  '载入模型后显示支持情况': 'Support shows once a model is loaded',
  // I-164: blush and tears on a VRM face spread over several meshes (window-blush.ts, src/unbound/her/vrm-blush.ts).
  '双颊不在同一块脸部网格上，未放置程序红晕': 'The two cheeks are not on one face mesh: no painted blush',
  '双颊不在同一块脸部网格上，当前未放置泪痕': 'The two cheeks are not on one face mesh: no tear marks',
  // I-152 step 3: a VRM's own spring bones (src/stage/vrm-spring/vrm-springs.ts support()).
  '这个 VRM 没有头发或衣服的弹簧骨': 'This VRM has no spring bones for hair or clothes',
  '这个 VRM 没有胸部的弹簧骨': 'This VRM has no spring bones for the chest',
  // I-199: the developer panel's status line (src/unbound/control-switch.ts): a full-screen program is in front, information only.
  '有全屏程序在前面（她照样在上面）': 'A full-screen program is in front (she stays on top of it)',
};
