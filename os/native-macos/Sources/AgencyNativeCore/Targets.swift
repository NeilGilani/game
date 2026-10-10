import Foundation

/// A rectangle in global screen points (origin at the top-left of the main display).
public struct Rect: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public var maxX: Double { x + width }
  public var maxY: Double { y + height }
  public var area: Double { max(0, width) * max(0, height) }
  public var isEmpty: Bool { width <= 0 || height <= 0 }
  public var center: (x: Double, y: Double) { (x + width / 2, y + height / 2) }

  public func intersection(_ o: Rect) -> Rect? {
    let x0 = max(x, o.x), y0 = max(y, o.y)
    let x1 = min(maxX, o.maxX), y1 = min(maxY, o.maxY)
    guard x1 > x0, y1 > y0 else { return nil }
    return Rect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
  }

  public var json: JSONValue {
    ["x": .number(JSONRound.round(x)), "y": .number(JSONRound.round(y)), "width": .number(JSONRound.round(width)),
     "height": .number(JSONRound.round(height))]
  }
}

enum JSONRound {
  /// Two decimals is plenty for points and keeps snapshots small.
  static func round(_ v: Double) -> Double { (v * 100).rounded() / 100 }
}

/// Where in the app a candidate was found; earlier zones are returned first when capping.
public enum TargetZone: Int, Comparable, Sendable {
  case focusedWindow = 0
  case menuBar = 1
  case otherWindow = 2
  public static func < (a: TargetZone, b: TargetZone) -> Bool { a.rawValue < b.rawValue }
}

/// An element found by the walker, before filtering.
public struct TargetCandidate: Equatable, Sendable {
  public var id: String
  public var role: String
  public var label: String
  public var rect: Rect
  /// Visible region of the ancestors (scroll areas, web areas, the window); nil if unknown.
  public var clip: Rect?
  public var secure: Bool
  public var enabled: Bool
  public var zone: TargetZone
  /// Walk order, used to keep reading order stable inside a zone.
  public var order: Int

  public init(
    id: String, role: String, label: String, rect: Rect, clip: Rect? = nil, secure: Bool = false,
    enabled: Bool = true, zone: TargetZone = .focusedWindow, order: Int = 0
  ) {
    self.id = id
    self.role = role
    self.label = label
    self.rect = rect
    self.clip = clip
    self.secure = secure
    self.enabled = enabled
    self.zone = zone
    self.order = order
  }
}

/// A Target from os/contracts/src/targets.ts with source "ax".
public struct NativeTarget: Equatable, Sendable {
  public var id: String
  public var rect: Rect
  public var role: String
  public var label: String
  public var owner: String?
  public var secure: Bool

  public var json: JSONValue {
    var o: [String: JSONValue] = [
      "id": .string(id), "rect": rect.json, "role": .string(role), "label": .string(label), "source": "ax",
    ]
    if let owner { o["owner"] = .string(owner) }
    if secure { o["secure"] = true }
    return .object(o)
  }
}

public struct NativeSnapshot: Equatable, Sendable {
  public var t: Double
  public var owner: String?
  public var targets: [NativeTarget]
  public var truncated: Bool

  public init(t: Double, owner: String?, targets: [NativeTarget], truncated: Bool) {
    self.t = t
    self.owner = owner
    self.targets = targets
    self.truncated = truncated
  }

  public var json: JSONValue {
    ["t": .number(t.rounded()), "owner": owner.map(JSONValue.string) ?? .null, "targets": .array(targets.map(\.json)),
     "truncated": .bool(truncated)]
  }

  /// The same snapshot capped to fewer targets (for serving a smaller request from cache).
  public func capped(_ maxCount: Int) -> NativeSnapshot {
    guard targets.count > maxCount else { return self }
    return NativeSnapshot(t: t, owner: owner, targets: Array(targets.prefix(maxCount)), truncated: true)
  }
}

public enum TargetSelector {
  public static let defaultMaxCount = 300
  public static let hardMaxCount = 1000
  /// Anything smaller than this after clipping can't be looked at reliably and is probably decoration.
  public static let minSidePt = 4.0

  public static func clampMaxCount(_ requested: Int?) -> Int {
    min(hardMaxCount, max(1, requested ?? defaultMaxCount))
  }

  /// Filter (disabled, zero-size, clipped away, off every display), clip to what's visible, de-duplicate,
  /// order (focused window, then menu bar, then other windows; reading order within each) and cap.
  public static func select(
    _ candidates: [TargetCandidate], displays: [Rect], maxCount: Int, owner: String?
  ) -> (targets: [NativeTarget], truncated: Bool) {
    var seen = Set<String>()
    var kept: [(TargetCandidate, Rect)] = []
    for c in candidates where c.enabled && !c.rect.isEmpty {
      var r = c.rect
      if let clip = c.clip {
        guard let clipped = r.intersection(clip) else { continue }
        r = clipped
      }
      guard let visible = largestDisplayPart(of: r, displays: displays) else { continue }
      guard visible.width >= minSidePt, visible.height >= minSidePt else { continue }
      guard seen.insert(c.id).inserted else { continue }
      kept.append((c, visible))
    }
    kept.sort { a, b in
      a.0.zone != b.0.zone ? a.0.zone < b.0.zone : a.0.order < b.0.order
    }
    let cap = clampMaxCount(maxCount)
    let truncated = kept.count > cap
    let targets = kept.prefix(cap).map { c, r in
      NativeTarget(id: c.id, rect: r, role: c.role, label: c.label, owner: owner, secure: c.secure)
    }
    return (targets, truncated)
  }

  /// The part of the rect on the display it overlaps most, or nil if it's off every display.
  public static func largestDisplayPart(of r: Rect, displays: [Rect]) -> Rect? {
    if displays.isEmpty { return r }
    var best: Rect? = nil
    for d in displays {
      if let i = r.intersection(d), i.area > (best?.area ?? 0) { best = i }
    }
    return best
  }
}

/// Stable target ids: FNV-1a over the app's pid and the element's CFHash. CFHash is stable for the life of an
/// AXUIElement, so the same button keeps its id across snapshots while it exists.
public enum TargetID {
  public static func make(pid: Int32, elementHash: UInt) -> String {
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in "\(pid):\(elementHash)".utf8 {
      h ^= UInt64(byte)
      h = h &* 0x0000_0100_0000_01b3
    }
    return "ax-" + String(h, radix: 16)
  }
}
