import Foundation
import Testing
@testable import AgencyNativeCore

@Suite struct JSONTests {
  @Test func parsesAllValueKinds() throws {
    let v = try JSONValue.parse(#"{"a":1,"b":true,"c":null,"d":"x","e":[1.5,false],"f":{"g":"h"}}"#)
    #expect(v["a"] == .number(1))
    #expect(v["b"] == .bool(true))
    #expect(v["c"] == .null)
    #expect(v["d"] == .string("x"))
    #expect(v["e"] == .array([.number(1.5), .bool(false)]))
    #expect(v["f"]?["g"] == .string("h"))
  }

  @Test func booleansAreNotNumbers() throws {
    #expect(try JSONValue.parse("true") == .bool(true))
    #expect(try JSONValue.parse("1") == .number(1))
    #expect(try JSONValue.parse("0") == .number(0))
  }

  @Test func serializesCompactSortedOneLine() {
    let v: JSONValue = ["b": 2, "a": ["x\ny": "q\"\\", "n": nil], "c": [1.5, true]]
    let s = v.serialized()
    #expect(s == #"{"a":{"n":null,"x\ny":"q\"\\"},"b":2,"c":[1.5,true]}"#)
    #expect(!s.contains("\n"))
  }

  @Test func escapesControlAndLineSeparators() {
    #expect(JSONValue.string("a\u{01}b\u{2028}").serialized() == "\"a\\u0001b\\u2028\"")
  }

  @Test func roundTripsUnicode() throws {
    let v: JSONValue = ["s": "héllo 👋🏽 世界"]
    #expect(try JSONValue.parse(v.serialized()) == v)
  }

  @Test func formatsNumbers() {
    #expect(JSONValue.number(3).serialized() == "3")
    #expect(JSONValue.number(-0.25).serialized() == "-0.25")
    #expect(JSONValue.number(.nan).serialized() == "null")
    #expect(JSONValue.number(.infinity).serialized() == "null")
  }

  @Test func intValueRejectsFractions() {
    #expect(JSONValue.number(4).intValue == 4)
    #expect(JSONValue.number(4.5).intValue == nil)
    #expect(JSONValue.string("4").intValue == nil)
  }

  @Test func paramsValidateTypes() throws {
    let p = Params(["s": "x", "n": 2, "b": true, "l": ["cmd", "shift"], "bad": 1])
    #expect(try p.string("s") == "x")
    #expect(try p.number("n") == 2)
    #expect(try p.optionalInt("n") == 2)
    #expect(try p.optionalBool("b") == true)
    #expect(try p.optionalBool("missing") == nil)
    #expect(try p.optionalStringArray("l") == ["cmd", "shift"])
    #expect(throws: RPCError.self) { try p.string("bad") }
    #expect(throws: RPCError.self) { try p.number("s") }
    #expect(throws: RPCError.self) { try p.optionalStringArray("s") }
    do { _ = try p.string("missing"); Issue.record("expected throw") } catch let e as RPCError { #expect(e.code == -32602) }
  }
}

@Suite struct RPCTests {
  @Test func parsesRequestAndNotification() {
    #expect(RPC.parse(line: #"{"jsonrpc":"2.0","id":7,"method":"m","params":{"a":1}}"#)
      == .request(RPCRequest(id: .number(7), method: "m", params: ["a": 1])))
    #expect(RPC.parse(line: #"{"jsonrpc":"2.0","method":"m"}"#)
      == .request(RPCRequest(id: nil, method: "m", params: .object([:]))))
    #expect(RPC.parse(line: #"{"jsonrpc":"2.0","id":"abc","method":"m","params":[]}"#)
      == .request(RPCRequest(id: .string("abc"), method: "m", params: .object([:]))))
  }

  @Test func rejectsMalformed() {
    #expect(RPC.parse(line: "{oops") == .failure(id: .null, error: .parseError))
    #expect(RPC.parse(line: "[1,2]") == .failure(id: .null, error: .invalidRequest))
    #expect(RPC.parse(line: #"{"id":1,"method":"m"}"#) == .failure(id: .number(1), error: .invalidRequest))
    #expect(RPC.parse(line: #"{"jsonrpc":"1.0","id":1,"method":"m"}"#) == .failure(id: .number(1), error: .invalidRequest))
    #expect(RPC.parse(line: #"{"jsonrpc":"2.0","id":{},"method":"m"}"#) == .failure(id: .null, error: .invalidRequest))
    #expect(RPC.parse(line: #"{"jsonrpc":"2.0","id":1,"method":""}"#) == .failure(id: .number(1), error: .invalidRequest))
    if case .failure(_, let e) = RPC.parse(line: #"{"jsonrpc":"2.0","id":1,"method":"m","params":5}"#) {
      #expect(e.code == -32602)
    } else { Issue.record("expected invalid params") }
  }

  @Test func encodesResponsesAndEvents() {
    #expect(RPC.response(id: 1, result: ["ok": true]) == #"{"id":1,"jsonrpc":"2.0","result":{"ok":true}}"#)
    #expect(RPC.errorResponse(id: nil, error: .parseError)
      == #"{"error":{"code":-32700,"message":"The request was not valid JSON."},"id":null,"jsonrpc":"2.0"}"#)
    #expect(RPC.event(["type": "speech-final", "text": "hi"])
      == #"{"jsonrpc":"2.0","method":"event","params":{"text":"hi","type":"speech-final"}}"#)
  }

  @Test func permissionMessageNamesSettingsPane() {
    let e = RPCError.permissionMissing(.accessibility)
    #expect(e.code == -32001)
    #expect(e.message.contains("System Settings > Privacy & Security > Accessibility"))
    #expect(e.data == ["permission": "accessibility"])
    #expect(RPCError.permissionMissing(.screenRecording).message.contains("Screen & System Audio Recording"))
  }
}

