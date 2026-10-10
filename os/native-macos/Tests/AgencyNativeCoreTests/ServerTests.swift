import Foundation
import Testing
@testable import AgencyNativeCore

/// In-memory platform recording every call.
final class FakePlatform: NativePlatform, @unchecked Sendable {
  var permissions: [PermissionKind: PermissionState] = Dictionary(uniqueKeysWithValues: PermissionKind.allCases.map { ($0, .granted) })
  var focus: (role: String?, subrole: String?) = ("AXTextField", nil)
  var pressable: Set<String> = ["ax-1"]
  private let lock = NSLock()
  private var _log: [String] = []
  var log: [String] { lock.lock(); defer { lock.unlock() }; return _log }
  var typeDelay: TimeInterval = 0
  /// Called after each typed chunk (to move focus mid-typing, for example).
  var afterType: ((FakePlatform) -> Void)?

  func record(_ s: String) { lock.lock(); _log.append(s); lock.unlock() }

  func permissionStatus() -> [PermissionKind: PermissionState] { permissions }
  func requestPermission(_ kind: PermissionKind, completion: @escaping ([PermissionKind: PermissionState]) -> Void) {
    record("request \(kind.rawValue)"); permissions[kind] = .granted; completion(permissions)
  }
  func targets(maxCount: Int, includeWeb: Bool) throws -> NativeSnapshot {
    record("targets \(maxCount) \(includeWeb)")
    return NativeSnapshot(t: 1, owner: "com.example", targets: [
      NativeTarget(id: "ax-1", rect: Rect(x: 0, y: 0, width: 100, height: 100), role: "button", label: "OK", owner: "com.example", secure: false),
    ], truncated: false)
  }
  func press(targetId: String) throws {
    guard pressable.contains(targetId) else { throw RPCError.notFound("gone") }
    record("press \(targetId)")
  }
  func click(x: Double, y: Double, button: MouseButton, count: Int) throws { record("click \(Int(x)),\(Int(y)) \(button.rawValue) \(count)") }
  func scroll(x: Double, y: Double, dx: Double, dy: Double) throws { record("scroll \(Int(dx)),\(Int(dy))") }
  func drag(from: (x: Double, y: Double), to: (x: Double, y: Double)) throws {
    record("drag \(Int(from.x)),\(Int(from.y)) -> \(Int(to.x)),\(Int(to.y))")
  }
  func focusedElementRoles() -> (role: String?, subrole: String?) { focus }
  func typeText(_ chunk: String) throws {
    record("type \(chunk)")
    if typeDelay > 0 { Thread.sleep(forTimeInterval: typeDelay) }
    afterType?(self)
  }
  func pressKey(code: UInt16, flags: UInt64) throws { record("key \(code) \(flags)") }
  func listApps(includeIcons: Bool) -> [AppRecord] { [AppRecord(bundleId: "com.a", name: "A", path: "/A.app")] }
  func launch(bundleId: String, completion: @escaping (Result<Void, RPCError>) -> Void) {
    completion(bundleId == "com.a" ? .success(()) : .failure(.notFound("That app isn't installed on this Mac.")))
  }
  func activate(bundleId: String) -> Bool { bundleId == "com.a" }
  func hide(bundleId: String) -> Bool { bundleId == "com.a" }
  func frontmost() -> AppRecord? { nil }
  func capture(displayId: Int?, maxWidth: Int?, format: String, completion: @escaping (Result<CaptureResult, RPCError>) -> Void) {
    completion(.success(CaptureResult(data: "AAAA", width: 10, height: 5, scale: 0.5, format: format)))
  }
  func say(text: String, voiceId: String?, rate: Double?) throws { record("say") }
  func voices(completion: @escaping ([VoiceRecord]) -> Void) { completion([VoiceRecord(id: "v1", name: "Me", personal: true)]) }
  func listen(on: Bool, locale: String?) throws { record("listen \(on)") }
  func stopAll() { record("stopAll") }
}

struct Harness {
  let platform = FakePlatform()
  let server: NativeServer

