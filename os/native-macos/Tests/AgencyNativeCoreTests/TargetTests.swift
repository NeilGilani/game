import Testing
@testable import AgencyNativeCore

@Suite struct RoleMapperTests {
  @Test(arguments: [
    ("AXButton", "button"), ("AXLink", "link"), ("AXTextField", "textfield"), ("AXTextArea", "textfield"),
    ("AXSearchField", "textfield"), ("AXComboBox", "textfield"), ("AXCheckBox", "checkbox"),
    ("AXMenuItem", "menuitem"), ("AXMenuBarItem", "menuitem"), ("AXCell", "cell"), ("AXRow", "row"),
    ("AXPopUpButton", "popup"), ("AXMenuButton", "popup"), ("AXSlider", "slider"), ("AXIncrementor", "stepper"),
    ("AXDisclosureTriangle", "disclosure"), ("AXTab", "tab"),
  ])
  func mapsActionableRoles(ax: String, expected: String) {
    #expect(RoleMapper.map(role: ax, subrole: nil, parentRole: "AXGroup") == MappedRole(expected))
  }

  @Test(arguments: ["AXGroup", "AXStaticText", "AXWindow", "AXWebArea", "AXScrollArea", "AXHeading", "AXScrollBar",
                    "AXValueIndicator", "AXSplitter", "AXUnknown"])
  func ignoresContainersAndText(ax: String) {
    #expect(RoleMapper.map(role: ax, subrole: nil, parentRole: nil) == nil)
  }

  @Test func passwordFieldsAreSecure() {
    #expect(RoleMapper.map(role: "AXSecureTextField", subrole: nil, parentRole: nil) == MappedRole("textfield", secure: true))
    // Chrome and Safari expose web password inputs as text fields with a secure subrole.
    #expect(RoleMapper.map(role: "AXTextField", subrole: "AXSecureTextField", parentRole: nil) == MappedRole("textfield", secure: true))
  }

  @Test func radioButtonsInTabGroupsAreTabs() {
    #expect(RoleMapper.map(role: "AXRadioButton", subrole: nil, parentRole: "AXTabGroup")?.role == "tab")
    #expect(RoleMapper.map(role: "AXRadioButton", subrole: "AXTabButton", parentRole: "AXGroup")?.role == "tab")
    #expect(RoleMapper.map(role: "AXRadioButton", subrole: nil, parentRole: "AXRadioGroup")?.role == "radio")
  }

  @Test func cellsInsideRowsAreNotDuplicated() {
    #expect(RoleMapper.map(role: "AXCell", subrole: nil, parentRole: "AXRow") == nil)
  }

  @Test func imagesOnlyWhenPressable() {
    #expect(RoleMapper.needsActionCheck(role: "AXImage"))
    #expect(!RoleMapper.needsActionCheck(role: "AXButton"))
    #expect(RoleMapper.map(role: "AXImage", subrole: nil, parentRole: nil, hasPressAction: false) == nil)
    #expect(RoleMapper.map(role: "AXImage", subrole: nil, parentRole: nil, hasPressAction: true)?.role == "button")
  }
}

@Suite struct LabelTests {
  func label(role: String = "button", secure: Bool = false, title: String? = nil, description: String? = nil,
             value: String? = nil, help: String? = nil, placeholder: String? = nil, child: String? = nil) -> String {
    LabelResolver.resolve(role: role, secure: secure, title: title, description: description, value: value, help: help,
                          placeholder: placeholder, childText: child)
  }

  @Test func followsPriorityOrder() {
    #expect(label(title: "Save", description: "d", value: "v") == "Save")
    #expect(label(title: "  ", description: "Close window", value: "v") == "Close window")
    #expect(label(value: "Value", help: "Help") == "Value")
    #expect(label(help: "Help", placeholder: "P") == "Help")
    #expect(label(placeholder: "Search") == "Search")
    #expect(label(child: "Child text") == "Child text")
    #expect(label() == "Unlabelled button")
  }

  @Test func textFieldsPreferPlaceholderOverTheirContents() {
    #expect(label(role: "textfield", value: "private draft", placeholder: "To:") == "To:")
    #expect(label(role: "textfield", value: "draft") == "draft")
    #expect(label(role: "textfield") == "Text field")
  }

