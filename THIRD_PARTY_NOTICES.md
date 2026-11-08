# Third-party notices

本项目的原创源码使用根目录 MIT 许可证。第三方组件保留各自许可；下面区分实际依赖与仅供参考的项目，参考项目见 [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)。

## Runtime components

| Component | Use | License/source |
| --- | --- | --- |
| Three.js 0.170.0 | WebGL、MMD loader/helper、相机控制 | [MIT](https://github.com/mrdoob/three.js/blob/r170/LICENSE) |
| mmd-parser（由 Three.js examples 提供） | PMX/PMD/VMD 与字符编码解析 | [MIT](https://github.com/takahirox/mmd-parser/blob/master/LICENSE) |
| Electron | 桌面窗口、IPC、系统安全存储及捕获接口 | [MIT](https://github.com/electron/electron/blob/main/LICENSE) |

Electron 发行包还包含 Chromium、Node.js 等组件；分发桌面包时须保留 Electron 自带的 `LICENSE` 与 `LICENSES.chromium.html` 等通知文件。便携版由 electron-builder 打包这些运行时文件。

Codex CLI 由用户独立安装，本应用通过其命令行接口调用，不在应用包中分发 CLI、账户凭据或模型权重。系统语音由操作系统或浏览器运行时提供，不包含额外音色模型。

## Optional local pose-sensing components (downloaded on demand, not bundled)

These components are **not part of the application package**. Only after the user turns the camera on and clicks
「下载」, the application downloads them into the per-user folder
`%LOCALAPPDATA%\soft-hearts-claude\components\pose-v1\<platform>\`, verifies every kept file against the SHA-256 in the
application's built-in manifest (`electron/pose/manifest.ts`), and processes camera frames on this computer only. An
offline import accepts only files with the same sizes and hashes.

- **Model weights** always come from OpenMMLab's own server; this project never redistributes them.
- **Runtime** (ONNX Runtime with DirectML and the DirectX Shader Compiler) comes first from this project's GitHub Release
  [`pose-components-v1`](https://github.com/LexZeon/soft-hearts/releases/tag/pose-components-v1) as one small pack
  per platform (project decision: about 85 MB instead of 170 MB for the first download). Each pack holds exactly
  the files the manifest keeps from the official npm packages `onnxruntime-node` / `onnxruntime-common` 1.31.1,
  unchanged (only split by platform; nothing modified, recompiled or re-signed), plus the license texts below. If the pack
  cannot be downloaded, the application downloads the official npm packages instead and keeps the same files. Packs are
  built reproducibly by `scripts/pose-release-pack.ts` (release notes: `docs/claude/pose-components-release-notes.md`).

Each installed component folder (and each pack) carries `licenses/`: ONNX Runtime MIT and `ThirdPartyNotices.txt`,
DirectML license terms and third-party notices, the DirectX Shader Compiler license and third-party notices, and a README
with the sources below.

| Component | Use | License/source |
| --- | --- | --- |
| ONNX Runtime (`onnxruntime-node` 1.31.1, `onnxruntime-common` 1.31.1, from the npm registry or, split by platform and unchanged, from this project's Release) | Runs the ONNX models on CPU and DirectML in a separate utility process | [MIT](https://github.com/microsoft/onnxruntime/blob/v1.31.1/LICENSE) (full text below); [`ThirdPartyNotices.txt`](https://github.com/microsoft/onnxruntime/blob/v1.31.1/ThirdPartyNotices.txt) of the `v1.31.1` tag is shipped in `licenses/` |
| DirectML 1.15.4 (`DirectML.dll`, shipped inside the `onnxruntime-node` package) | GPU acceleration on Windows | [Microsoft DirectML license terms](https://www.nuget.org/packages/Microsoft.AI.DirectML/1.15.4) (copying and distribution in applications that run on Windows allowed; no stand-alone offering); `LICENSE.txt` and `ThirdPartyNotices.txt` from `Microsoft.AI.DirectML` 1.15.4 are shipped in `licenses/` |
| DirectX Shader Compiler 1.8.2502 (`dxcompiler.dll`, shipped inside the `onnxruntime-node` package) | Shader compilation for DirectML | [University of Illinois/NCSA Open Source License (LLVM)](https://github.com/microsoft/DirectXShaderCompiler/blob/v1.8.2502/LICENSE.TXT) plus the notices in its [`ThirdPartyNotices.txt`](https://github.com/microsoft/DirectXShaderCompiler/blob/v1.8.2502/ThirdPartyNotices.txt); both texts of the `v1.8.2502` tag are shipped in `licenses/` |
| RTMPose-m body7 256×192 weights (`rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504`) | 17 body keypoints | Published by [OpenMMLab / MMPose](https://github.com/open-mmlab/mmpose) (code: Apache-2.0). See the note below about training data |
| RTMDet-nano person detector weights (inside OpenMMLab's `rtmpose-cpu.zip`) | Person detection | OpenMMLab / MMDetection (code: Apache-2.0). See the note below |
| rtmlib (reference only, not distributed) | Pre/post-processing logic was re-implemented from it (`electron/pose/pipeline.ts`) | [Apache-2.0](https://github.com/Tau-J/rtmlib/blob/main/LICENSE) |

The model weights are used under the publisher's terms. They were trained on public datasets that carry their own terms,
some of which may restrict commercial use (not reviewed one by one). This project neither grants nor relaxes those terms;
use beyond personal, non-commercial use needs its own review (project decision: the weights are never bundled,
each computer downloads them from OpenMMLab).

Downloads (component version 1; per-file SHA-256 of every kept runtime file in `electron/pose/manifest.ts`):

| Download | Bytes | Hash |
| --- | --- | --- |
| `https://github.com/LexZeon/soft-hearts/releases/download/pose-components-v1/soft-hearts-pose-runtime-v1-win32-arm64.tgz` (tried first on Windows ARM64: the 31 runtime files of the two npm packages below, unchanged, plus `licenses/` and `PACK-MANIFEST.json`) | 30,611,826 | SHA-256 `607a2e730f6c0d34ba2d90c5af4377bb547ba1a4e207eeda68f8a2ad985c62f0` |
| `https://github.com/LexZeon/soft-hearts/releases/download/pose-components-v1/soft-hearts-pose-runtime-v1-win32-x64.tgz` (tried first on Windows x64, same contents for x64) | 29,499,386 | SHA-256 `539a2ec4d1b4e16406c87f438f496c7e4c37057cf5f625ebed8b8c5c19dc016a` |
| `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz` (fallback when the pack cannot be downloaded) | 115,391,311 | `sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==` (npm integrity) |
| `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.31.1.tgz` (fallback, with the one above) | 72,322 | `sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==` (npm integrity) |
| `https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip` | 50,799,818 | SHA-256 `f7fbb6c5c11a1bb70f3d445e4ddec5d144ea89ad5649c081ef976f9b24a0b741`; kept `end2end.onnx` (54,330,655 bytes) `5c0a4bf67953e6d2ac43ce15e77dc9d5d354ae18430a47d2c5963a7bc5683e3c` |
| `https://download.openmmlab.com/mmpose/v1/projects/rtmpose/rtmpose-cpu.zip` (only the RTMDet-nano entry is fetched, by range request) | 54,564,140 | SHA-256 `54e1d48a8946c87d66e96f81438344fec6e471cb3e44b71dfa04be6e879f3528`; kept `rtmdet-nano/end2end.onnx` (4,012,393 bytes) `b8585adb6d1352796f6e86337e09c3459b830645a7e7192d9381670bea2facbd` |

## Optional local speech-recognition component (downloaded on demand, not bundled)

Voice input's default recognizer (project decision). Only after the user turns voice input on and clicks「下载」
(or imports the files offline), the application downloads it into
`%LOCALAPPDATA%\soft-hearts-claude\components\asr\asr-v1\<platform>\`, verifies every kept file against the SHA-256 in
`electron/asr/manifest.ts`, and recognises microphone audio on this computer only, on the CPU, in a separate utility
process. Audio and text are never saved or uploaded by it.

- **Model**: SenseVoiceSmall by Alibaba Group's Tongyi Lab ([FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice),
  [FunAudioLLM/SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)), under the
  [FunASR Model Open Source License Agreement v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE): use, copy,
  modify and share allowed; the source and author must be credited and the model name kept (section 2.2); provided
  without liability (section 3); no unjustified denigration (section 4.2); the authors may revise it (section 6). The
  ONNX file with int8 weights and the token list are the conversion published by the sherpa-onnx project (k2-fsa / Next-gen
  Kaldi, Fangjun Kuang; conversion code Apache-2.0), downloaded unchanged from its own repository at a pinned commit. This
  project never redistributes them. The licence text is shipped in the component's `licenses/FunASR-MODEL_LICENSE.txt`.
- **Runtime**: exactly the ONNX Runtime files of the pose-sensing component above (same manifest entries, same licences in
  `licenses/`). When that component is installed they are copied from it after a hash check instead of being downloaded.
- **Front end and decoding** (Kaldi-compatible filter banks, low frame rate stacking, CMVN, greedy CTC) are this project's
  own TypeScript (`electron/asr/features.ts`, `decode.ts`), written from the published FunASR / Kaldi definitions.

| Download | Bytes | Hash |
| --- | --- | --- |
| `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx` | 239,233,841 | SHA-256 `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt` | 315,894 | SHA-256 `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc` |
| Runtime: the pose component's pack or npm packages above (skipped when pose sensing is installed) | 30,611,826 / 115,463,633 | as above |

## Bundled Gene model, textures and motions

The source ZIP and application include the Gene model, required textures and 40 dialog motions by Nagoya Institute of Technology under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/), separately from this project's MIT code license. No Uka resources or private user models are bundled.

```text
CG-CA Gene (c) 2023 by Nagoya Institute of Technology, Moonshot R&D Goal 1 Avatar Symbiotic Society
```

Source: [Gene](https://github.com/mmdagent-ex/gene), pinned revision `c7eace43dffaccff6ad0597433ef85fa57c91e03`. The bundle retains the full upstream README and usage guidelines, full license text, attribution, original filenames, source URLs and SHA-256 checksums. External paths are organized in English; PMX, texture and VMD contents are unchanged. Gene's trademark and design rights are reserved; uses other than the academic and personal non-commercial examples in the upstream notice may require contacting the author. Redistribution of these assets preserves CC BY 4.0 and all notices. See [bundled asset provenance](docs/motion-library.md).

## Additional CC BY 4.0 motion subsets

These assets are separate from the MIT code license. Every source folder contains the full CC BY 4.0 text, attribution, source links, original/output hashes and modification records.

- **100STYLE:** The 100STYLE Dataset - Ian Mason. Ian Mason, Sebastian Starke and Taku Komura (2022), *Real-Time Style Modelling of Human Locomotion via Feature-Wise Transformations and Local Motion Phases*, DOI 10.1145/3522618. [Author source and CC BY 4.0 declaration](https://www.ianxmason.com/100style/). Five idle excerpts retargeted from BVH to Gene VMD, cropped, resampled, fixed in place and loop blended.
- **MPI EMBM:** Volkova, Ekaterina (2014). *MPI EMBM Database Mocap Files*. figshare. Dataset. DOI 10.6084/m9.figshare.1220428.v1. [Source](https://figshare.com/articles/dataset/MPI_EMBM_Database_Mocap_Files/1220428). Five intact body-gesture excerpts retargeted to Gene upper body, cropped, resampled and loop blended; the publisher's original archive is truncated, so no claim is made to include the complete dataset.
- **GENEA Challenge 2022:** Youngwoo Yoon, Pieter Wolfert, Taras Kucherenko, Carla Viegas, Teodor Nikolov, Mihail Tsakov, and Gustav Eje Henter. 2022. *The GENEA Challenge 2022: A large evaluation of data-driven co-speech gesture generation*. Proceedings of ACM ICMI 2022. [Submitted BVH files, v1.1.0](https://zenodo.org/records/6977157). Two FSB upper-body excerpts retargeted, cropped, fixed in place and loop blended. **FNA and UNA, which are CC BY-NC 4.0, are excluded.**
- **Split Dance:** Motion by fnoji (えふのじ), CC BY 4.0. [Author's distribution and license declaration](https://www.nicovideo.jp/watch/sm46039479), [BOOTH](https://booth.pm/ja/items/8103074). Original VMD bytes unchanged; English filename, classification and tags added.

No music, audio, preview video, preview characters or stages are distributed with these motion subsets. The unavailable Fork Shake distribution is not included. See [motion provenance and maintenance](docs/motion-library.md).

## Build and test dependencies

精确版本由 `pnpm-lock.yaml` 锁定。Vite、esbuild、tsx、electron-builder、`@types/three` 使用 MIT；TypeScript、Playwright 使用 Apache-2.0；`@types/node` 的许可和附属通知保留在其安装包中。完整依赖树及每个包的通知可在安装后的 `node_modules` 中查阅；更新或新增可分发依赖时，同时复核本文件及打包内容。

## Three.js license

The MIT License

Copyright © 2010-2024 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## mmd-parser license

MIT License

Copyright (c) 2016 Takahiro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Electron license

Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


## Ammo.js and Bullet local physics runtime

The optional local MMD secondary physics uses the unmodified ammo.wasm.js and ammo.wasm.wasm distributed with three@0.170.0. Ammo.js and Bullet retain their separate zlib notices below; the application's MIT license and Three.js MIT license do not replace them. The runtime is loaded only from packaged local assets.

Reviewed Three r170 bytes: JS SHA-256 3fa63c584d4732f72b954c5ea105f1faca99559c95c57ce7bb738d3497f98228; WASM SHA-256 16be07b989963bddebfef66eab28a4387536eb37014d9df1531dab380bd96a93. The exact original Emscripten/Ammo build revision is not identified by these prebuilt files; no reproducible build from a newer source revision is claimed.

Byte provenance: https://github.com/mrdoob/three.js/tree/beab9e845f9e5ae11d648f55b24a0e910b56a85a/examples/jsm/libs

License evidence: https://github.com/kripken/ammo.js/tree/c8779e60159d428f11ff1eb553dc9b6b6e2d317a

### Ammo.js license

Copyright (c) 2011 ammo.js contributors

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

---

See AUTHORS for list of contributors.



### Ammo.js authors

The following authors have all licensed their contributions to ammo.js
under the licensing terms detailed in LICENSE.

* Alon Zakai <alonzakai@gmail.com> (copyright owned by Mozilla Foundation)



### Bullet notice

/*
Bullet Continuous Collision Detection and Physics Library
Copyright (c) 2003-2011 Erwin Coumans  http://bulletphysics.org

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from the use of this software.
Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it freely,
subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
*/

All files in the Bullet/src folder are under this Zlib license.
Files in the Extras and Demos folder may have a different license, see the respective files.



## ONNX Runtime license

(Applies to the optional, downloaded `onnxruntime-node` / `onnxruntime-common` component; see above.)

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