@Suite struct DispatcherTests {
  func collect(_ d: Dispatcher, _ line: String) -> [String] {
    var out: [String] = []
    d.handle(line: line) { out.append($0) }
    return out
  }

  @Test func routesAndReplies() {
    let d = Dispatcher()
    d.registerSync("echo") { p in p.raw }
    #expect(collect(d, #"{"jsonrpc":"2.0","id":1,"method":"echo","params":{"x":1}}"#)
      == [#"{"id":1,"jsonrpc":"2.0","result":{"x":1}}"#])
  }

  @Test func unknownMethodAndBlankLines() {
    let d = Dispatcher()
    #expect(collect(d, "   ") == [])
    let out = collect(d, #"{"jsonrpc":"2.0","id":2,"method":"nope"}"#)
    #expect(out.count == 1 && out[0].contains("-32601"))
  }

  @Test func notificationsGetNoReply() {
    let d = Dispatcher()
    var ran = false
    d.registerSync("n") { _ in ran = true; return nil }
    #expect(collect(d, #"{"jsonrpc":"2.0","method":"n"}"#) == [])
    #expect(ran)
  }

  @Test func repliesOnlyOnce() {
    let d = Dispatcher()
    d.register("twice") { _, reply in reply(.success(1)); reply(.success(2)) }
    #expect(collect(d, #"{"jsonrpc":"2.0","id":1,"method":"twice"}"#).count == 1)
  }

  @Test func thrownErrorsBecomeErrorResponses() {
    let d = Dispatcher()
    d.registerSync("bad") { p in try p.string("missing") ; return nil }
    d.registerSync("boom") { _ in throw CocoaError(.fileNoSuchFile) }
    #expect(collect(d, #"{"jsonrpc":"2.0","id":1,"method":"bad"}"#)[0].contains("-32602"))
    #expect(collect(d, #"{"jsonrpc":"2.0","id":1,"method":"boom"}"#)[0].contains("-32603"))
  }
}