  @Test func neverUsesSecureValues() {
    #expect(label(role: "textfield", secure: true, value: "hunter2") == "Password field")
    #expect(label(role: "textfield", secure: true, value: "hunter2", placeholder: "Password") == "Password")
    #expect(!label(role: "button", secure: true, value: "hunter2").contains("hunter2"))
  }

  @Test func collapsesWhitespaceAndTruncates() {
    #expect(label(title: "Open\n  the   file") == "Open the file")
    let long = String(repeating: "a", count: 300)
    let l = label(title: long)
    #expect(l.count == LabelResolver.maxLength)
    #expect(l.hasSuffix("…"))
  }
}

@Suite struct SelectorTests {
  let display = Rect(x: 0, y: 0, width: 1440, height: 900)
  func cand(_ id: String, _ r: Rect, clip: Rect? = nil, zone: TargetZone = .focusedWindow, order: Int = 0,
            enabled: Bool = true, secure: Bool = false) -> TargetCandidate {
    TargetCandidate(id: id, role: "button", label: id, rect: r, clip: clip, secure: secure, enabled: enabled,
                    zone: zone, order: order)
  }

  @Test func dropsZeroSizeDisabledAndOffscreen() {
    let r = TargetSelector.select([
      cand("ok", Rect(x: 10, y: 10, width: 100, height: 40)),
      cand("zero", Rect(x: 10, y: 10, width: 0, height: 40)),
      cand("disabled", Rect(x: 10, y: 10, width: 100, height: 40), enabled: false),
      cand("off", Rect(x: 3000, y: 10, width: 100, height: 40)),
      cand("sliver", Rect(x: 1438, y: 10, width: 100, height: 40)),
    ], displays: [display], maxCount: 100, owner: "com.example")
    #expect(r.targets.map(\.id) == ["ok"])
    #expect(r.targets[0].owner == "com.example")
    #expect(!r.truncated)
  }

  @Test func clipsToAncestorsAndDisplays() {
    let scroll = Rect(x: 0, y: 100, width: 500, height: 300)
    let r = TargetSelector.select([
      cand("half", Rect(x: 10, y: 380, width: 100, height: 40), clip: scroll),
      cand("hidden", Rect(x: 10, y: 600, width: 100, height: 40), clip: scroll),
      cand("edge", Rect(x: 1400, y: 10, width: 100, height: 40)),
    ], displays: [display], maxCount: 100, owner: nil)
    #expect(r.targets.map(\.id) == ["half", "edge"])
    #expect(r.targets[0].rect == Rect(x: 10, y: 380, width: 100, height: 20))
    #expect(r.targets[1].rect == Rect(x: 1400, y: 10, width: 40, height: 40))
  }

  @Test func usesTheDisplayWithTheLargestOverlap() {
    let second = Rect(x: 1440, y: 0, width: 1920, height: 1080)
    let r = TargetSelector.select([cand("span", Rect(x: 1400, y: 10, width: 200, height: 40))],
                                  displays: [display, second], maxCount: 10, owner: nil)
    #expect(r.targets[0].rect == Rect(x: 1440, y: 10, width: 160, height: 40))
  }

  @Test func ordersByZoneThenWalkOrderAndCaps() {
    let box = Rect(x: 0, y: 0, width: 50, height: 50)
    let r = TargetSelector.select([
      cand("other", box, zone: .otherWindow, order: 0),
      cand("menu", box, zone: .menuBar, order: 1),
      cand("f2", box, zone: .focusedWindow, order: 3),
      cand("f1", box, zone: .focusedWindow, order: 2),
    ], displays: [display], maxCount: 3, owner: nil)
    #expect(r.targets.map(\.id) == ["f1", "f2", "menu"])
    #expect(r.truncated)
  }

  @Test func deduplicatesIds() {
    let box = Rect(x: 0, y: 0, width: 50, height: 50)
    let r = TargetSelector.select([cand("a", box), cand("a", box)], displays: [display], maxCount: 10, owner: nil)
    #expect(r.targets.count == 1)
  }

  @Test func clampsMaxCount() {
    #expect(TargetSelector.clampMaxCount(nil) == 300)
    #expect(TargetSelector.clampMaxCount(0) == 1)
    #expect(TargetSelector.clampMaxCount(99_999) == 1000)
  }

