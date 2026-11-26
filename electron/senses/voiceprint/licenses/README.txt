soft hearts next - voiceprint component ("只认你的声音")

These files were downloaded by soft hearts next onto this computer, with your consent (you turned the switch on). They are
not part of the application package. They are used only to tell whether a short piece of speech is your voice: the sound
is processed on this computer, never saved and never uploaded. Your own voice is kept only as numbers (not a recording),
encrypted, in the app's profile; nobody else is stored or identified. Delete the numbers from the app (语音输入 > 只认你的声音 >
删除我的声纹; turning 「允许记录」 off deletes them too) and these files from the same place, or remove this folder by hand.

Where the files come from

Component                                   Source                                                     License
CAM++ speaker model, Chinese common          sherpa-onnx release "speaker-recongition-models"           Apache-2.0 (CAMPPlus-LICENSE.txt)
  3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx  (28,281,138 bytes, SHA-256 f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11)
onnxruntime-node 1.31.1                     copied from an installed component (never downloaded here) MIT (onnxruntime-LICENSE.txt,
onnxruntime-common 1.31.1                                                                               onnxruntime-ThirdPartyNotices.txt)

The runtime files are exactly the same as the local pose-sensing component's; they are copied from that (or local speech
recognition, recall by meaning, or the face check) after a hash check. Without one of those installed, this component is not
installed at all. Only the CPU is used.
