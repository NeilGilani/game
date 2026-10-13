import AVFoundation
import AgencyNativeCore
import AppKit
import ApplicationServices
import Speech

/// The macOS implementation of NativePlatform. Each area lives in its own file.
final class MacPlatform: NativePlatform, @unchecked Sendable {
  let emit: (JSONValue) -> Void
  let ax: AXTargets
  let input = SyntheticInput()
  let apps = AppsService()
  let speech: SpeechService
  let calendar = CalendarService()
  private var lastPermissions: [PermissionKind: PermissionState] = [:]
  private var permissionTimer: Timer?

  init(emit: @escaping (JSONValue) -> Void) {
    self.emit = emit
    ax = AXTargets(emit: emit)
    speech = SpeechService(emit: emit)
  }

  /// Main thread: start watching the frontmost app and permissions.
  func start() {
    let center = NSWorkspace.shared.notificationCenter
    center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
      self?.frontmostChanged()
    }
    frontmostChanged()
    lastPermissions = permissionStatus()
    permissionTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.pollPermissions() }
  }

  private func frontmostChanged() {
    let front = NSWorkspace.shared.frontmostApplication
    ax.observe(app: front)
    emit(["type": "frontmost-changed", "app": front.map { apps.record(for: $0, frontmost: true).json } ?? .null])
    emit(["type": "targets-changed", "owner": front?.bundleIdentifier.map(JSONValue.string) ?? .null])
  }

  private func pollPermissions() {
    let now = permissionStatus()
    if now != lastPermissions {
      let gainedAX = now[.accessibility] == .granted && lastPermissions[.accessibility] != .granted
      lastPermissions = now
      emit(["type": "permission-changed", "status": PermissionStatusJSON.encode(now)])
      if gainedAX { ax.observe(app: NSWorkspace.shared.frontmostApplication) }
    }
  }

  // MARK: Permissions

  func permissionStatus() -> [PermissionKind: PermissionState] {
    Dictionary(uniqueKeysWithValues: PermissionKind.allCases.map { ($0, permissionState($0)) })
  }

  func permissionState(_ kind: PermissionKind) -> PermissionState {
    switch kind {
    case .accessibility: return AXIsProcessTrusted() ? .granted : .denied
    case .screenRecording: return CGPreflightScreenCaptureAccess() ? .granted : .denied
    case .camera: return Self.av(.video)
    case .microphone: return Self.av(.audio)
    case .speechRecognition: return Self.speechState()
    }
  }

  static func av(_ type: AVMediaType) -> PermissionState {
    switch AVCaptureDevice.authorizationStatus(for: type) {
    case .authorized: return .granted
    case .notDetermined: return .notDetermined
    default: return .denied
    }
  }

  static func speechState() -> PermissionState {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return .granted
    case .notDetermined: return .notDetermined
    default: return .denied
    }
  }

  func requestPermission(_ kind: PermissionKind, completion: @escaping ([PermissionKind: PermissionState]) -> Void) {
    let done: () -> Void = { [weak self] in
      DispatchQueue.main.async { completion(self?.permissionStatus() ?? [:]) }
    }
    switch kind {
    case .accessibility:
      let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
      _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
      done()
    case .screenRecording:
      _ = CGRequestScreenCaptureAccess()
      done()
    case .camera: AVCaptureDevice.requestAccess(for: .video) { _ in done() }
    case .microphone: AVCaptureDevice.requestAccess(for: .audio) { _ in done() }
    case .speechRecognition: SFSpeechRecognizer.requestAuthorization { _ in done() }
    }
  }

  // MARK: Accessibility targets and actions

  func targets(maxCount: Int, includeWeb: Bool) throws -> NativeSnapshot {
    ax.snapshot(maxCount: maxCount, includeWeb: includeWeb)
  }

  func press(targetId: String) throws { try ax.press(targetId: targetId) }

  func focusedElementRoles() -> (role: String?, subrole: String?) { ax.focusedRoles() }

  // MARK: Synthetic input

  func click(x: Double, y: Double, button: MouseButton, count: Int) throws {
    try input.click(at: CGPoint(x: x, y: y), button: button, count: count)
  }

  func scroll(x: Double, y: Double, dx: Double, dy: Double) throws {
    try input.scroll(at: CGPoint(x: x, y: y), dx: dx, dy: dy)
  }

  func drag(from: (x: Double, y: Double), to: (x: Double, y: Double)) throws {
    try input.drag(from: CGPoint(x: from.x, y: from.y), to: CGPoint(x: to.x, y: to.y))
  }

  func typeText(_ chunk: String) throws { try input.type(chunk) }

  func pressKey(code: UInt16, flags: UInt64) throws { try input.key(code: code, flags: flags) }

  // MARK: Apps

  func listApps(includeIcons: Bool) -> [AppRecord] { apps.list(includeIcons: includeIcons) }
  func launch(bundleId: String, completion: @escaping (Result<Void, RPCError>) -> Void) { apps.launch(bundleId, completion) }
  func activate(bundleId: String) -> Bool { apps.activate(bundleId) }
  func hide(bundleId: String) -> Bool { apps.hide(bundleId) }
  func frontmost() -> AppRecord? {
    NSWorkspace.shared.frontmostApplication.map { apps.record(for: $0, frontmost: true) }
  }

  // MARK: Screen capture

  func capture(displayId: Int?, maxWidth: Int?, format: String, completion: @escaping (Result<CaptureResult, RPCError>) -> Void) {
    ScreenCapture.capture(displayId: displayId, maxWidth: maxWidth, format: format, completion: completion)
  }

  // MARK: Speech

  func say(text: String, voiceId: String?, rate: Double?) throws { try speech.say(text: text, voiceId: voiceId, rate: rate) }
  func voices(completion: @escaping ([VoiceRecord]) -> Void) { speech.voices(completion: completion) }
  func listen(on: Bool, locale: String?) throws { try speech.listen(on: on, locale: locale) }
  func calendarToday(completion: @escaping (Result<[CalendarEventRecord], CalendarProblem>) -> Void) {
    calendar.today(completion: completion)
  }

  func stopAll() {
    speech.stopSpeaking()
    input.releaseAll()
  }
}
