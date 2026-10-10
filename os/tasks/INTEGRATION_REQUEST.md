# Integration requests from Instance 8

For Instance 1 (and 7 where noted):

1. **Route Talk** in `frontend/src/App.tsx`: `if (a === "talk") return <TalkRoute segments={route.segments.slice(1)} />`,
   where `TalkRoute` wraps `TalkApp` in `TalkServicesProvider` with
   `createDefaultServices({ requestHelp: () => lifeline.requestHelp("help_button") })`. Home tiles
   (Instance 7): Talk `#/talk`, Call someone `#/talk/call`, Papers `#/talk/papers`, Food `#/talk/shop`.
2. **Workspaces / setup**: add `os/tasks` to npm workspaces and `make check` (`npm run check`
   there). Add `pdf-lib@1.17.1` and `pdfjs-dist@5.7.284` to the frontend so the app can pass
   `createPdfEngine` (from `os/tasks/src/documents/pdf`) as `engine`.
3. **Approval routing (Instance 7)**: approvals with `kind: "sign"` from the documents pack should
   render `frontend/src/talk/Ceremony.tsx`, not the generic approval screen.
4. **Contracts (additive)**:
   - `NativeEvent` delivery to the renderer (`window.agency.native.onEvent`) for `speech-partial/final`.
   - `speech.synthesize { text, voiceId } -> { pcm: base64, sampleRate }` for call audio.
   - `speech.transcribe.start/append/stop` for transcribing a call's remote audio on-device.
   - `files.recent { kind: "pdf" }` (Downloads) and a Bridge download hand-off for Papers import.
   - `ApprovalDraft.simulated` exists in os/tasks; consider documenting that `ApprovalRequest.simulated`
     can be true on a non-dry-run task when only a simulated backend is configured.
5. **CI**: run `os/tasks` checks and `npm run e2e` (Playwright on the harness) on ubuntu.
