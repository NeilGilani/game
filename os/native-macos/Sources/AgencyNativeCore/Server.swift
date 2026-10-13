import Foundation

public struct CaptureResult: Equatable, Sendable {
  public var data: String
  public var width: Int
  public var height: Int
  public var scale: Double
  public var format: String
  public init(data: String, width: Int, height: Int, scale: Double, format: String) {
    self.data = data
    self.width = width
    self.height = height
    self.scale = scale
    self.format = format
  }
}

public struct VoiceRecord: Equatable, Sendable {
  public var id: String
  public var name: String
  public var personal: Bool
  public init(id: String, name: String, personal: Bool) {
    self.id = id
    self.name = name
    self.personal = personal
  }
}

/// One event from the Calendar app, as My day shows it. Local wall-clock start ("14:30").
public struct CalendarEventRecord: Equatable, Sendable {
  public var title: String
  public var start: String
  public var allDay: Bool
  public var location: String
  public var calendar: String
  public init(title: String, start: String, allDay: Bool, location: String, calendar: String) {
    self.title = title
    self.start = start
    self.allDay = allDay
    self.location = location
    self.calendar = calendar
  }

  /// At most `max` characters, one line.
  static func clip(_ s: String, _ max: Int) -> String {
    let line = s.components(separatedBy: .newlines).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    return line.count > max ? String(line.prefix(max)) : line
  }

  public var json: JSONValue {
    ["title": .string(Self.clip(title, 200)), "start": .string(start), "allDay": .bool(allDay),
     "location": .string(Self.clip(location, 200)), "calendar": .string(Self.clip(calendar, 80))]
  }
}

/// Why today's events can't be read, in words a helper can act on.
public enum CalendarProblem: Error, Equatable, Sendable {
  case notAllowed
  case unavailable(String)

  public var message: String {
    switch self {
    case .notAllowed:
      return "AGENCY isn't allowed to read the Calendar. A helper can allow it in System Settings > Privacy & Security > Calendars, next to AGENCY."
    case .unavailable(let why): return why
    }
  }
}

public enum MouseButton: String, Sendable { case left, right }

/// Everything macOS-specific, behind one protocol so the server (validation, permissions, rate limiting,
/// the kill switch, refusals) is tested with a fake on any platform.
public protocol NativePlatform: AnyObject {
  func permissionStatus() -> [PermissionKind: PermissionState]
  /// One permission, cheaply: checked before every gated call, so it must not query the others.
  func permissionState(_ kind: PermissionKind) -> PermissionState
  func requestPermission(_ kind: PermissionKind, completion: @escaping ([PermissionKind: PermissionState]) -> Void)
  func targets(maxCount: Int, includeWeb: Bool) throws -> NativeSnapshot
  /// AXPress, then AXConfirm. Throws a plain-language RPCError when neither works.
  func press(targetId: String) throws
  func click(x: Double, y: Double, button: MouseButton, count: Int) throws
  /// dx/dy in points; positive dy shows content above (the CGEvent scroll-wheel convention, per native.ts).
  func scroll(x: Double, y: Double, dx: Double, dy: Double) throws
  /// Press the left button at `from`, move to `to`, release.
  func drag(from: (x: Double, y: Double), to: (x: Double, y: Double)) throws
  func focusedElementRoles() -> (role: String?, subrole: String?)
  func typeText(_ chunk: String) throws
  func pressKey(code: UInt16, flags: UInt64) throws
  func listApps(includeIcons: Bool) -> [AppRecord]
  func launch(bundleId: String, completion: @escaping (Result<Void, RPCError>) -> Void)
  func activate(bundleId: String) -> Bool
  func hide(bundleId: String) -> Bool
  func frontmost() -> AppRecord?
  func capture(displayId: Int?, maxWidth: Int?, format: String, completion: @escaping (Result<CaptureResult, RPCError>) -> Void)
  func say(text: String, voiceId: String?, rate: Double?) throws
  func voices(completion: @escaping ([VoiceRecord]) -> Void)
  func listen(on: Bool, locale: String?) throws
  /// Today's events from the Calendar app (read-only). Asks for Calendar access the first time.
  func calendarToday(completion: @escaping (Result<[CalendarEventRecord], CalendarProblem>) -> Void)
  /// Platform part of the kill switch: stop speaking, release anything held.
  func stopAll()
}

