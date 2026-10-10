import AgencyNativeCore
import CoreGraphics
import Foundation

/// CGEvent clicks, scrolling, typing and keys. Every event carries AGENCY's tag in eventSourceUserData so other
/// parts of AGENCY (and anyone auditing) can tell synthetic input from the person's own.
final class SyntheticInput: @unchecked Sendable {
  /// "AGENCY" in ASCII.
  static let tag: Int64 = 0x4147_454E_4359

  private let source = CGEventSource(stateID: .hidSystemState)

  private func post(_ event: CGEvent?) throws {
    guard let event else { throw RPCError.internalError("couldn't create the input event") }
    event.setIntegerValueField(.eventSourceUserData, value: Self.tag)
    event.post(tap: .cghidEventTap)
  }

  func click(at point: CGPoint, button: MouseButton, count: Int) throws {
    let (down, up, cg): (CGEventType, CGEventType, CGMouseButton) =
      button == .right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: cg))
    for click in 1...count {
      for type in [down, up] {
        let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: cg)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        try post(e)
      }
    }
  }

  /// dx, dy in points; positive dy shows content above (the CGEvent scroll-wheel convention, per native.ts).
  func scroll(at point: CGPoint, dx: Double, dy: Double) throws {
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    try post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                     wheel1: Int32(clamping: Int(dy.rounded())), wheel2: Int32(clamping: Int(dx.rounded())), wheel3: 0))
  }

  /// Press at `from`, move there in small steps (apps only notice drags that move), release at `to`. The
  /// button is always released, even if posting a move fails, so nothing stays held.
  func drag(from: CGPoint, to: CGPoint) throws {
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left))
    try post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
    defer {
      try? post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
    }
    let steps = 12
    for i in 1...steps {
      let t = Double(i) / Double(steps)
      let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
      try post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
      usleep(8_000)
    }
  }

  func type(_ chunk: String) throws {
    let units = Array(chunk.utf16)
    for keyDown in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown)
      units.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
      try post(e)
    }
  }

  func key(code: UInt16, flags: UInt64) throws {
    for keyDown in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: keyDown)
      e?.flags = CGEventFlags(rawValue: flags)
      try post(e)
    }
  }

  /// A drag releases its own button; this makes sure no button stays down after Stop.
  func releaseAll() {
    let location = CGEvent(source: nil)?.location ?? .zero
    for (type, button) in [(CGEventType.leftMouseUp, CGMouseButton.left), (.rightMouseUp, .right)]
    where CGEventSource.buttonState(.hidSystemState, button: button) {
      try? post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: button))
    }
  }
}
