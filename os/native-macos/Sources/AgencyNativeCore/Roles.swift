import Foundation

/// A contract role ("button", "link", ...) plus whether the element is a password field.
public struct MappedRole: Equatable, Sendable {
  public let role: String
  public let secure: Bool
  public init(_ role: String, secure: Bool = false) {
    self.role = role
    self.secure = secure
  }
}

/// Maps macOS accessibility roles to the target roles in os/contracts/src/targets.ts.
/// Containers and plain text return nil: they are walked into but are not targets themselves.
public enum RoleMapper {
  static let direct: [String: String] = [
    "AXButton": "button",
    "AXMenuButton": "popup",
    "AXPopUpButton": "popup",
    "AXColorWell": "button",
    "AXLink": "link",
    "AXTextField": "textfield",
    "AXTextArea": "textfield",
    "AXSearchField": "textfield",
    "AXComboBox": "textfield",
    "AXCheckBox": "checkbox",
    "AXMenuItem": "menuitem",
    "AXMenuBarItem": "menuitem",
    "AXTab": "tab",
    "AXCell": "cell",
    "AXRow": "row",
    "AXSlider": "slider",
    "AXIncrementor": "stepper",
    "AXDisclosureTriangle": "disclosure",
    "AXDockItem": "button",
  ]

  /// Roles that are only targets when they expose AXPress (checked by the walker, since it costs a call).
  static let pressOnly: [String: String] = ["AXImage": "button"]

  /// Containers the walker must descend into but never treat as targets.
  public static let containers: Set<String> = [
    "AXApplication", "AXWindow", "AXSheet", "AXDrawer", "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea",
    "AXTabGroup", "AXToolbar", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXGrid", "AXRadioGroup",
    "AXMenuBar", "AXMenu", "AXWebArea", "AXSegmentedControl", "AXPopover", "AXDialog", "AXUnknown",
  ]

  /// True when the walker should ask for the element's action names before mapping.
  public static func needsActionCheck(role: String) -> Bool { pressOnly[role] != nil }

  public static func isSecure(role: String, subrole: String?) -> Bool {
    role == "AXSecureTextField" || subrole == "AXSecureTextField"
  }

  public static func map(role: String, subrole: String?, parentRole: String?, hasPressAction: Bool = false)
    -> MappedRole?
  {
    if isSecure(role: role, subrole: subrole) { return MappedRole("textfield", secure: true) }
    if role == "AXRadioButton" {
      return MappedRole(parentRole == "AXTabGroup" || subrole == "AXTabButton" ? "tab" : "radio")
    }
    if role == "AXCheckBox" && subrole == "AXSwitch" { return MappedRole("checkbox") }
    // Cells inside rows are covered by the row target; don't double up.
    if role == "AXCell" && parentRole == "AXRow" { return nil }
    if let r = direct[role] { return MappedRole(r) }
    if let r = pressOnly[role], hasPressAction { return MappedRole(r) }
    return nil
  }
}

/// Picks the accessible name shown in pickers and read aloud.
public enum LabelResolver {
  public static let maxLength = 120

  /// Order: title, description, value (never for secure fields; after the placeholder for text fields,
  /// whose value is the person's own text), help, placeholder, child static text, then a role fallback.
  public static func resolve(
    role: String, secure: Bool, title: String?, description: String?, value: String?, help: String?,
    placeholder: String?, childText: String?
  ) -> String {
    var order: [String?] = [title, description]
    if role == "textfield" {
      order += [placeholder, help]
      if !secure { order.append(value) }
    } else {
      if !secure { order.append(value) }
      order += [help, placeholder]
    }
    order.append(childText)
    for candidate in order {
      if let c = clean(candidate) { return c }
    }
    return fallback(role: role, secure: secure)
  }

  public static func clean(_ s: String?) -> String? {
    guard let s else { return nil }
    let collapsed = s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    if collapsed.isEmpty { return nil }
    if collapsed.count <= maxLength { return collapsed }
    return String(collapsed.prefix(maxLength - 1)) + "…"
  }

  public static func fallback(role: String, secure: Bool) -> String {
    if secure { return "Password field" }
    switch role {
    case "textfield": return "Text field"
    case "menuitem": return "Menu item"
    case "popup": return "Pop-up menu"
    default: return "Unlabelled \(role)"
    }
  }
}
