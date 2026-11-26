soft hearts next - recall by meaning component

These files were downloaded by soft hearts next onto this computer, with your consent (you turned on
"recall old things by meaning" in the chat memory settings). They are not part of the application package.
Your memories and messages are turned into numbers on this computer only; nothing is sent anywhere. Delete
everything here from the app (chat memory settings > recall by meaning > Delete), or remove this folder by hand.

Where the files come from
- Model: BGE-small-zh-v1.5 by BAAI (Beijing Academy of Artificial Intelligence), https://huggingface.co/BAAI/bge-small-zh-v1.5 ,
  declared MIT licensed on its model card (the BAAI model repository has no separate licence file; the licence text of its code
  project, FlagEmbedding, is FlagEmbedding-LICENSE.txt). BAAI publishes no ONNX file. The ONNX conversion of the same weights
  (int8-quantized onnx/model_int8.onnx) and the model's own vocab.txt are downloaded unchanged from the conversion published by
  the transformers.js maintainers (Hugging Face user Xenova): https://huggingface.co/Xenova/bge-small-zh-v1.5
  (commit 75c43b069aac4d136ba6bc1122f995fedcfd2781). soft hearts next does not redistribute them.
- Runtime (ONNX Runtime, DirectML, DirectX Shader Compiler): exactly the same files as the local pose-sensing and speech
  components. When either is installed they are copied from it after a hash check; otherwise they come first from the soft hearts
  next GitHub Release pack and, if that cannot be downloaded, from the official npm packages. Only the CPU is used here.

Component                            Source                                              License
BGE-small-zh-v1.5                    BAAI                                                MIT (model card;
  model_int8.onnx, vocab.txt         ONNX conversion: Xenova / transformers.js           FlagEmbedding-LICENSE.txt)
onnxruntime-node 1.31.1              https://registry.npmjs.org/onnxruntime-node         MIT (onnxruntime-LICENSE.txt,
onnxruntime-common 1.31.1            https://registry.npmjs.org/onnxruntime-common       onnxruntime-ThirdPartyNotices.txt)
DirectML.dll, dxcompiler.dll         inside onnxruntime-node (not used here)             see DirectML-*.txt and
                                                                                         DirectXShaderCompiler-*.txt
