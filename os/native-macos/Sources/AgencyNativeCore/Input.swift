import Foundation

/// Token bucket for synthetic events. Gaze dwell needs about one action a second; anything much faster is a
/// bug or a runaway agent, and the person can't physically intervene, so we refuse rather than queue.
public final class RateLimiter: @unchecked Sendable {
  public let capacity: Double
  public let refillPerSecond: Double
  private var tokens: Double
  private var last: Double
  private let now: () -> Double
  private let lock = NSLock()

  public init(capacity: Double = 10, refillPerSecond: Double = 8, now: @escaping () -> Double = Clock.seconds) {
    self.capacity = capacity
    self.refillPerSecond = refillPerSecond
    self.tokens = capacity
    self.now = now
    self.last = now()
  }

  public func tryTake(_ cost: Double = 1) -> Bool {
    lock.lock(); defer { lock.unlock() }
    let t = now()
    tokens = min(capacity, tokens + max(0, t - last) * refillPerSecond)
    last = t
    guard tokens >= cost else { return false }
    tokens -= cost
    return true
  }
}

public enum Clock {
  public static func seconds() -> Double { ProcessInfo.processInfo.systemUptime }
  public static func epochMs() -> Double { Date().timeIntervalSince1970 * 1000 }
}

/// The kill switch. Every synthetic action takes a ticket; input.stopAll bumps the generation so every
/// ticket issued before it is cancelled, including actions already queued or half-way through typing.
public final class InputGate: @unchecked Sendable {
  private var generation: UInt64 = 0
  private let lock = NSLock()

  public init() {}

  public func ticket() -> UInt64 {
    lock.lock(); defer { lock.unlock() }
    return generation
  }

  public func isCancelled(_ ticket: UInt64) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return ticket != generation
  }

  public func stopAll() {
    lock.lock(); generation &+= 1; lock.unlock()
  }

  public var currentGeneration: UInt64 { ticket() }
}

public enum Modifier: String, CaseIterable, Sendable {
  case cmd, ctrl, alt, shift, fn

  /// CGEventFlags raw values.
  public var flag: UInt64 {
    switch self {
    case .shift: return 0x0002_0000
    case .ctrl: return 0x0004_0000
    case .alt: return 0x0008_0000
    case .cmd: return 0x0010_0000
    case .fn: return 0x0080_0000
    }
  }

  public static func flags(_ mods: [Modifier]) -> UInt64 { mods.reduce(0) { $0 | $1.flag } }

  public static func parse(_ names: [String]) throws -> [Modifier] {
    try names.map { name in
      let n = name.lowercased()
      let alias: [String: Modifier] = ["command": .cmd, "control": .ctrl, "option": .alt, "opt": .alt]
      guard let m = Modifier(rawValue: n) ?? alias[n] else { throw RPCError.invalidParams("unknown modifier \"\(name)\"") }
      return m
    }
  }
}

/// macOS virtual key codes (ANSI layout) by name.
public enum KeyCodes {
  public static let table: [String: UInt16] = {
    var t: [String: UInt16] = [
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
      "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
      "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
      "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
      "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "forwarddelete": 117,
      "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
      "left": 123, "right": 124, "down": 125, "up": 126,
      "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
      "f10": 109, "f11": 103, "f12": 111,
    ]
    let aliases: [String: String] = [
      "enter": "return", "esc": "escape", "backspace": "delete", "del": "forwarddelete", "arrowleft": "left",
      "arrowright": "right", "arrowup": "up", "arrowdown": "down", "minus": "-", "equal": "=", "comma": ",",
      "period": ".", "slash": "/", " ": "space",
    ]
    for (a, b) in aliases { t[a] = t[b] }
    return t
  }()

  public static func code(for key: String) -> UInt16? {
    let k = key.count == 1 ? key.lowercased() : key.lowercased().replacingOccurrences(of: "_", with: "")
    return table[k]
  }
}

/// Key combos the helper refuses outright: they quit, log out, lock the Mac or delete, which the person can't
/// easily undo. Quitting and deleting go through the agent's approval instead.
public enum KeyPolicy {
  struct Rule {
    let key: String
    let mods: Set<Modifier>
    let reason: String
  }