  init(limiter: RateLimiter = RateLimiter(capacity: 1000, refillPerSecond: 1000)) {
    server = NativeServer(platform: platform, limiter: limiter)
    server.typingChunkDelay = 0
  }

  /// Sends one request and waits for its reply.
  func call(_ method: String, _ params: JSONValue = [:], id: Int = 1) -> JSONValue {
    let line = JSONValue.object(["jsonrpc": "2.0", "id": .number(Double(id)), "method": .string(method), "params": params]).serialized()
    let sem = DispatchSemaphore(value: 0)
    let box = Box()
    server.handle(line: line) { box.value = $0; sem.signal() }
    _ = sem.wait(timeout: .now() + 5)
    return (try? JSONValue.parse(box.value ?? "")) ?? .null
  }

  /// Sends a request without waiting; the reply lands in the returned box.
  func send(_ method: String, _ params: JSONValue = [:], id: Int) -> (Box, DispatchSemaphore) {
    let line = JSONValue.object(["jsonrpc": "2.0", "id": .number(Double(id)), "method": .string(method), "params": params]).serialized()
    let sem = DispatchSemaphore(value: 0)
    let box = Box()
    server.handle(line: line) { box.value = $0; sem.signal() }
    return (box, sem)
  }
}

final class Box: @unchecked Sendable {
  private let lock = NSLock()
  private var _value: String?
  var value: String? {
    get { lock.lock(); defer { lock.unlock() }; return _value }
    set { lock.lock(); _value = newValue; lock.unlock() }
  }
}

