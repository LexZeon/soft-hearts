soft hearts next - local pose-sensing components

These files were downloaded by soft hearts next onto this computer, with your consent. They are not part of
the application package. Camera frames are processed on this computer only; they are never saved or
uploaded. Delete everything here from the app (Settings > Privacy > Local pose sensing > Delete), or remove
this folder by hand.

Where the files come from
- Runtime (ONNX Runtime, DirectML, DirectX Shader Compiler): first from the soft hearts next GitHub Release
  https://github.com/LexZeon/soft-hearts/releases/tag/pose-components-v1 as a small pack for this
  platform. The pack holds the files below taken unchanged from the official npm packages (only split by
  platform, no byte modified, recompiled or re-signed); every file is checked against the SHA-256 of the
  official file before it is used. If the pack cannot be downloaded, the app downloads the official npm
  packages instead and keeps the same files.
- Model weights: always from OpenMMLab's own server. soft hearts next does not redistribute them.

Component                        Source                                          License
onnxruntime-node 1.31.1          https://registry.npmjs.org/onnxruntime-node     MIT (onnxruntime-LICENSE.txt;
onnxruntime-common 1.31.1        https://registry.npmjs.org/onnxruntime-common   onnxruntime-ThirdPartyNotices.txt
                                                                                 for code compiled into the binaries)
DirectML.dll 1.15.4 (inside onnxruntime-node)                                    Microsoft DirectML license terms
                                                                                 (DirectML-LICENSE.txt, DirectML-ThirdPartyNotices.txt,
                                                                                 from the Microsoft.AI.DirectML 1.15.4 NuGet package)
dxcompiler.dll 1.8.2502 (inside onnxruntime-node)  DirectX Shader Compiler       University of Illinois/NCSA Open Source
                                                                                 License (LLVM) and further notices
                                                                                 (DirectXShaderCompiler-LICENSE.txt,
                                                                                 DirectXShaderCompiler-ThirdPartyNotices.txt,
                                                                                 from the v1.8.2502 tag)
RTMDet-nano person detector      https://download.openmmlab.com/mmpose/v1/projects/rtmpose/rtmpose-cpu.zip
RTMPose-m body7 256x192          https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/
                                 rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip
                                 Published by OpenMMLab / MMPose and MMDetection (code: Apache-2.0,
                                 https://github.com/open-mmlab/mmpose, https://github.com/open-mmlab/mmdetection).
                                 The release pages give no separate licence for the weights.

The model weights are used under the publisher's terms. They were trained on public datasets that carry
their own terms, some of which restrict commercial use. This project neither grants nor relaxes those
terms; use beyond personal, non-commercial use needs its own review.