extension NativePlatform {
  public func calendarToday(completion: @escaping (Result<[CalendarEventRecord], CalendarProblem>) -> Void) {
    completion(.failure(.unavailable("Reading the Calendar isn't available here.")))
  }

  public func permissionState(_ kind: PermissionKind) -> PermissionState { permissionStatus()[kind] ?? .notDetermined }

  func firstMissing(_ required: [PermissionKind]) -> PermissionKind? {
    required.first { permissionState($0) != .granted }
  }
}

/// Registers every NativeMethods entry on a Dispatcher and enforces the helper's rules:
/// permissions first, synthetic input rate-limited and cancellable, no typing into password fields,
/// no quit/lock/delete key combos, and nothing sensitive in logs.
public final class NativeServer: @unchecked Sendable {
  public let dispatcher = Dispatcher()
  public let gate = InputGate()
  public let limiter: RateLimiter
  let platform: NativePlatform
  /// Synthetic input runs here, in order; stopAll cancels everything queued before it.
  let inputQueue = DispatchQueue(label: "org.agency.native.input")
  /// Slower reads (targets, apps, capture) run here so the reader thread stays free for stopAll.
  let workQueue = DispatchQueue(label: "org.agency.native.work")
  /// Pause between typed chunks so apps keep up; also the point where stopAll takes effect mid-typing.
  public var typingChunkDelay: TimeInterval = 0.012
  let log: (String) -> Void
  /// The kill-switch ticket of the input action running now (only touched on inputQueue).
  private var currentTicket: UInt64 = 0

  public init(platform: NativePlatform, limiter: RateLimiter = RateLimiter(), log: @escaping (String) -> Void = { _ in }) {
    self.platform = platform
    self.limiter = limiter
    self.log = log
    registerAll()
  }

  public func handle(line: String, send: @escaping (String) -> Void) {
    dispatcher.handle(line: line, send: send)
  }

  /// Wait for queued work and input to finish (used when stdin closes, so in-flight replies are written).
  public func drain() {
    workQueue.sync {}
    inputQueue.sync {}
  }

  // MARK: - Registration

  private func on(_ m: NativeMethodName, queue: DispatchQueue? = nil, _ body: @escaping (Params, @escaping Dispatcher.Reply) -> Void) {
    dispatcher.register(m.rawValue) { [weak self] params, reply in
      guard let self else { return }
      if let missing = self.platform.firstMissing(m.requiredPermissions) {
        reply(.failure(.permissionMissing(missing)))
        return
      }
      if m.isSyntheticInput {
        guard self.limiter.tryTake() else {
          self.log("rate limit: refused \(m.rawValue)")
          reply(.failure(.rateLimited))
          return
        }
        let ticket = self.gate.ticket()
        self.inputQueue.async {
          if self.gate.isCancelled(ticket) { reply(.failure(.stopped)); return }
          self.currentTicket = ticket
          self.run(body, params, reply)
        }
      } else if let queue {
        queue.async { self.run(body, params, reply) }
      } else {
        self.run(body, params, reply)
      }
    }
  }

  private func run(_ body: (Params, @escaping Dispatcher.Reply) -> Void, _ params: Params, _ reply: @escaping Dispatcher.Reply) {
    body(params, reply)
  }

  private func sync(_ m: NativeMethodName, queue: DispatchQueue? = nil, _ body: @escaping (Params) throws -> JSONValue) {
    on(m, queue: queue) { params, reply in
      do { reply(.success(try body(params))) } catch let e as RPCError { reply(.failure(e)) } catch {
        reply(.failure(.internalError(String(describing: error))))
      }
    }
  }

