import Foundation

/// A JSON value. Parsed with Foundation's decoder, serialized by hand so output is compact, deterministic
/// (sorted keys) and always one line, which the newline-delimited protocol depends on.
public enum JSONValue: Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public static func parse(_ text: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
  public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
  public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
  public var intValue: Int? {
    guard case .number(let n) = self, n.rounded() == n, abs(n) < 9.0e15 else { return nil }
    return Int(n)
  }
  public var isNull: Bool { self == .null }

  /// Compact one-line JSON with sorted object keys.
  public func serialized() -> String {
    var out = ""
    write(into: &out)
    return out
  }

  private func write(into out: inout String) {
    switch self {
    case .null: out += "null"
    case .bool(let b): out += b ? "true" : "false"
    case .number(let n): out += JSONValue.format(n)
    case .string(let s): JSONValue.escape(s, into: &out)
    case .array(let a):
      out += "["
      for (i, v) in a.enumerated() {
        if i > 0 { out += "," }
        v.write(into: &out)
      }
      out += "]"
    case .object(let o):
      out += "{"
      for (i, k) in o.keys.sorted().enumerated() {
        if i > 0 { out += "," }
        JSONValue.escape(k, into: &out)
        out += ":"
        o[k]!.write(into: &out)
      }
      out += "}"
    }
  }

  static func format(_ n: Double) -> String {
    guard n.isFinite else { return "null" }
    if n.rounded() == n && abs(n) < 1e15 { return String(Int64(n)) }
    return "\(n)"
  }

  static func escape(_ s: String, into out: inout String) {
    out += "\""
    for u in s.unicodeScalars {
      switch u {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case "\u{2028}": out += "\\u2028"
      case "\u{2029}": out += "\\u2029"
      default:
        if u.value < 0x20 {
          out += String(format: "\\u%04x", u.value)
        } else {
          out.unicodeScalars.append(u)
        }
      }
    }
    out += "\""
  }
}

extension JSONValue: Decodable {
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null; return }
    if let b = try? c.decode(Bool.self) { self = .bool(b); return }
    if let n = try? c.decode(Double.self) { self = .number(n); return }
    if let s = try? c.decode(String.self) { self = .string(s); return }
    if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
    if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
    throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
  ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral
{
  public init(stringLiteral value: String) { self = .string(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, b in b }))
  }
  public init(nilLiteral: ()) { self = .null }
}

/// Typed access to a request's params, throwing JSON-RPC "invalid params" with a plain message.
public struct Params {
  public let raw: JSONValue
  public init(_ raw: JSONValue) { self.raw = raw }

  public func string(_ key: String) throws -> String {
    guard let s = raw[key]?.stringValue else { throw RPCError.invalidParams("\"\(key)\" must be a string") }
    return s
  }
  public func optionalString(_ key: String) throws -> String? {
    guard let v = raw[key], !v.isNull else { return nil }
    guard let s = v.stringValue else { throw RPCError.invalidParams("\"\(key)\" must be a string") }
    return s
  }
  public func number(_ key: String) throws -> Double {
    guard let n = raw[key]?.doubleValue, n.isFinite else { throw RPCError.invalidParams("\"\(key)\" must be a number") }
    return n
  }
  public func optionalNumber(_ key: String) throws -> Double? {
    guard let v = raw[key], !v.isNull else { return nil }
    guard let n = v.doubleValue, n.isFinite else { throw RPCError.invalidParams("\"\(key)\" must be a number") }
    return n
  }
  public func optionalInt(_ key: String) throws -> Int? {
    guard let v = raw[key], !v.isNull else { return nil }
    guard let n = v.intValue else { throw RPCError.invalidParams("\"\(key)\" must be a whole number") }
    return n
  }
  public func optionalBool(_ key: String) throws -> Bool? {
    guard let v = raw[key], !v.isNull else { return nil }
    guard let b = v.boolValue else { throw RPCError.invalidParams("\"\(key)\" must be true or false") }
    return b
  }
  public func optionalStringArray(_ key: String) throws -> [String]? {
    guard let v = raw[key], !v.isNull else { return nil }
    guard case .array(let items) = v else { throw RPCError.invalidParams("\"\(key)\" must be a list") }
    return try items.map {
      guard let s = $0.stringValue else { throw RPCError.invalidParams("\"\(key)\" must be a list of strings") }
      return s
    }
  }
}
