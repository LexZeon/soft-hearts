soft hearts next - face check component ("认出是不是你")

These files were downloaded by soft hearts next onto this computer, with your consent. They are not part of
the application package. They are used only to check whether the person in front of the camera is you: the
picture is processed on this computer, never saved and never uploaded. Your own face is kept only as numbers
(not a photo), encrypted, in the app's profile; nobody else is stored or identified. Delete the numbers from
the app (Privacy > Camera > 认出是不是你 > 删除我的脸部数据) and these files from its advanced settings, or remove
this folder by hand.

Where the files come from (OpenCV Zoo, https://github.com/opencv/opencv_zoo, downloaded unchanged)

Component                                   Source                                        License
YuNet face detector                         models/face_detection_yunet                   MIT (YuNet-LICENSE.txt)
  face_detection_yunet_2023mar.onnx
SFace face recognizer (int8)                models/face_recognition_sface                 Apache-2.0 (SFace-LICENSE.txt)
  face_recognition_sface_2021dec_int8.onnx
onnxruntime-node 1.31.1                     https://registry.npmjs.org/onnxruntime-node   MIT (onnxruntime-LICENSE.txt,
onnxruntime-common 1.31.1                   https://registry.npmjs.org/onnxruntime-common onnxruntime-ThirdPartyNotices.txt)
DirectML.dll, dxcompiler.dll                inside onnxruntime-node (not used here)       see DirectML-*.txt and
                                                                                          DirectXShaderCompiler-*.txt

The runtime files are exactly the same as the local pose-sensing component's; when that (or local speech
recognition, or recall by meaning) is installed they are copied from it after a hash check. Only the CPU is used.

SFace: Yaoyao Zhong, Weihong Deng et al., "SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face
Recognition", IEEE Transactions on Image Processing, 2021.
