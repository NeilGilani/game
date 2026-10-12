# Third-party components

| Component | Where | License |
|---|---|---|
| MediaPipe Tasks Vision (`@mediapipe/tasks-vision` 0.10.35), including its WebAssembly runtime | `frontend/node_modules`, copied to `frontend/public/mediapipe/wasm` at build time | Apache License 2.0 |
| MediaPipe Face Landmarker model (`face_landmarker.task`, float16, v1) | `frontend/public/models/face_landmarker.task` (downloaded from `storage.googleapis.com/mediapipe-models`, SHA-256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`) | Apache License 2.0 |
| RealEye Webcam EyeTracker Light Open (`@realeye-io/webcam-eyetracker-light-open` 1.1.0, RealEye sp. z o.o., [github.com/RealEye-io/webcam-eyetracker-light-open](https://github.com/RealEye-io/webcam-eyetracker-light-open)): its eye-image feature extractor, called unchanged from `os/gaze/src/eyeImage.ts` | `node_modules` (npm), bundled into the interface | AGPL-3.0-or-later, or RealEye's commercial license (no fee for companies and academic projects under USD 1M) |
| QR Code Generator for JavaScript (`qrcode-generator` 1.4.4, Kazuhiko Arase) | bundled into the interface (simulated phones page) | MIT License |
| chess.js (`chess.js` 1.4.0, Jeff Hlywa) | bundled into the interface (Chess game: move rules and the computer player's search) | BSD 2-Clause License |
| pdf-lib (`pdf-lib` 1.17.1, Andrew Dillon) and its `@pdf-lib/standard-fonts` and `@pdf-lib/upng` | bundled into the interface (Papers: reading and filling form fields, placing a signature) and `os/tasks` | MIT License |
| PDF.js (`pdfjs-dist` 5.7.284, Mozilla), including its worker | bundled into the interface (Papers and Talk: the text and pictures of PDF pages) and `os/tasks` tests | Apache License 2.0 |
| Atkinson Hyperlegible font (`@fontsource/atkinson-hyperlegible`) | bundled into the interface | SIL Open Font License 1.1 |
| Atkinson Hyperlegible Next font (`@fontsource-variable/atkinson-hyperlegible-next` 5.3.0, Braille Institute of America) | served by the website (`site/`), text face | SIL Open Font License 1.1 |
| Fraunces font (`@fontsource-variable/fraunces` 5.3.0, Undercase Type) | served by the website (`site/`), headline face | SIL Open Font License 1.1 |
| React, Vite, FastAPI, Pydantic, Uvicorn, Anthropic Python SDK and other dependencies | `package.json`, `backend/requirements*.txt` | Their respective open-source licenses |

The end-to-end camera test downloads MediaPipe's public sample image
(`storage.googleapis.com/mediapipe-assets/portrait.jpg`) into an ignored cache at test time.
It is not committed to this repository and is not shown in the product.

RealEye's package is dual-licensed. Under the AGPL option, anyone who uses a deployed copy of the
interface (the web demo included) must be able to get its complete source, this repository, under
the AGPL. To ship AGENCY closed-source, use RealEye's commercial license instead (free under USD 1M,
see its `LICENSE-COMMERCIAL.md`) or remove `os/gaze/src/eyeImage.ts`, which turns the eye-image
model off and leaves the landmark model as it was.
