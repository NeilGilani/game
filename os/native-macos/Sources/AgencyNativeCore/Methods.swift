import Foundation

/// Every method in NativeMethods (os/contracts/src/native.ts). There is deliberately no method to quit apps:
/// quitting goes through the agent's approval.
public enum NativeMethodName: String, CaseIterable, Sendable {
  case permissionsStatus = "permissions.status"
  case permissionsRequest = "permissions.request"
  case axTargets = "ax.targets"
  case axPress = "ax.press"
  case inputClick = "input.click"
  case inputScroll = "input.scroll"
  case inputType = "input.type"
  case inputKey = "input.key"
  case appsList = "apps.list"
  case appsLaunch = "apps.launch"
  case appsActivate = "apps.activate"
  case appsFrontmost = "apps.frontmost"
  case screenCapture = "screen.capture"
  case speechSay = "speech.say"
  case speechVoices = "speech.voices"
  case speechListen = "speech.listen"
  case inputStopAll = "input.stopAll"
  case inputDrag = "input.drag"
  case appsHide = "apps.hide"
  /// Read-only: today's events from the Calendar app, for My day. Added in v0 (additive).
  case calendarToday = "calendar.today"

  /// Methods in os/contracts/src/native.ts as of CONTRACTS_VERSION 0 (including the additive drag, hide and calendar).
  public static let contractMethods: [NativeMethodName] = allCases

  /// Permissions that must be granted before the method can do anything.
  public var requiredPermissions: [PermissionKind] {
    switch self {
    case .axTargets, .axPress, .inputClick, .inputScroll, .inputType, .inputKey, .inputDrag: return [.accessibility]
    case .screenCapture: return [.screenRecording]
    case .speechListen: return [.microphone, .speechRecognition]
    default: return []
    }
  }

  /// Synthetic-input methods: rate-limited and cancelled by input.stopAll.
  public var isSyntheticInput: Bool {
    switch self {
    case .axPress, .inputClick, .inputScroll, .inputType, .inputKey, .inputDrag: return true
    default: return false
    }
  }
}

public enum PermissionKind: String, CaseIterable, Sendable {
  case accessibility
  case screenRecording = "screen-recording"
  case camera
  case microphone
  case speechRecognition = "speech-recognition"

  public var settingsPane: String {
    switch self {
    case .accessibility: return "Accessibility"
    case .screenRecording: return "Screen & System Audio Recording"
    case .camera: return "Camera"
    case .microphone: return "Microphone"
    case .speechRecognition: return "Speech Recognition"
    }
  }

  public var purpose: String {
    switch self {
    case .accessibility: return "to see and press buttons in other apps"
    case .screenRecording: return "to look at the screen during a task you started"
    case .camera: return "to follow your eyes"
    case .microphone: return "to hear the other person on a call"
    case .speechRecognition: return "to turn speech on a call into text"
    }
  }

  /// Plain-language message naming the exact System Settings pane.
  public var missingMessage: String {
    "AGENCY needs \(settingsPane) permission \(purpose). A helper can turn it on in System Settings > "
      + "Privacy & Security > \(settingsPane), next to AGENCY."
  }
}

public enum PermissionState: String, Sendable {
  case granted
  case denied
  case notDetermined = "not-determined"
}

public enum PermissionStatusJSON {
  /// PermissionStatus: a record with every PermissionKind.
  public static func encode(_ status: [PermissionKind: PermissionState]) -> JSONValue {
    var o: [String: JSONValue] = [:]
    for kind in PermissionKind.allCases { o[kind.rawValue] = .string((status[kind] ?? .notDetermined).rawValue) }
    return .object(o)
  }

  /// The first required permission that isn't granted, if any.
  public static func firstMissing(
    _ required: [PermissionKind], in status: [PermissionKind: PermissionState]
  ) -> PermissionKind? {
    required.first { status[$0] != .granted }
  }
}
