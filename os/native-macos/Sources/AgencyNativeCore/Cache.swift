import Foundation

/// Snapshot cache for ax.targets. Entries die on an AXObserver notification that changes layout, or after a
/// short TTL because some changes (scrolling in many apps) send no notification at all.
public final class TargetCache: @unchecked Sendable {
  public struct Key: Hashable, Sendable {
    public var pid: Int32
    public var includeWeb: Bool
    public init(pid: Int32, includeWeb: Bool) {
      self.pid = pid
      self.includeWeb = includeWeb
    }
  }

  struct Entry {
    var snapshot: NativeSnapshot
    var maxCount: Int
    var at: Double
  }

  /// Notifications that mean the targets on screen may have changed. AXValueChanged is deliberately absent:
  /// it fires on every keystroke and rarely changes targets; the TTL covers the rest.
  public static let invalidating: Set<String> = [
    "AXFocusedWindowChanged", "AXMainWindowChanged", "AXWindowCreated", "AXWindowMoved", "AXWindowResized",
    "AXWindowMiniaturized", "AXWindowDeminiaturized", "AXUIElementDestroyed", "AXCreated", "AXLayoutChanged",
    "AXMenuOpened", "AXMenuClosed", "AXSheetCreated", "AXDrawerCreated", "AXRowCountChanged", "AXRowExpanded",
    "AXRowCollapsed", "AXSelectedChildrenChanged", "AXTitleChanged", "AXLoadComplete", "AXApplicationActivated",
    "AXApplicationShown", "AXApplicationHidden", "AXFocusedUIElementChanged",
  ]

  public let ttl: Double
  private let now: () -> Double
  private var entries: [Key: Entry] = [:]
  private let lock = NSLock()
  public private(set) var hits = 0
  public private(set) var misses = 0

  public init(ttl: Double = 1.0, now: @escaping () -> Double = Clock.seconds) {
    self.ttl = ttl
    self.now = now
  }

  public func get(_ key: Key, maxCount: Int) -> NativeSnapshot? {
    lock.lock(); defer { lock.unlock() }
    guard let e = entries[key], now() - e.at <= ttl else {
      misses += 1
      return nil
    }
    // A cached result built with a smaller cap can't answer a bigger request unless it wasn't truncated.
    if maxCount > e.maxCount && e.snapshot.truncated {
      misses += 1
      return nil
    }
    hits += 1
    return e.snapshot.capped(maxCount)
  }

  public func put(_ key: Key, maxCount: Int, snapshot: NativeSnapshot) {
    lock.lock(); entries[key] = Entry(snapshot: snapshot, maxCount: maxCount, at: now()); lock.unlock()
  }

  /// Returns true if the notification invalidated anything.
  @discardableResult
  public func invalidate(pid: Int32, notification: String) -> Bool {
    guard Self.invalidating.contains(notification) else { return false }
    lock.lock(); defer { lock.unlock() }
    let before = entries.count
    entries = entries.filter { $0.key.pid != pid }
    return entries.count != before
  }

  public func invalidateAll() {
    lock.lock(); entries.removeAll(); lock.unlock()
  }
}
