import Testing
@testable import AgencyNativeCore

@Suite struct RateLimiterTests {
  final class FakeClock: @unchecked Sendable { var t = 0.0 }

  @Test func allowsBurstThenRefills() {
    let clock = FakeClock()
    let rl = RateLimiter(capacity: 3, refillPerSecond: 2, now: { clock.t })
    #expect(rl.tryTake() && rl.tryTake() && rl.tryTake())
    #expect(!rl.tryTake())
    clock.t = 0.5
    #expect(rl.tryTake())
    #expect(!rl.tryTake())
    clock.t = 100
    #expect(rl.tryTake() && rl.tryTake() && rl.tryTake())
    #expect(!rl.tryTake())
  }
}

@Suite struct InputGateTests {
  @Test func stopAllCancelsEarlierTicketsOnly() {
    let gate = InputGate()
    let a = gate.ticket()
    #expect(!gate.isCancelled(a))
    gate.stopAll()
    #expect(gate.isCancelled(a))
    let b = gate.ticket()
    #expect(!gate.isCancelled(b))
  }
}

@Suite struct KeyTests {
  @Test func namesAndAliases() {
    #expect(KeyCodes.code(for: "a") == 0)
    #expect(KeyCodes.code(for: "A") == 0)
    #expect(KeyCodes.code(for: "Return") == 36)
    #expect(KeyCodes.code(for: "enter") == 36)
    #expect(KeyCodes.code(for: "Escape") == 53)
    #expect(KeyCodes.code(for: "esc") == 53)
    #expect(KeyCodes.code(for: "backspace") == 51)
    #expect(KeyCodes.code(for: "ArrowLeft") == 123)
    #expect(KeyCodes.code(for: "page_down") == 121)
    #expect(KeyCodes.code(for: "f12") == 111)
    #expect(KeyCodes.code(for: "space") == 49)
    #expect(KeyCodes.code(for: "nonsense") == nil)
  }

  @Test func everyLetterAndDigitHasACode() {
    for c in "abcdefghijklmnopqrstuvwxyz0123456789" { #expect(KeyCodes.code(for: String(c)) != nil, "\(c)") }
    let codes = "abcdefghijklmnopqrstuvwxyz0123456789".map { KeyCodes.code(for: String($0))! }
    #expect(Set(codes).count == codes.count)
  }

  @Test func modifierFlags() throws {
    #expect(Modifier.flags([.cmd, .shift]) == 0x0012_0000)
    #expect(try Modifier.parse(["cmd", "Option", "control"]) == [.cmd, .alt, .ctrl])
    #expect(throws: RPCError.self) { try Modifier.parse(["hyper"]) }
  }

  @Test func refusesQuitLockAndDeleteCombos() {
    #expect(KeyPolicy.refusal(key: "q", modifiers: [.cmd]) != nil)
    #expect(KeyPolicy.refusal(key: "Q", modifiers: [.cmd]) != nil)
    #expect(KeyPolicy.refusal(key: "q", modifiers: [.ctrl, .cmd]) != nil)
    #expect(KeyPolicy.refusal(key: "q", modifiers: [.cmd, .shift]) != nil)
    #expect(KeyPolicy.refusal(key: "esc", modifiers: [.cmd, .alt]) != nil)
    #expect(KeyPolicy.refusal(key: "backspace", modifiers: [.cmd]) != nil)
    #expect(KeyPolicy.refusal(key: "delete", modifiers: [.cmd, .shift]) != nil)
  }

  @Test func allowsOrdinaryCombos() {
    #expect(KeyPolicy.refusal(key: "q", modifiers: []) == nil)
    #expect(KeyPolicy.refusal(key: "c", modifiers: [.cmd]) == nil)
    #expect(KeyPolicy.refusal(key: "tab", modifiers: [.cmd]) == nil)
    #expect(KeyPolicy.refusal(key: "delete", modifiers: []) == nil)
    #expect(KeyPolicy.refusal(key: "z", modifiers: [.cmd]) == nil)
  }
}

@Suite struct TypingPlanTests {
  @Test func shortTextIsOneChunk() throws {
    #expect(try TypingPlan.steps(for: "hello") == [.text("hello")])
    #expect(try TypingPlan.steps(for: "") == [])
  }

  @Test func chunksAtTwentyUnits() throws {
    let steps = try TypingPlan.steps(for: String(repeating: "a", count: 45))
    #expect(steps == [.text(String(repeating: "a", count: 20)), .text(String(repeating: "a", count: 20)), .text("aaaaa")])
  }

