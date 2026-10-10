import AgencyNativeCore
import AppKit
import ApplicationServices

/// Targets from the frontmost app's accessibility tree, with a cache invalidated by AXObserver notifications.
final class AXTargets: @unchecked Sendable {
  let cache = TargetCache(ttl: 1.0)
  /// Time budget for one walk. The contract budget is 100 ms end to end; the rest is filtering and JSON.
  var budget: Double = 0.080
  /// Hard ceiling on visited elements, whatever the budget.
  var maxNodes = 20_000

  private let emit: (JSONValue) -> Void
  private let lock = NSLock()
  /// Elements from the latest two walks by target id, so a press on a slightly older snapshot still works.
  private var registry: [String: AXUIElement] = [:]
  private var previousRegistry: [String: AXUIElement] = [:]
  private var registryPid: pid_t = 0

  private var observer: AXObserver?
  private var observedPid: pid_t = 0
  private var observedBundleId: String?
  private var pendingEmit: DispatchWorkItem?

  static let watched: [String] = [
    kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXWindowCreatedNotification,
    kAXWindowMovedNotification, kAXWindowResizedNotification, kAXWindowMiniaturizedNotification,
    kAXWindowDeminiaturizedNotification, kAXUIElementDestroyedNotification, kAXCreatedNotification,
    kAXLayoutChangedNotification, kAXMenuOpenedNotification, kAXMenuClosedNotification, kAXSheetCreatedNotification,
    kAXRowCountChangedNotification, kAXRowExpandedNotification, kAXRowCollapsedNotification,
    kAXSelectedChildrenChangedNotification, kAXTitleChangedNotification, kAXFocusedUIElementChangedNotification,
    "AXLoadComplete",
  ]

  /// AGENCY_NATIVE_DEBUG=1 logs walk timings and notifications (never labels) to stderr.
  static let debug = ProcessInfo.processInfo.environment["AGENCY_NATIVE_DEBUG"] == "1"

  init(emit: @escaping (JSONValue) -> Void) { self.emit = emit }

  // MARK: Observation (main thread)

  func observe(app: NSRunningApplication?) {
    if let old = observer {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(old), .defaultMode)
      observer = nil
    }
    cache.invalidateAll()
    guard let app, AXIsProcessTrusted() else { return }
    let pid = app.processIdentifier
    var obs: AXObserver?
    let callback: AXObserverCallback = { _, _, notification, refcon in
      guard let refcon else { return }
      let me = Unmanaged<AXTargets>.fromOpaque(refcon).takeUnretainedValue()
      me.notified(notification as String)
    }
    guard AXObserverCreate(pid, callback, &obs) == .success, let obs else {
      Log.info("could not observe pid \(pid); targets refresh on a timer only")
      return
    }
    let element = AXUIElementCreateApplication(pid)
    let refcon = Unmanaged.passUnretained(self).toOpaque()
    for n in Self.watched { AXObserverAddNotification(obs, element, n as CFString, refcon) }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
    observer = obs
    observedPid = pid
    observedBundleId = app.bundleIdentifier
  }

  private func notified(_ name: String) {
    guard TargetCache.invalidating.contains(name) else { return }
    if Self.debug { Log.info("ax notification: \(name)") }
    cache.invalidate(pid: observedPid, notification: name)
    // Coalesce bursts (a page load sends hundreds) into one event.
    pendingEmit?.cancel()
    let owner = observedBundleId
    let work = DispatchWorkItem { [weak self] in
      self?.emit(["type": "targets-changed", "owner": owner.map(JSONValue.string) ?? .null])
    }
    pendingEmit = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
  }

  // MARK: Snapshot

  func snapshot(maxCount: Int, includeWeb: Bool) -> NativeSnapshot {
    guard let app = NSWorkspace.shared.frontmostApplication else {
      return NativeSnapshot(t: Clock.epochMs(), owner: nil, targets: [], truncated: false)
    }
    let pid = app.processIdentifier
    let key = TargetCache.Key(pid: pid, includeWeb: includeWeb)
    if let hit = cache.get(key, maxCount: maxCount) {
      if Self.debug { Log.info("ax.targets: cache hit (\(hit.targets.count) targets)") }
      return hit
    }

    let walkStart = Clock.seconds()
    let walk = Walk(pid: pid, includeWeb: includeWeb, budget: budget, maxNodes: maxNodes,
                    wanted: maxCount + maxCount / 2 + 50)
    walk.run()
    let (targets, truncated) = TargetSelector.select(walk.candidates, displays: Self.displayRects(), maxCount: maxCount,
                                                     owner: app.bundleIdentifier)
    let snapshot = NativeSnapshot(t: Clock.epochMs(), owner: app.bundleIdentifier, targets: targets,
                                  truncated: truncated || walk.incomplete)
    lock.lock()
    if registryPid != pid { previousRegistry = [:] } else { previousRegistry = registry }
    registry = walk.elements
    registryPid = pid
    lock.unlock()
    cache.put(key, maxCount: maxCount, snapshot: snapshot)
    if Self.debug {
      Log.info(String(format: "ax.targets: walked %d elements in %.1f ms, %d candidates, %d targets, stop: %@",
                      walk.visited, (Clock.seconds() - walkStart) * 1000, walk.candidates.count, targets.count,
                      walk.stopReason ?? "complete"))
    }
    return snapshot
  }

  static func displayRects() -> [Rect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    return ids.prefix(Int(count)).map {
      let b = CGDisplayBounds($0)
      return Rect(x: b.origin.x, y: b.origin.y, width: b.width, height: b.height)
    }
  }

  // MARK: Actions

  func press(targetId: String) throws {
    lock.lock()
    let element = registry[targetId] ?? previousRegistry[targetId]
    lock.unlock()
    guard let element else { throw RPCError.notFound("That control isn't on screen any more. Look at it again.") }
    AXUIElementSetMessagingTimeout(element, 0.5)
    let role = AXRead.string(element, kAXRoleAttribute) ?? ""
    let subrole = AXRead.string(element, kAXSubroleAttribute)
    // "Pressing" a text field means focusing it. AXPress on a text field can report success without moving
    // focus, which would leave typing going to whichever field had focus before.
    if RoleMapper.map(role: role, subrole: subrole, parentRole: nil)?.role == "textfield" {
      if AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success { return }
    }
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return }
    if AXUIElementPerformAction(element, kAXConfirmAction as CFString) == .success { return }
    if role == "AXRow" || role == "AXCell" {
      if AXUIElementSetAttributeValue(element, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success { return }
    }
    throw RPCError.unsupported("This control can't be pressed directly; use a click instead.")
  }

  func focusedRoles() -> (role: String?, subrole: String?) {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.25)
    var focused: AXUIElement? = AXRead.element(system, kAXFocusedUIElementAttribute)
    if focused == nil, let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, 0.25)
      focused = AXRead.element(app, kAXFocusedUIElementAttribute)
    }
    guard let focused else { return (nil, nil) }
    return (AXRead.string(focused, kAXRoleAttribute), AXRead.string(focused, kAXSubroleAttribute))
  }
}

