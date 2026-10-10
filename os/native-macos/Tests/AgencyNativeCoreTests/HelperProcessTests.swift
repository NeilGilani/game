import Foundation
import Testing
@testable import AgencyNativeCore

/// Runs the real agency-native binary as a subprocess and talks JSON-RPC to it, as the Electron main process
/// will. Needs `swift build` first (scripts/test.sh does that); skipped when the binary isn't built.
enum HelperBinary {
  static let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()

  static func find(_ name: String) -> URL? {
    if name == "agency-native", let env = ProcessInfo.processInfo.environment["AGENCY_NATIVE_BIN"] {
      return URL(fileURLWithPath: env)
    }
    for dir in [".build/out/Products/Debug", ".build/debug", ".build/release", ".build/out/Products/Release"] {
      let url = packageRoot.appendingPathComponent(dir).appendingPathComponent(name)
      if FileManager.default.isExecutableFile(atPath: url.path) { return url }
    }
    return nil
  }

  static var available: Bool { find("agency-native") != nil }
  static var integration: Bool {
    ProcessInfo.processInfo.environment["AGENCY_NATIVE_INTEGRATION"] == "1" && find("AgencyTestApp") != nil
  }
}

/// A child process with line-oriented stdout.
final class LineProcess: @unchecked Sendable {
  let process = Process()
  private let stdin = Pipe()
  private let stdout = Pipe()
  private let lock = NSLock()
  private var buffer = Data()
  private var _lines: [String] = []

  init(_ url: URL) throws {
    process.executableURL = url
    process.standardInput = stdin
    process.standardOutput = stdout
    process.standardError = FileHandle.nullDevice
    stdout.fileHandleForReading.readabilityHandler = { [weak self] h in
      let data = h.availableData
      guard let self, !data.isEmpty else { return }
      self.lock.lock()
      self.buffer.append(data)
      while let nl = self.buffer.firstIndex(of: 0x0A) {
        self._lines.append(String(decoding: self.buffer[self.buffer.startIndex..<nl], as: UTF8.self))
        self.buffer.removeSubrange(self.buffer.startIndex...nl)
      }
      self.lock.unlock()
    }
    try process.run()
  }

  var lines: [String] { lock.lock(); defer { lock.unlock() }; return _lines }

  func write(_ line: String) { stdin.fileHandleForWriting.write(Data((line + "\n").utf8)) }
  func closeInput() { try? stdin.fileHandleForWriting.close() }

  func waitForLine(timeout: TimeInterval = 10, _ match: (String) -> Bool) -> String? {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let l = lines.first(where: match) { return l }
      Thread.sleep(forTimeInterval: 0.01)
    }
    return nil
  }

  deinit { if process.isRunning { process.terminate() } }
}

final class RPCClient {
  let proc: LineProcess
  private var nextId = 1
  init(_ proc: LineProcess) { self.proc = proc }

  func call(_ method: String, _ params: JSONValue = [:], timeout: TimeInterval = 10) -> JSONValue {
    let id = nextId
    nextId += 1
    proc.write(JSONValue.object(["jsonrpc": "2.0", "id": .number(Double(id)), "method": .string(method), "params": params]).serialized())
    let line = proc.waitForLine(timeout: timeout) { (try? JSONValue.parse($0))?["id"] == .number(Double(id)) }
    return line.flatMap { try? JSONValue.parse($0) } ?? .null
  }
}

