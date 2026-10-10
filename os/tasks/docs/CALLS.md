# Real calls with Twilio Voice (designed, not run)

Nothing here has been run against Twilio. Placing a real call needs the owner's account and
an explicit go-ahead.

**Outgoing synthesized speech.** Voice JS SDK ≥ 2.9 lets an `AudioProcessor` replace the
microphone stream: `device.audio.addProcessor(p)` where `p.createProcessedStream(mic)`
returns a `MediaStream` from a Web Audio `MediaStreamDestination`. AGENCY feeds that
destination with PCM rendered by agency-native (AVSpeechSynthesizer `write(_:toBufferCallback:)`,
which works with Personal Voice once authorised). Browser `speechSynthesis` can't be captured, so
this needs a new native method (see INTEGRATION_REQUEST). Alternative: server-side
`<Connect><Stream>` bidirectional Media Streams, sending base64 μ-law 8 kHz `media` messages.

**Incoming transcription.** Register a second processor with `isRemote: true` to get the
remote stream, pull PCM with an AudioWorklet, and append it to an on-device
`SFSpeechAudioBufferRecognitionRequest` in agency-native.

**Rules kept in code:** approval of the exact number; emergency/short numbers refused;
disclosure spoken first; no recording (if ever enabled, announce it and get all-party consent,
since some US states and other countries require it).

Sources: twilio.com/docs/voice/sdks/javascript/twilioaudioprocessor,
twilio.com/docs/voice/media-streams/websocket-messages.