/// One depth-first walk of an app's tree within a time budget.
final class Walk {
  let pid: pid_t
  let includeWeb: Bool
  let deadline: Double
  let maxNodes: Int
  let wanted: Int
  var candidates: [TargetCandidate] = []
  var elements: [String: AXUIElement] = [:]
  var incomplete = false
  var stopReason: String?
  private(set) var visited = 0

  static let attributes: CFArray = ([
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    kAXHelpAttribute, kAXPlaceholderValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute,
    kAXChildrenAttribute,
  ] as [String]) as CFArray

  /// Roles whose frame bounds what's visible inside them.
  static let clipping: Set<String> = ["AXWindow", "AXSheet", "AXScrollArea", "AXWebArea", "AXMenu", "AXPopover"]
  /// Roles with possibly huge child lists, where only the visible children matter.
  static let visibleChildren: [String: String] = [
    "AXTable": "AXVisibleRows", "AXOutline": "AXVisibleRows", "AXList": "AXVisibleChildren",
    "AXBrowser": "AXVisibleColumns", "AXGrid": "AXVisibleChildren",
  ]

  init(pid: pid_t, includeWeb: Bool, budget: Double, maxNodes: Int, wanted: Int) {
    self.pid = pid
    self.includeWeb = includeWeb
    self.deadline = Clock.seconds() + budget
    self.maxNodes = maxNodes
    self.wanted = wanted
  }

  struct Node {
    let element: AXUIElement
    let clip: Rect?
    let zone: TargetZone
    let parentRole: String?
  }

  func run() {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    let focusedWindow = AXRead.element(app, kAXFocusedWindowAttribute)
    let roots = AXRead.elements(app, kAXChildrenAttribute)
    // Focused window and open menus first, then the menu bar, then other windows.
    var ordered: [(AXUIElement, TargetZone)] = []
    for r in roots {
      let role = AXRead.string(r, kAXRoleAttribute)
      if let fw = focusedWindow, CFEqual(fw, r) { ordered.append((r, .focusedWindow)) }
      else if role == "AXMenu" { ordered.append((r, .focusedWindow)) }
      else if role == "AXMenuBar" { ordered.append((r, .menuBar)) }
      else { ordered.append((r, .otherWindow)) }
    }
    if let fw = focusedWindow, !roots.contains(where: { CFEqual($0, fw) }) { ordered.append((fw, .focusedWindow)) }
    ordered.sort { $0.1 < $1.1 }

    var stack: [Node] = ordered.reversed().map { Node(element: $0.0, clip: nil, zone: $0.1, parentRole: "AXApplication") }
    while let node = stack.popLast() {
      if Clock.seconds() > deadline { stopReason = "time budget" }
      else if visited >= maxNodes { stopReason = "element limit" }
      else if candidates.count >= wanted { stopReason = "enough targets" }
      if stopReason != nil {
        incomplete = true
        return
      }
      visited += 1
      stack.append(contentsOf: visit(node).reversed())
    }
  }