  @Test func encodesContractShape() {
    let t = NativeTarget(id: "ax-1", rect: Rect(x: 1.234, y: 2, width: 3, height: 4), role: "textfield", label: "Password",
                         owner: "com.x", secure: true)
    #expect(t.json == ["id": "ax-1", "rect": ["x": 1.23, "y": 2, "width": 3, "height": 4], "role": "textfield",
                       "label": "Password", "source": "ax", "owner": "com.x", "secure": true])
    let plain = NativeTarget(id: "b", rect: Rect(x: 0, y: 0, width: 1, height: 1), role: "button", label: "B", owner: nil, secure: false)
    #expect(plain.json["secure"] == nil)
    #expect(plain.json["owner"] == nil)
    let snap = NativeSnapshot(t: 12.7, owner: nil, targets: [plain], truncated: false)
    #expect(snap.json == ["t": 13, "owner": nil, "targets": [plain.json], "truncated": false])
  }

  @Test func idsAreStableAndDistinct() {
    #expect(TargetID.make(pid: 42, elementHash: 99) == TargetID.make(pid: 42, elementHash: 99))
    #expect(TargetID.make(pid: 42, elementHash: 99) != TargetID.make(pid: 43, elementHash: 99))
    #expect(TargetID.make(pid: 42, elementHash: 99) != TargetID.make(pid: 42, elementHash: 98))
    #expect(TargetID.make(pid: 1, elementHash: 1).hasPrefix("ax-"))
  }
}

@Suite struct CacheTests {
  final class FakeClock: @unchecked Sendable { var t = 0.0 }

  func snap(_ n: Int, truncated: Bool = false) -> NativeSnapshot {
    NativeSnapshot(t: 0, owner: "x", targets: (0..<n).map {
      NativeTarget(id: "\($0)", rect: Rect(x: 0, y: 0, width: 10, height: 10), role: "button", label: "", owner: "x", secure: false)
    }, truncated: truncated)
  }

  @Test func hitsUntilTTL() {
    let clock = FakeClock()
    let cache = TargetCache(ttl: 1, now: { clock.t })
    let key = TargetCache.Key(pid: 1, includeWeb: true)
    #expect(cache.get(key, maxCount: 10) == nil)
    cache.put(key, maxCount: 10, snapshot: snap(3))
    #expect(cache.get(key, maxCount: 10)?.targets.count == 3)
    clock.t = 1.5
    #expect(cache.get(key, maxCount: 10) == nil)
  }

  @Test func layoutNotificationsInvalidateButValueChangesDoNot() {
    let cache = TargetCache(ttl: 10, now: { 0 })
    let key = TargetCache.Key(pid: 1, includeWeb: false)
    cache.put(key, maxCount: 10, snapshot: snap(1))
    #expect(!cache.invalidate(pid: 1, notification: "AXValueChanged"))
    #expect(!cache.invalidate(pid: 2, notification: "AXLayoutChanged"))
    #expect(cache.get(key, maxCount: 10) != nil)
    #expect(cache.invalidate(pid: 1, notification: "AXLayoutChanged"))
    #expect(cache.get(key, maxCount: 10) == nil)
  }

  @Test func smallerRequestsAreServedCappedBiggerTruncatedOnesMiss() {
    let cache = TargetCache(ttl: 10, now: { 0 })
    let key = TargetCache.Key(pid: 1, includeWeb: true)
    cache.put(key, maxCount: 5, snapshot: snap(5, truncated: true))
    let small = cache.get(key, maxCount: 2)
    #expect(small?.targets.count == 2 && small?.truncated == true)
    #expect(cache.get(key, maxCount: 50) == nil)
    cache.put(key, maxCount: 5, snapshot: snap(3, truncated: false))
    #expect(cache.get(key, maxCount: 50)?.targets.count == 3)
  }

  @Test func keysSeparateWebAndNonWeb() {
    let cache = TargetCache(ttl: 10, now: { 0 })
    cache.put(.init(pid: 1, includeWeb: true), maxCount: 5, snapshot: snap(1))
    #expect(cache.get(.init(pid: 1, includeWeb: false), maxCount: 5) == nil)
  }
}
