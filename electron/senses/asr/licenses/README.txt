soft hearts next - local speech recognition component

These files were downloaded by soft hearts next onto this computer, with your consent. They are not part of
the application package. Microphone audio is recognised on this computer only; it is never saved or
uploaded. Delete everything here from the app (Settings > Connection and voice > Voice input > Delete), or
remove this folder by hand.

Where the files come from
- Speech model: SenseVoiceSmall, by Alibaba Group's Tongyi Lab (FunAudioLLM),
  https://github.com/FunAudioLLM/SenseVoice and https://huggingface.co/FunAudioLLM/SenseVoiceSmall .
  The ONNX file with int8 weights and the token list are the conversion published by the sherpa-onnx
  project (k2-fsa / Next-gen Kaldi, Fangjun Kuang), downloaded unchanged from its own repository:
  https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
  (commit 2365baeacb507f821a0c8120fcee3d484dba7a07). soft hearts next does not redistribute them.
- Runtime (ONNX Runtime, DirectML, DirectX Shader Compiler): exactly the same files as the local pose-sensing
  component. When that component is installed they are copied from it after a hash check; otherwise they come
  first from the soft hearts next GitHub Release pack and, if that cannot be downloaded, from the official npm
  packages. Only the CPU is used for speech recognition.

Component                          Source                                              License
SenseVoiceSmall (model name kept)  Alibaba Group, Tongyi Lab / FunAudioLLM             FunASR Model Open Source License
  model.int8.onnx, tokens.txt      ONNX conversion: sherpa-onnx (k2-fsa)               Agreement v1.1
                                                                                       (FunASR-MODEL_LICENSE.txt)
onnxruntime-node 1.31.1            https://registry.npmjs.org/onnxruntime-node         MIT (onnxruntime-LICENSE.txt,
onnxruntime-common 1.31.1          https://registry.npmjs.org/onnxruntime-common       onnxruntime-ThirdPartyNotices.txt)
DirectML.dll, dxcompiler.dll       inside onnxruntime-node (not used for speech)       see DirectML-*.txt and
                                                                                       DirectXShaderCompiler-*.txt

The FunASR model licence lets anyone use, copy, modify and share the model, and asks that the source and
author be credited and the model name be kept (section 2.2). It provides the model "for reference and
learning" without liability (section 3), forbids unjustified denigration of the model (section 4.2), and
may be revised by its authors (section 6).
