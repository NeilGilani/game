import AVFoundation
import AgencyNativeCore
import Speech

/// Talk (text to speech, including Personal Voice) and on-device speech recognition for calls.
/// Transcripts are emitted as events and never logged.
final class SpeechService: NSObject, @unchecked Sendable {
  private let emit: (JSONValue) -> Void
  private let synth = AVSpeechSynthesizer()

  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var listening = false
  private var locale: Locale = .current
  private var quickFailures = 0
  private var startedAt = Date()

  init(emit: @escaping (JSONValue) -> Void) {
    self.emit = emit
    super.init()
  }

  // MARK: Talk

  func say(text: String, voiceId: String?, rate: Double?) throws {
    var voice: AVSpeechSynthesisVoice? = nil
    if let voiceId {
      guard let v = AVSpeechSynthesisVoice(identifier: voiceId) else {
        throw RPCError.invalidParams("that voice isn't installed")
      }
      voice = v
    }
    let utterance = AVSpeechUtterance(string: text)
    if let voice { utterance.voice = voice }
    utterance.rate = Float(SpeechRateMap.utteranceRate(
      multiplier: rate, defaultRate: Double(AVSpeechUtteranceDefaultSpeechRate),
      minRate: Double(AVSpeechUtteranceMinimumSpeechRate), maxRate: Double(AVSpeechUtteranceMaximumSpeechRate)))
    DispatchQueue.main.async { self.synth.speak(utterance) }
  }

  func stopSpeaking() {
    DispatchQueue.main.async { self.synth.stopSpeaking(at: .immediate) }
  }

  /// Lists voices. On macOS 14+, the first call asks for Personal Voice access (Talk's voice picker is where the
  /// person expects that question); afterwards their Personal Voice appears with personal: true.
  func voices(completion: @escaping ([VoiceRecord]) -> Void) {
    let list: () -> Void = {
      let voices = AVSpeechSynthesisVoice.speechVoices().map { v -> VoiceRecord in
        var personal = false
        if #available(macOS 14.0, *) { personal = v.voiceTraits.contains(.isPersonalVoice) }
        return VoiceRecord(id: v.identifier, name: v.name, personal: personal)
      }
      completion(voices.sorted { ($0.personal ? 0 : 1, $0.name) < ($1.personal ? 0 : 1, $1.name) })
    }
    if #available(macOS 14.0, *), AVSpeechSynthesizer.personalVoiceAuthorizationStatus == .notDetermined {
      AVSpeechSynthesizer.requestPersonalVoiceAuthorization { _ in list() }
    } else {
      list()
    }
  }

  // MARK: Listening (calls)

  func listen(on: Bool, locale: String?) throws {
    if !on {
      DispatchQueue.main.async { self.stopListening() }
      return
    }
    let loc = locale.map(Locale.init(identifier:)) ?? .current
    guard let recognizer = SFSpeechRecognizer(locale: loc) else {
      throw RPCError.unsupported("Speech recognition isn't available for this language.")
    }
    guard recognizer.supportsOnDeviceRecognition else {
      throw RPCError.unsupported(
        "This Mac can't recognise this language on-device, and AGENCY never sends call audio to a server.")
    }
    var startError: Error?
    DispatchQueue.main.sync {
      self.locale = loc
      self.listening = true
      self.quickFailures = 0
      do { try self.startTask() } catch { startError = error; self.stopListening() }
    }
    if let startError { throw RPCError.internalError("couldn't start listening: \(startError.localizedDescription)") }
  }

  /// Main thread.
  private func startTask() throws {
    teardown()
    guard let recognizer = SFSpeechRecognizer(locale: locale) else { return }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.requiresOnDeviceRecognition = true
    req.shouldReportPartialResults = true
    request = req
    let input = engine.inputNode
    input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
      req.append(buffer)
    }
    engine.prepare()
    try engine.start()
    startedAt = Date()
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      guard let self else { return }
      if let result {
        let text = result.bestTranscription.formattedString
        self.emit(["type": result.isFinal ? "speech-final" : "speech-partial", "text": .string(text)])
      }
      if result?.isFinal == true || error != nil {
        DispatchQueue.main.async { self.restartIfListening(failed: error != nil) }
      }
    }
  }

  /// Recognition tasks end after a pause or about a minute; keep going while the call lasts, but give up
  /// after repeated immediate failures instead of spinning.
  private func restartIfListening(failed: Bool) {
    guard listening else { return }
    if failed && Date().timeIntervalSince(startedAt) < 1 { quickFailures += 1 } else { quickFailures = 0 }
    if quickFailures >= 3 {
      Log.info("speech recognition keeps failing; stopped listening")
      stopListening()
      return
    }
    do { try startTask() } catch {
      Log.info("couldn't restart listening")
      stopListening()
    }
  }

  private func teardown() {
    task?.cancel()
    task = nil
    request?.endAudio()
    request = nil
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
  }

  private func stopListening() {
    listening = false
    teardown()
  }
}