  private func registerAll() {
    sync(.permissionsStatus) { [unowned self] _ in PermissionStatusJSON.encode(self.platform.permissionStatus()) }

    on(.permissionsRequest) { [unowned self] params, reply in
      do {
        let raw = try params.string("kind")
        guard let kind = PermissionKind(rawValue: raw) else { throw RPCError.invalidParams("unknown permission \"\(raw)\"") }
        self.platform.requestPermission(kind) { reply(.success(PermissionStatusJSON.encode($0))) }
      } catch let e as RPCError { reply(.failure(e)) } catch { reply(.failure(.internalError("\(error)"))) }
    }

    sync(.axTargets, queue: workQueue) { [unowned self] params in
      let maxCount = TargetSelector.clampMaxCount(try params.optionalInt("maxCount"))
      let includeWeb = try params.optionalBool("includeWeb") ?? true
      return try self.platform.targets(maxCount: maxCount, includeWeb: includeWeb).json
    }

    // ax.press returns { ok, error } rather than a JSON-RPC error when the element can't be pressed,
    // so the overlay can fall back to a click.
    sync(.axPress) { [unowned self] params in
      let id = try params.string("targetId")
      do {
        try self.platform.press(targetId: id)
        return ["ok": true]
      } catch let e as RPCError where e.code == RPCError.notFound("").code || e.code == RPCError.unsupported("").code {
        return ["ok": false, "error": .string(e.message)]
      }
    }

    sync(.inputClick) { [unowned self] params in
      let x = try params.number("x"), y = try params.number("y")
      let buttonName = try params.optionalString("button") ?? "left"
      guard let button = MouseButton(rawValue: buttonName) else { throw RPCError.invalidParams("button must be \"left\" or \"right\"") }
      let count = try params.optionalInt("count") ?? 1
      guard count == 1 || count == 2 else { throw RPCError.invalidParams("count must be 1 or 2") }
      try self.platform.click(x: x, y: y, button: button, count: count)
      return ["ok": true]
    }

    sync(.inputScroll) { [unowned self] params in
      let x = try params.number("x"), y = try params.number("y")
      let dx = try params.number("dx"), dy = try params.number("dy")
      guard abs(dx) <= 5000, abs(dy) <= 5000 else { throw RPCError.invalidParams("scroll distance is too large") }
      try self.platform.scroll(x: x, y: y, dx: dx, dy: dy)
      return ["ok": true]
    }

    sync(.inputDrag) { [unowned self] params in
      let from = try params.point("from"), to = try params.point("to")
      try self.platform.drag(from: from, to: to)
      return ["ok": true]
    }

    on(.inputType) { [unowned self] params, reply in
      do {
        let text = try params.string("text")
        let steps = try TypingPlan.steps(for: text)
        let focus = self.platform.focusedElementRoles()
        if case .refuse(let why) = SecureFieldPolicy.decide(focusedRole: focus.role, focusedSubrole: focus.subrole) {
          // Never log the text itself.
          self.log("input.type refused (\(text.count) characters): \(why)")
          reply(.success(["ok": false, "error": .string(why)]))
          return
        }
        let ticket = self.currentTicket
        for (i, step) in steps.enumerated() {
          if self.gate.isCancelled(ticket) { reply(.success(["ok": false, "error": .string(RPCError.stopped.message)])); return }
          // Focus can move mid-typing (a login form tabbing to its password field): re-check before each chunk.
          if i > 0 {
            let f = self.platform.focusedElementRoles()
            if case .refuse(let why) = SecureFieldPolicy.decide(focusedRole: f.role, focusedSubrole: f.subrole) {
              reply(.success(["ok": false, "error": .string(why)]))
              return
            }
          }
          switch step {
          case .text(let chunk): try self.platform.typeText(chunk)
          case .key(let name): try self.platform.pressKey(code: KeyCodes.code(for: name)!, flags: 0)
          }
          if i < steps.count - 1 && self.typingChunkDelay > 0 { Thread.sleep(forTimeInterval: self.typingChunkDelay) }
        }
        reply(.success(["ok": true]))
      } catch let e as RPCError { reply(.failure(e)) } catch { reply(.failure(.internalError("\(error)"))) }
    }

    sync(.inputKey) { [unowned self] params in
      let key = try params.string("key")
      let mods = try Modifier.parse(try params.optionalStringArray("modifiers") ?? [])
      guard let code = KeyCodes.code(for: key) else { throw RPCError.invalidParams("unknown key \"\(key)\"") }
      if let why = KeyPolicy.refusal(key: key, modifiers: mods) { return ["ok": false, "error": .string(why)] }
      try self.platform.pressKey(code: code, flags: Modifier.flags(mods))
      return ["ok": true]
    }

    sync(.appsList, queue: workQueue) { [unowned self] params in
      let icons = try params.optionalBool("includeIcons") ?? false
      return ["apps": .array(self.platform.listApps(includeIcons: icons).map(\.json))]
    }

    on(.appsLaunch) { [unowned self] params, reply in
      do {
        let id = try params.string("bundleId")
        self.platform.launch(bundleId: id) { result in
          switch result {
          case .success: reply(.success(["ok": true]))
          case .failure(let e): reply(.success(["ok": false, "error": .string(e.message)]))
          }
        }
      } catch let e as RPCError { reply(.failure(e)) } catch { reply(.failure(.internalError("\(error)"))) }
    }

    sync(.appsActivate) { [unowned self] params in ["ok": .bool(self.platform.activate(bundleId: try params.string("bundleId")))] }
    sync(.appsHide) { [unowned self] params in ["ok": .bool(self.platform.hide(bundleId: try params.string("bundleId")))] }
    sync(.appsFrontmost) { [unowned self] _ in ["app": self.platform.frontmost()?.json ?? .null] }

    on(.screenCapture, queue: workQueue) { [unowned self] params, reply in
      do {
        let format = try params.optionalString("format") ?? "jpeg"
        guard format == "png" || format == "jpeg" else { throw RPCError.invalidParams("format must be \"png\" or \"jpeg\"") }
        let displayId = try params.optionalInt("displayId")
        let maxWidth = try params.optionalInt("maxWidth")
        self.platform.capture(displayId: displayId, maxWidth: maxWidth, format: format) { result in
          switch result {
          case .success(let c):
            reply(.success(["data": .string(c.data), "width": .number(Double(c.width)), "height": .number(Double(c.height)),
                            "scale": .number(c.scale), "format": .string(c.format)]))
          case .failure(let e): reply(.failure(e))
          }
        }
      } catch let e as RPCError { reply(.failure(e)) } catch { reply(.failure(.internalError("\(error)"))) }
    }

    sync(.speechSay) { [unowned self] params in
      let text = try params.string("text")
      guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw RPCError.invalidParams("text is empty") }
      guard text.count <= 5000 else { throw RPCError.invalidParams("text is longer than 5000 characters") }
      try self.platform.say(text: text, voiceId: try params.optionalString("voiceId"), rate: try params.optionalNumber("rate"))
      return ["ok": true]
    }