@Suite(.serialized, .enabled(if: HelperBinary.available, "build agency-native first (scripts/test.sh)"))
struct HelperProcessTests {
  @Test func speaksTheProtocol() throws {
    let proc = try LineProcess(HelperBinary.find("agency-native")!)
    let rpc = RPCClient(proc)

    let status = rpc.call("permissions.status")["result"]
    for kind in PermissionKind.allCases {
      let state = status?[kind.rawValue]?.stringValue
      #expect(["granted", "denied", "not-determined"].contains(state ?? ""), "\(kind.rawValue)")
    }

    proc.write("this is not json")
    let parseError = proc.waitForLine { $0.contains("-32700") }
    #expect(parseError != nil)
    #expect((try? JSONValue.parse(parseError ?? ""))?["id"] == .null)

    #expect(rpc.call("no.such.method")["error"]?["code"] == -32601)
    #expect(rpc.call("apps.quit", ["bundleId": "com.apple.finder"])["error"]?["code"] == -32601)
    #expect(rpc.call("ax.targets", ["maxCount": "many"])["error"]?["code"] != nil)

    // Finder always runs, even though it lives outside the scanned folders.
    let apps = rpc.call("apps.list", timeout: 30)["result"]?["apps"]
    guard case .array(let list)? = apps else { Issue.record("apps.list returned no list"); return }
    #expect(list.contains { $0["bundleId"] == "com.apple.finder" && $0["running"] == true })
    #expect(list.allSatisfy { $0["iconPng"] == nil })

    // Quit combos are refused whatever the permissions (as an error without Accessibility, ok:false with it).
    let quit = rpc.call("input.key", ["key": "q", "modifiers": ["cmd"]])
    #expect(quit["result"]?["ok"] == false || quit["error"]?["code"] == -32001)

    #expect(rpc.call("input.stopAll")["result"]?["ok"] == true)
    #expect(rpc.call("speech.listen", ["on": false])["result"]?["ok"] == true)

    // Every stdout line is a JSON-RPC message: nothing else may leak onto the protocol stream.
    for line in proc.lines { #expect((try? JSONValue.parse(line))?["jsonrpc"] == "2.0", "\(line)") }

    // Closing stdin (the app quit) makes the helper exit promptly.
    proc.closeInput()
    let deadline = Date().addingTimeInterval(5)
    while proc.process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    #expect(!proc.process.isRunning)
  }

  /// Drives the test app through the accessibility tree. Opt-in: needs Accessibility permission and takes focus.
  @Test(.enabled(if: HelperBinary.integration, "set AGENCY_NATIVE_INTEGRATION=1 and grant Accessibility"))
  func pressesTestAppButtons() throws {
    let app = try LineProcess(HelperBinary.find("AgencyTestApp")!)
    defer { app.process.terminate() }
    #expect(app.waitForLine { $0 == "ready" } != nil)

    let proc = try LineProcess(HelperBinary.find("agency-native")!)
    let rpc = RPCClient(proc)
    defer { proc.closeInput() }
    guard rpc.call("permissions.status")["result"]?["accessibility"] == "granted" else {
      Issue.record("Accessibility permission is not granted to this process; can't run the integration test")
      return
    }

    // Wait for the test app to be frontmost.
    var front: JSONValue? = nil
    for _ in 0..<50 {
      front = rpc.call("apps.frontmost")["result"]?["app"]
      if front?["name"]?.stringValue?.contains("AgencyTestApp") == true { break }
      Thread.sleep(forTimeInterval: 0.1)
    }
    #expect(front?["name"]?.stringValue?.contains("AgencyTestApp") == true)

    let started = Date()
    let snapshot = rpc.call("ax.targets", ["maxCount": 200])["result"]
    let coldMs = Date().timeIntervalSince(started) * 1000
    let warmStart = Date()
    _ = rpc.call("ax.targets", ["maxCount": 200])
    let warmMs = Date().timeIntervalSince(warmStart) * 1000
    print("ax.targets on AgencyTestApp: cold \(Int(coldMs)) ms, cached \(Int(warmMs)) ms (round trip incl. JSON)")

    guard case .array(let targets)? = snapshot?["targets"] else { Issue.record("no targets"); return }
    for name in ["Alpha", "Beta", "Gamma"] {
      #expect(targets.contains { $0["label"] == .string(name) && $0["role"] == "button" }, "\(name)")
    }
    let password = targets.first { $0["secure"] == true }
    #expect(password?["role"] == "textfield")
    #expect(password?["label"] == "Password")
    #expect(targets.contains { $0["role"] == "textfield" && $0["label"] == "Message" })

    let beta = targets.first { $0["label"] == "Beta" }!
    #expect(rpc.call("ax.press", ["targetId": beta["id"]!])["result"]?["ok"] == true)
    #expect(app.waitForLine { $0 == "pressed: Beta" } != nil)

    // Focus the password field, then typing must be refused without any key events.
    #expect(rpc.call("ax.press", ["targetId": password!["id"]!])["result"]?["ok"] == true)
    Thread.sleep(forTimeInterval: 0.2)
    let typed = rpc.call("input.type", ["text": "should-never-appear"])
    print("input.type on a password field returned: \(typed.serialized())")
    #expect(typed["result"]?["ok"] == false, "\(typed.serialized())")
    #expect(typed.serialized().contains("password"))
  }
}