  /// Records the node if it's a target and returns its children to walk.
  private func visit(_ node: Node) -> [Node] {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(node.element, Self.attributes, [], &values) == .success,
          let v = values as? [AnyObject], v.count == 11 else { return [] }
    guard let role = AXRead.str(v[0]) else { return [] }
    let subrole = AXRead.str(v[1])
    let frame: Rect? = {
      guard let p = AXRead.point(v[7]), let s = AXRead.size(v[8]) else { return nil }
      return Rect(x: p.x, y: p.y, width: s.width, height: s.height)
    }()
    let enabled = (v[9] as? Bool) ?? true

    var clip = node.clip
    if Self.clipping.contains(role), let frame {
      guard let c = clip.map({ frame.intersection($0) }) ?? frame else { return [] } // fully clipped: skip subtree
      clip = c
    }

    let hasPress = RoleMapper.needsActionCheck(role: role) && AXRead.actions(node.element).contains(kAXPressAction as String)
    if let mapped = RoleMapper.map(role: role, subrole: subrole, parentRole: node.parentRole, hasPressAction: hasPress),
       let frame {
      let id = TargetID.make(pid: pid, elementHash: UInt(bitPattern: Int(bitPattern: CFHash(node.element))))
      let needsChildText = [v[2], v[3]].allSatisfy { LabelResolver.clean(AXRead.str($0)) == nil }
      let label = LabelResolver.resolve(
        role: mapped.role, secure: mapped.secure, title: AXRead.str(v[2]), description: AXRead.str(v[3]),
        value: mapped.secure ? nil : AXRead.str(v[4]), help: AXRead.str(v[5]), placeholder: AXRead.str(v[6]),
        childText: needsChildText && !mapped.secure ? childText(v[10]) : nil)
      candidates.append(TargetCandidate(id: id, role: mapped.role, label: label, rect: frame, clip: clip,
                                        secure: mapped.secure, enabled: enabled, zone: node.zone,
                                        order: candidates.count))
      elements[id] = node.element
    }

    if role == "AXWebArea" && !includeWeb { return [] }
    // Text inputs and rows rarely contain further targets worth the time, except rows with controls.
    if role == "AXTextArea" || role == "AXTextField" || role == "AXStaticText" || role == "AXImage" { return [] }
    var children = AXRead.elementArray(v[10])
    if let visibleAttr = Self.visibleChildren[role] {
      let visible = AXRead.elements(node.element, visibleAttr as CFString)
      if !visible.isEmpty { children = visible }
    }
    return children.map { Node(element: $0, clip: clip, zone: node.zone, parentRole: role) }
  }

  private func childText(_ childrenValue: AnyObject) -> String? {
    for child in AXRead.elementArray(childrenValue).prefix(4) {
      if AXRead.string(child, kAXRoleAttribute) == "AXStaticText",
         let text = AXRead.string(child, kAXValueAttribute) ?? AXRead.string(child, kAXTitleAttribute),
         LabelResolver.clean(text) != nil {
        return text
      }
    }
    return nil
  }
}

/// Small typed readers over the AX C API.
enum AXRead {
  static func raw(_ e: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(e, attr as CFString, &value) == .success else { return nil }
    return value
  }
  static func string(_ e: AXUIElement, _ attr: String) -> String? { str(raw(e, attr)) }
  static func element(_ e: AXUIElement, _ attr: String) -> AXUIElement? {
    guard let v = raw(e, attr), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
  }
  static func elements(_ e: AXUIElement, _ attr: CFString) -> [AXUIElement] { elementArray(raw(e, attr as String)) }
  static func elements(_ e: AXUIElement, _ attr: String) -> [AXUIElement] { elementArray(raw(e, attr)) }
  static func elementArray(_ v: AnyObject?) -> [AXUIElement] {
    guard let arr = v as? [AnyObject] else { return [] }
    return arr.compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
  }
  static func str(_ v: AnyObject?) -> String? {
    guard let v, CFGetTypeID(v) == CFStringGetTypeID() else { return nil }
    return v as? String
  }
  static func axValue(_ v: AnyObject?, _ type: AXValueType) -> AXValue? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    let ax = v as! AXValue
    return AXValueGetType(ax) == type ? ax : nil
  }
  static func point(_ v: AnyObject?) -> CGPoint? {
    guard let ax = axValue(v, .cgPoint) else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(ax, .cgPoint, &p) ? p : nil
  }
  static func size(_ v: AnyObject?) -> CGSize? {
    guard let ax = axValue(v, .cgSize) else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(ax, .cgSize, &s) ? s : nil
  }
  static func actions(_ e: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String] else { return [] }
    return list
  }
}
