// I-111 (docs/claude/2026-11-13-bge-recall.md): the "recall old things by meaning" section of 聊天记忆.
export const ENGLISH_MEMORY_SEMANTIC_UI_COPY: Readonly<Record<string, string>> = {
  '按意思想起旧事（本机模型，约 {0} MB，第一次要下载）': 'Recall old things by meaning (local model, about {0} MB, downloaded once)',
  '关着：不下载、不计算，她想起旧事只按字面和关键词。打开后会先下载一次模型，在你的电脑上运行，聊天内容不会离开这台电脑。':
    'Off: nothing is downloaded or computed, and she recalls only by words and keywords. Turning it on downloads the model once; it runs on your computer and your chats never leave it.',
  '正在下载本机模型… {0}%': 'Downloading the local model… {0}%',
  '已打开，但模型还没装好。': 'On, but the model is not installed yet.',
  '已打开。已按意思整理 {0} / {1} 段旧聊天（后台在你不忙的时候慢慢补，没补到的段仍按字面想起）。':
    'On. {0} of {1} old chats are indexed by meaning (it fills in slowly while you are not busy; the rest are still recalled by words).',
  '已打开。还没有可整理的旧聊天。': 'On. There are no old chats to index yet.',
  '下载没完成，要重试吗？': 'The download did not finish. Try again?',
  '下载的文件没通过校验，已丢弃。要重试吗？': 'The downloaded file failed its check and was discarded. Try again?',
  '已取消下载，这个功能关着。': 'Download canceled. This feature is off.',
  '本机模型刚才没能正常运行，下次用到时会重新启动；这期间想起旧事只按字面和关键词。':
    'The local model did not run properly; it restarts the next time it is needed. Until then she recalls only by words and keywords.',
  '已删除本机模型和算出来的结果，这个功能关着。': 'The local model and what was computed with it were deleted. This feature is off.',
  '删除本机模型': 'Delete local model',
  '已安装 {0} MB · BGE-small-zh-v1.5（智源 BAAI，MIT 许可；ONNX 转换：Xenova）· 只在你的电脑上算，处理器':
    'Installed {0} MB · BGE-small-zh-v1.5 (BAAI, MIT licence; ONNX conversion: Xenova) · computed on your computer only, CPU',
};