    on(.speechVoices) { [unowned self] _, reply in
      self.platform.voices { list in
        reply(.success(["voices": .array(list.map { ["id": .string($0.id), "name": .string($0.name), "personal": .bool($0.personal)] })]))
      }
    }

    // Read-only; problems (no permission) come back as { ok: false, error } so the screen can say what to do.
    on(.calendarToday, queue: workQueue) { [unowned self] _, reply in
      self.platform.calendarToday { result in
        switch result {
        case .success(let events):
          let sorted = events.sorted { ($0.allDay ? "" : $0.start) < ($1.allDay ? "" : $1.start) }
          reply(.success(["ok": true, "events": .array(sorted.prefix(50).map(\.json))]))
        case .failure(let problem):
          reply(.success(["ok": false, "error": .string(problem.message)]))
        }
      }
    }

    // speech.listen checks permissions only when turning on; turning off must always work.
    dispatcher.register(NativeMethodName.speechListen.rawValue) { [unowned self] params, reply in
      do {
        guard let on = try params.optionalBool("on") else { throw RPCError.invalidParams("\"on\" must be true or false") }
        if on, let missing = self.platform.firstMissing(NativeMethodName.speechListen.requiredPermissions) {
          reply(.success(["ok": false, "error": .string(missing.missingMessage)]))
          return
        }
        do {
          try self.platform.listen(on: on, locale: try params.optionalString("locale"))
          reply(.success(["ok": true]))
        } catch let e as RPCError {
          reply(.success(["ok": false, "error": .string(e.message)]))
        }
      } catch let e as RPCError { reply(.failure(e)) } catch { reply(.failure(.internalError("\(error)"))) }
    }

    // The kill switch runs inline on the reader thread: never queued behind anything, never rate-limited,
    // never permission-gated.
    dispatcher.register(NativeMethodName.inputStopAll.rawValue) { [unowned self] _, reply in
      self.gate.stopAll()
      self.platform.stopAll()
      self.log("input.stopAll: cancelled all synthetic input")
      reply(.success(["ok": true]))
    }
  }
}