@Suite struct ServerTests {
  @Test func registersEveryContractMethodAndHide() {
    let h = Harness()
    let registered = Set(h.server.dispatcher.methods)
    for m in NativeMethodName.allCases { #expect(registered.contains(m.rawValue), "\(m.rawValue)") }
  }

  @Test func permissionsStatusAndRequest() {
    let h = Harness()
    h.platform.permissions[.camera] = .notDetermined
    #expect(h.call("permissions.status")["result"]?["camera"] == "not-determined")
    #expect(h.call("permissions.request", ["kind": "camera"])["result"]?["camera"] == "granted")
    #expect(h.call("permissions.request", ["kind": "keys"])["error"]?["code"] == -32602)
  }

  @Test func axMethodsNeedAccessibility() {
    let h = Harness()
    h.platform.permissions[.accessibility] = .denied
    for m in ["ax.targets", "ax.press", "input.click", "input.type", "input.key", "input.scroll", "input.drag"] {
      let r = h.call(m, ["targetId": "ax-1", "x": 1, "y": 1, "dx": 0, "dy": 1, "text": "a", "key": "a"])
      #expect(r["error"]?["code"] == -32001, "\(m)")
      #expect(r["error"]?["data"]?["permission"] == "accessibility")
    }
    #expect(h.platform.log.isEmpty)
    // The kill switch never depends on permissions.
    #expect(h.call("input.stopAll")["result"]?["ok"] == true)
  }

  @Test func targetsPassParams() {
    let h = Harness()
    let r = h.call("ax.targets", ["maxCount": 50, "includeWeb": false])
    #expect(r["result"]?["owner"] == "com.example")
    #expect(r["result"]?["truncated"] == false)
    #expect(h.platform.log == ["targets 50 false"])
    _ = h.call("ax.targets")
    #expect(h.platform.log.last == "targets 300 true")
    #expect(h.call("ax.targets", ["maxCount": "lots"])["error"]?["code"] == -32602)
  }

  @Test func pressReportsMissingTargetsAsNotOk() {
    let h = Harness()
    #expect(h.call("ax.press", ["targetId": "ax-1"])["result"] == ["ok": true])
    let r = h.call("ax.press", ["targetId": "ax-gone"])
    #expect(r["result"]?["ok"] == false)
    #expect(r["result"]?["error"] != nil)
  }

  @Test func clickValidation() {
    let h = Harness()
    #expect(h.call("input.click", ["x": 10, "y": 20, "button": "right", "count": 2])["result"]?["ok"] == true)
    #expect(h.platform.log == ["click 10,20 right 2"])
    #expect(h.call("input.click", ["x": 10, "y": 20, "count": 3])["error"]?["code"] == -32602)
    #expect(h.call("input.click", ["x": 10, "y": 20, "button": "middle"])["error"]?["code"] == -32602)
    #expect(h.call("input.click", ["x": "a", "y": 20])["error"]?["code"] == -32602)
  }

  @Test func dragValidation() {
    let h = Harness()
    #expect(h.call("input.drag", ["from": ["x": 1, "y": 2], "to": ["x": 30, "y": 40]])["result"] == ["ok": true])
    #expect(h.platform.log == ["drag 1,2 -> 30,40"])
    #expect(h.call("input.drag", ["from": ["x": 1], "to": ["x": 30, "y": 40]])["error"]?["code"] == -32602)
    #expect(h.call("input.drag", ["from": 5, "to": ["x": 30, "y": 40]])["error"]?["code"] == -32602)
  }

  @Test func typesIntoOrdinaryFields() {
    let h = Harness()
    #expect(h.call("input.type", ["text": "hi\nthere"])["result"] == ["ok": true])
    #expect(h.platform.log == ["type hi", "key 36 0", "type there"])
  }

  @Test func refusesPasswordFieldsWithoutTypingOrLogging() {
    let h = Harness()
    var logged: [String] = []
    let server = NativeServer(platform: h.platform, limiter: RateLimiter(capacity: 100, refillPerSecond: 100), log: { logged.append($0) })
    h.platform.focus = ("AXTextField", "AXSecureTextField")
    let line = #"{"jsonrpc":"2.0","id":1,"method":"input.type","params":{"text":"hunter2"}}"#
    let sem = DispatchSemaphore(value: 0)
    let box = Box()
    server.handle(line: line) { box.value = $0; sem.signal() }
    _ = sem.wait(timeout: .now() + 5)
    let r = try! JSONValue.parse(box.value!)
    #expect(r["result"]?["ok"] == false)
    #expect(r["result"]?["error"]?.stringValue?.contains("password") == true)
    #expect(h.platform.log.isEmpty)
    #expect(!logged.joined().contains("hunter2"))
    #expect(!box.value!.contains("hunter2"))
  }

  @Test func stopsTypingWhenFocusMovesToAPasswordField() {
    let h = Harness()
    h.platform.afterType = { p in p.focus = ("AXSecureTextField", nil) }
    let r = h.call("input.type", ["text": .string(String(repeating: "a", count: 30))])
    #expect(r["result"]?["ok"] == false)
    #expect(h.platform.log.count == 1)
  }

  @Test func refusesUnknownFocus() {
    let h = Harness()
    h.platform.focus = (nil, nil)
    #expect(h.call("input.type", ["text": "x"])["result"]?["ok"] == false)
    #expect(h.platform.log.isEmpty)
  }

  @Test func keysAndRefusedCombos() {
    let h = Harness()
    #expect(h.call("input.key", ["key": "c", "modifiers": ["cmd"]])["result"] == ["ok": true])
    #expect(h.platform.log == ["key 8 \(Modifier.cmd.flag)"])
    let r = h.call("input.key", ["key": "q", "modifiers": ["cmd"]])
    #expect(r["result"]?["ok"] == false)
    #expect(h.platform.log.count == 1)
    #expect(h.call("input.key", ["key": "nope"])["error"]?["code"] == -32602)
    #expect(h.call("input.key", ["key": "a", "modifiers": ["hyper"]])["error"]?["code"] == -32602)
  }

  @Test func rateLimitsSyntheticInput() {
    let h = Harness(limiter: RateLimiter(capacity: 2, refillPerSecond: 0.0001))
    #expect(h.call("input.click", ["x": 1, "y": 1])["result"] != nil)
    #expect(h.call("input.click", ["x": 1, "y": 1])["result"] != nil)
    #expect(h.call("input.click", ["x": 1, "y": 1])["error"]?["code"] == -32002)
    // Reads are not rate-limited, and neither is the kill switch.
    #expect(h.call("ax.targets")["result"] != nil)
    #expect(h.call("input.stopAll")["result"]?["ok"] == true)
  }

  @Test func stopAllCancelsQueuedAndInProgressInput() {
    let h = Harness()
    h.platform.typeDelay = 0.05
    // A long typing job, then two clicks queued behind it.
    let (typing, typingDone) = h.send("input.type", ["text": .string(String(repeating: "a", count: 200))], id: 1)
    let (click1, click1Done) = h.send("input.click", ["x": 1, "y": 1], id: 2)
    let (click2, click2Done) = h.send("input.click", ["x": 2, "y": 2], id: 3)
    Thread.sleep(forTimeInterval: 0.08)
    #expect(h.call("input.stopAll", id: 4)["result"]?["ok"] == true)
    for s in [typingDone, click1Done, click2Done] { _ = s.wait(timeout: .now() + 5) }
    let t = try! JSONValue.parse(typing.value!)
    #expect(t["result"]?["ok"] == false)
    #expect(try! JSONValue.parse(click1.value!)["error"]?["code"] == -32003)
    #expect(try! JSONValue.parse(click2.value!)["error"]?["code"] == -32003)
    let typed = h.platform.log.filter { $0.hasPrefix("type") }.count
    #expect(typed < 10, "typed \(typed) of 10 chunks")
    #expect(!h.platform.log.contains { $0.hasPrefix("click") })
    #expect(h.platform.log.contains("stopAll"))
    // Input works again afterwards.
    #expect(h.call("input.click", ["x": 3, "y": 3], id: 5)["result"]?["ok"] == true)
  }

  @Test func apps() {
    let h = Harness()
    #expect(h.call("apps.list")["result"]?["apps"] == [["bundleId": "com.a", "name": "A", "path": "/A.app", "running": false, "frontmost": false]])
    #expect(h.call("apps.launch", ["bundleId": "com.a"])["result"] == ["ok": true])
    #expect(h.call("apps.launch", ["bundleId": "com.zzz"])["result"]?["ok"] == false)
    #expect(h.call("apps.activate", ["bundleId": "com.a"])["result"] == ["ok": true])
    #expect(h.call("apps.hide", ["bundleId": "com.zzz"])["result"] == ["ok": false])
    #expect(h.call("apps.frontmost")["result"] == ["app": nil])
    #expect(h.call("apps.quit", ["bundleId": "com.a"])["error"]?["code"] == -32601)
  }

  @Test func capture() {
    let h = Harness()
    #expect(h.call("screen.capture", ["format": "png"])["result"] == ["data": "AAAA", "width": 10, "height": 5, "scale": 0.5, "format": "png"])
    #expect(h.call("screen.capture")["result"]?["format"] == "jpeg")
    #expect(h.call("screen.capture", ["format": "gif"])["error"]?["code"] == -32602)
    h.platform.permissions[.screenRecording] = .denied
    #expect(h.call("screen.capture")["error"]?["code"] == -32001)
  }

  @Test func speech() {
    let h = Harness()
    #expect(h.call("speech.say", ["text": "Hello"])["result"] == ["ok": true])
    #expect(h.call("speech.say", ["text": "  "])["error"]?["code"] == -32602)
    #expect(h.call("speech.voices")["result"]?["voices"] == [["id": "v1", "name": "Me", "personal": true]])
    #expect(h.call("speech.listen", ["on": true])["result"] == ["ok": true])
    h.platform.permissions[.microphone] = .denied
    let r = h.call("speech.listen", ["on": true])
    #expect(r["result"]?["ok"] == false)
    #expect(r["result"]?["error"]?.stringValue?.contains("Microphone") == true)
    // Turning listening off always works.
    #expect(h.call("speech.listen", ["on": false])["result"] == ["ok": true])
    #expect(h.call("speech.listen", [:])["error"]?["code"] == -32602)
  }
}