  @Test func neverSplitsSurrogatePairsOrClusters() throws {
    // 19 ASCII + one emoji (2 UTF-16 units) would be 21: the emoji must move to the next chunk whole.
    let text = String(repeating: "a", count: 19) + "😀" + "b"
    let steps = try TypingPlan.steps(for: text)
    #expect(steps == [.text(String(repeating: "a", count: 19)), .text("😀b")])
    let family = "👨‍👩‍👧‍👦" // one grapheme, 11 UTF-16 units
    let s2 = try TypingPlan.steps(for: String(repeating: family, count: 3))
    for case .text(let chunk) in s2 { #expect(chunk.utf16.count <= TypingPlan.maxUnits) }
    #expect(s2.compactMap { if case .text(let c) = $0 { return c }; return nil }.joined() == String(repeating: family, count: 3))
  }

  @Test func newlinesAndTabsArePressed() throws {
    #expect(try TypingPlan.steps(for: "a\nb\r\nc\td") == [.text("a"), .key("return"), .text("b"), .key("return"), .text("c"), .key("tab"), .text("d")])
  }

  @Test func rejectsVeryLongText() {
    #expect(throws: RPCError.self) { try TypingPlan.steps(for: String(repeating: "x", count: 2001)) }
  }
}

@Suite struct SecureFieldPolicyTests {
  @Test func refusesPasswordFieldsAndUnknownFocus() {
    #expect(SecureFieldPolicy.decide(focusedRole: "AXSecureTextField", focusedSubrole: nil) != .allow)
    #expect(SecureFieldPolicy.decide(focusedRole: "AXTextField", focusedSubrole: "AXSecureTextField") != .allow)
    #expect(SecureFieldPolicy.decide(focusedRole: nil, focusedSubrole: nil) != .allow)
    #expect(SecureFieldPolicy.decide(focusedRole: "AXTextField", focusedSubrole: nil) == .allow)
    #expect(SecureFieldPolicy.decide(focusedRole: "AXTextArea", focusedSubrole: nil) == .allow)
  }
}

@Suite struct CaptureMathTests {
  @Test func downscalesKeepingAspect() {
    let s = CaptureMath.outputSize(pointsWidth: 1440, pointsHeight: 900, pixelScale: 2, maxWidth: nil)
    #expect(s.width == 1280 && s.height == 800)
    #expect(abs(s.scale - 1280.0 / 1440.0) < 1e-9)
  }

  @Test func neverUpscales() {
    let s = CaptureMath.outputSize(pointsWidth: 800, pointsHeight: 600, pixelScale: 1, maxWidth: 3000)
    #expect(s.width == 800 && s.height == 600 && s.scale == 1)
  }

  @Test func clampsRequestedWidth() {
    #expect(CaptureMath.outputSize(pointsWidth: 1440, pointsHeight: 900, pixelScale: 2, maxWidth: 10).width == 64)
    #expect(CaptureMath.outputSize(pointsWidth: 5120, pointsHeight: 2880, pixelScale: 2, maxWidth: 99_999).width == 3840)
  }
}

@Suite struct SpeechRateTests {
  @Test func mapsMultiplier() {
    #expect(SpeechRateMap.utteranceRate(multiplier: nil, defaultRate: 0.5, minRate: 0, maxRate: 1) == 0.5)
    #expect(SpeechRateMap.utteranceRate(multiplier: 1.5, defaultRate: 0.5, minRate: 0, maxRate: 1) == 0.75)
    #expect(SpeechRateMap.utteranceRate(multiplier: 10, defaultRate: 0.5, minRate: 0, maxRate: 1) == 1)
    #expect(SpeechRateMap.utteranceRate(multiplier: 0.1, defaultRate: 0.5, minRate: 0, maxRate: 1) == 0.25)
  }
}

@Suite struct AppCatalogTests {
  @Test func mergesSortsAndMarksFrontmost() {
    let installed = [
      AppRecord(bundleId: "com.b", name: "beta", path: "/Applications/beta.app"),
      AppRecord(bundleId: "com.a", name: "Alpha", path: "/Applications/Alpha.app"),
      AppRecord(bundleId: "", name: "Broken", path: "/x.app"),
    ]
    let running = [
      AppRecord(bundleId: "com.a", name: "Alpha", path: "/Applications/Alpha.app"),
      AppRecord(bundleId: "com.c", name: "Custom", path: "/Users/me/Custom.app"),
    ]
    let apps = AppCatalog.merge(installed: installed, running: running, frontmostBundleId: "com.c")
    #expect(apps.map(\.bundleId) == ["com.a", "com.b", "com.c"])
    #expect(apps.map(\.running) == [true, false, true])
    #expect(apps.map(\.frontmost) == [false, false, true])
  }

  @Test func displayName() {
    #expect(AppCatalog.displayName(forPath: "/Applications/Google Chrome.app") == "Google Chrome")
  }

  @Test func encodesAppInfo() {
    let a = AppRecord(bundleId: "com.a", name: "A", path: "/A.app", running: true, frontmost: false)
    #expect(a.json == ["bundleId": "com.a", "name": "A", "path": "/A.app", "running": true, "frontmost": false])
  }
}

@Suite struct MethodTableTests {
  @Test func coversTheContract() {
    let names = Set(NativeMethodName.contractMethods.map(\.rawValue))
    #expect(names == [
      "permissions.status", "permissions.request", "ax.targets", "ax.press", "input.click", "input.scroll",
      "input.type", "input.key", "apps.list", "apps.launch", "apps.activate", "apps.frontmost", "screen.capture",
      "speech.say", "speech.voices", "speech.listen", "input.stopAll", "input.drag", "apps.hide",
    ])
    #expect(!NativeMethodName.allCases.map(\.rawValue).contains { $0.contains("quit") })
  }

  @Test func stopAllNeedsNothing() {
    #expect(NativeMethodName.inputStopAll.requiredPermissions.isEmpty)
    #expect(!NativeMethodName.inputStopAll.isSyntheticInput)
  }

  @Test func permissionStatusHasEveryKind() {
    let json = PermissionStatusJSON.encode([.accessibility: .granted])
    #expect(json == ["accessibility": "granted", "screen-recording": "not-determined", "camera": "not-determined",
                     "microphone": "not-determined", "speech-recognition": "not-determined"])
  }
}
