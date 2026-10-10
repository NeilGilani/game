import Foundation

/// AppInfo from os/contracts/src/native.ts.
public struct AppRecord: Equatable, Sendable {
  public var bundleId: String
  public var name: String
  public var path: String
  public var running: Bool
  public var frontmost: Bool
  public var iconPng: String?

  public init(bundleId: String, name: String, path: String, running: Bool = false, frontmost: Bool = false,
              iconPng: String? = nil) {
    self.bundleId = bundleId
    self.name = name
    self.path = path
    self.running = running
    self.frontmost = frontmost
    self.iconPng = iconPng
  }

  public var json: JSONValue {
    var o: [String: JSONValue] = [
      "bundleId": .string(bundleId), "name": .string(name), "path": .string(path), "running": .bool(running),
      "frontmost": .bool(frontmost),
    ]
    if let iconPng { o["iconPng"] = .string(iconPng) }
    return .object(o)
  }
}

public enum AppCatalog {
  /// Installed apps plus running ones (which may live outside the scanned folders), one entry per bundle id,
  /// sorted by name. Running entries win for path; frontmost is marked.
  public static func merge(installed: [AppRecord], running: [AppRecord], frontmostBundleId: String?) -> [AppRecord] {
    var byId: [String: AppRecord] = [:]
    for app in installed where !app.bundleId.isEmpty {
      if byId[app.bundleId] == nil { byId[app.bundleId] = app }
    }
    for app in running where !app.bundleId.isEmpty {
      var merged = byId[app.bundleId] ?? app
      merged.running = true
      if merged.path.isEmpty { merged.path = app.path }
      byId[app.bundleId] = merged
    }
    for (id, var app) in byId {
      app.frontmost = id == frontmostBundleId
      byId[id] = app
    }
    return byId.values.sorted {
      let c = $0.name.localizedCaseInsensitiveCompare($1.name)
      return c == .orderedSame ? $0.bundleId < $1.bundleId : c == .orderedAscending
    }
  }

  /// Display name from an app bundle path: "/Applications/Google Chrome.app" -> "Google Chrome".
  public static func displayName(forPath path: String) -> String {
    let last = (path as NSString).lastPathComponent
    return last.hasSuffix(".app") ? String(last.dropLast(4)) : last
  }
}
