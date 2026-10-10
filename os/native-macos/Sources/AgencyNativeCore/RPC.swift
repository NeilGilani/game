import Foundation

/// A JSON-RPC 2.0 error. Messages are plain language because they can reach the person's screen.
public struct RPCError: Error, Equatable, Sendable {
  public let code: Int
  public let message: String
  public let data: JSONValue?

  public init(code: Int, message: String, data: JSONValue? = nil) {
    self.code = code
    self.message = message
    self.data = data
  }

  public static let parseError = RPCError(code: -32700, message: "The request was not valid JSON.")
  public static let invalidRequest = RPCError(code: -32600, message: "The request was not a valid JSON-RPC 2.0 request.")
  public static func methodNotFound(_ method: String) -> RPCError {
    RPCError(code: -32601, message: "Unknown method: \(method)", data: ["method": .string(method)])
  }
  public static func invalidParams(_ detail: String) -> RPCError {
    RPCError(code: -32602, message: "Invalid params: \(detail)")
  }
  public static func internalError(_ detail: String) -> RPCError {
    RPCError(code: -32603, message: "Internal error: \(detail)")
  }

  // Server errors (-32000 to -32099).
  public static func permissionMissing(_ kind: PermissionKind) -> RPCError {
    RPCError(code: -32001, message: kind.missingMessage, data: ["permission": .string(kind.rawValue)])
  }
  public static let rateLimited = RPCError(
    code: -32002, message: "Too many actions too quickly. AGENCY slowed down to keep you in control.")
  public static let stopped = RPCError(code: -32003, message: "Stopped. All actions were cancelled.")
  public static func unsupported(_ detail: String) -> RPCError { RPCError(code: -32004, message: detail) }
  public static func refused(_ detail: String) -> RPCError { RPCError(code: -32005, message: detail) }
  public static func notFound(_ detail: String) -> RPCError { RPCError(code: -32006, message: detail) }

  public var json: JSONValue {
    var o: [String: JSONValue] = ["code": .number(Double(code)), "message": .string(message)]
    if let data { o["data"] = data }
    return .object(o)
  }
}

public struct RPCRequest: Equatable {
  /// nil for notifications (no response is sent).
  public let id: JSONValue?
  public let method: String
  public let params: JSONValue
}

public enum RPCParseResult: Equatable {
  case request(RPCRequest)
  /// id is echoed when it could be read; JSON-RPC uses null otherwise.
  case failure(id: JSONValue, error: RPCError)
}

public enum RPC {
  public static func parse(line: String) -> RPCParseResult {
    let value: JSONValue
    do { value = try JSONValue.parse(line) } catch { return .failure(id: .null, error: .parseError) }
    guard case .object(let o) = value else { return .failure(id: .null, error: .invalidRequest) }

    var id: JSONValue? = nil
    if let raw = o["id"] {
      switch raw {
      case .string, .number, .null: id = raw
      default: return .failure(id: .null, error: .invalidRequest)
      }
    }
    guard o["jsonrpc"] == .string("2.0"), let method = o["method"]?.stringValue, !method.isEmpty else {
      return .failure(id: id ?? .null, error: .invalidRequest)
    }
    let params = o["params"] ?? .object([:])
    switch params {
    case .object: break
    case .array(let a) where a.isEmpty: break
    case .null: break
    default: return .failure(id: id ?? .null, error: .invalidParams("params must be an object"))
    }
    let normalized: JSONValue = { if case .object = params { return params }; return .object([:]) }()
    return .request(RPCRequest(id: id, method: method, params: normalized))
  }

  public static func response(id: JSONValue, result: JSONValue) -> String {
    JSONValue.object(["jsonrpc": "2.0", "id": id, "result": result]).serialized()
  }

  public static func errorResponse(id: JSONValue, error: RPCError) -> String {
    JSONValue.object(["jsonrpc": "2.0", "id": id, "error": error.json]).serialized()
  }

  public static func notification(method: String, params: JSONValue) -> String {
    JSONValue.object(["jsonrpc": "2.0", "method": .string(method), "params": params]).serialized()
  }

  /// A NativeEvent from os/contracts/src/native.ts, sent as a notification named "event".
  public static func event(_ event: JSONValue) -> String { notification(method: "event", params: event) }
}

/// Routes parsed requests to handlers. Handlers reply exactly once, possibly asynchronously.
public final class Dispatcher: @unchecked Sendable {
  public typealias Reply = (Result<JSONValue, RPCError>) -> Void
  public typealias Handler = (Params, @escaping Reply) -> Void

  private var handlers: [String: Handler] = [:]
  private let lock = NSLock()

  public init() {}

  public var methods: [String] { lock.lock(); defer { lock.unlock() }; return handlers.keys.sorted() }

  public func register(_ method: String, _ handler: @escaping Handler) {
    lock.lock(); handlers[method] = handler; lock.unlock()
  }

  /// A handler that returns (or throws) synchronously.
  public func registerSync(_ method: String, _ body: @escaping (Params) throws -> JSONValue) {
    register(method) { params, reply in
      do { reply(.success(try body(params))) } catch let e as RPCError { reply(.failure(e)) } catch {
        reply(.failure(.internalError(String(describing: error))))
      }
    }
  }

  /// Handle one line of input. `send` receives exactly one response line for requests with an id,
  /// none for notifications and blank lines.
  public func handle(line: String, send: @escaping (String) -> Void) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return }
    switch RPC.parse(line: trimmed) {
    case .failure(let id, let error):
      send(RPC.errorResponse(id: id, error: error))
    case .request(let request):
      lock.lock(); let handler = handlers[request.method]; lock.unlock()
      let once = Once()
      let reply: Reply = { result in
        guard once.claim(), let id = request.id else { return }
        switch result {
        case .success(let value): send(RPC.response(id: id, result: value))
        case .failure(let error): send(RPC.errorResponse(id: id, error: error))
        }
      }
      guard let handler else { reply(.failure(.methodNotFound(request.method))); return }
      handler(Params(request.params), reply)
    }
  }
}

/// Lets a reply fire only once, from any thread.
final class Once: @unchecked Sendable {
  private var done = false
  private let lock = NSLock()
  func claim() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if done { return false }
    done = true
    return true
  }
}