  static let rules: [Rule] = [
    Rule(key: "q", mods: [.cmd], reason: "Quitting an app needs your approval, so AGENCY won't press Command-Q."),
    Rule(key: "q", mods: [.cmd, .shift], reason: "AGENCY won't log you out with a key press."),
    Rule(key: "q", mods: [.cmd, .alt, .shift], reason: "AGENCY won't log you out with a key press."),
    Rule(key: "q", mods: [.cmd, .ctrl], reason: "AGENCY won't lock the screen: you might not be able to unlock it."),
    Rule(key: "escape", mods: [.cmd, .alt], reason: "Force quitting apps needs your approval."),
    Rule(key: "delete", mods: [.cmd], reason: "Deleting needs your approval, so AGENCY won't press Command-Delete."),
    Rule(key: "delete", mods: [.cmd, .shift], reason: "Emptying the Trash needs your approval."),
    Rule(key: "delete", mods: [.cmd, .alt], reason: "Deleting needs your approval."),
    Rule(key: "delete", mods: [.cmd, .alt, .shift], reason: "Emptying the Trash needs your approval."),
  ]

  /// A plain-language reason if the combo is refused, else nil.
  public static func refusal(key: String, modifiers: [Modifier]) -> String? {
    guard let code = KeyCodes.code(for: key) else { return nil }
    let mods = Set(modifiers.filter { $0 != .fn })
    return rules.first { KeyCodes.code(for: $0.key) == code && $0.mods == mods }?.reason
  }
}

public enum TypingStep: Equatable, Sendable {
  case text(String)
  case key(String)
}

/// Splits text into CGEvent-sized pieces: unicode strings of at most 20 UTF-16 units (the documented limit of
/// CGEventKeyboardSetUnicodeString), never splitting a character, with newlines and tabs as real key presses.
public enum TypingPlan {
  public static let maxUnits = 20
  public static let maxCharacters = 2000

  public static func steps(for text: String) throws -> [TypingStep] {
    guard text.count <= maxCharacters else {
      throw RPCError.invalidParams("text is longer than \(maxCharacters) characters; send it in parts")
    }
    var steps: [TypingStep] = []
    var chunk = ""
    var units = 0
    func flush() {
      if !chunk.isEmpty { steps.append(.text(chunk)) }
      chunk = ""
      units = 0
    }
    for ch in text {
      if ch == "\n" || ch == "\r\n" || ch == "\r" {
        flush(); steps.append(.key("return")); continue
      }
      if ch == "\t" { flush(); steps.append(.key("tab")); continue }
      let n = ch.utf16.count
      if units + n > maxUnits { flush() }
      chunk.append(ch)
      units += n
      if units >= maxUnits { flush() }
    }
    flush()
    return steps
  }
}

/// Whether text may be typed into the focused element. Password fields are refused; so is an unknown focus,
/// because then we can't tell where the text would go.
public enum SecureFieldPolicy {
  public enum Decision: Equatable {
    case allow
    case refuse(String)
  }

  public static func decide(focusedRole: String?, focusedSubrole: String?) -> Decision {
    guard let role = focusedRole else {
      return .refuse("AGENCY can't tell where the text would go, so it didn't type anything. Look at a text field first.")
    }
    if RoleMapper.isSecure(role: role, subrole: focusedSubrole) {
      return .refuse("This is a password field. AGENCY never types passwords; ask your helper to enter it.")
    }
    return .allow
  }
}

/// Screen capture sizing: never upscale, keep the aspect ratio, cap the width.
public enum CaptureMath {
  public static let defaultMaxWidth = 1280
  public static let minWidth = 64
  public static let maxWidth = 3840

  public static func outputSize(pointsWidth: Double, pointsHeight: Double, pixelScale: Double, maxWidth: Int?)
    -> (width: Int, height: Int, scale: Double)
  {
    let limit = Double(min(Self.maxWidth, max(minWidth, maxWidth ?? defaultMaxWidth)))
    let nativeWidth = max(1, pointsWidth * max(1, pixelScale))
    let w = min(limit, nativeWidth).rounded(.down)
    let h = max(1, (w * pointsHeight / max(1, pointsWidth)).rounded())
    // scale: output pixels per screen point. A pixel (px, py) is at point (px / scale, py / scale) + display origin.
    return (Int(w), Int(h), w / max(1, pointsWidth))
  }
}

/// Speech rate: the contract's rate is a multiplier of normal speed (1 = normal), clamped to 0.5...2.
public enum SpeechRateMap {
  public static func utteranceRate(multiplier: Double?, defaultRate: Double, minRate: Double, maxRate: Double) -> Double {
    let m = min(2, max(0.5, multiplier ?? 1))
    return min(maxRate, max(minRate, defaultRate * m))
  }
}
