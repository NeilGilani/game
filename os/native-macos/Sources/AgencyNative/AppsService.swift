import AgencyNativeCore
import AppKit

/// Installed and running apps, launch, activate and hide. There is no quit: that goes through the agent's
/// approval.
final class AppsService: @unchecked Sendable {
  static let folders: [String] = [
    "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
    (NSHomeDirectory() as NSString).appendingPathComponent("Applications"),
  ]
  private var iconCache: [String: String] = [:]
  private let lock = NSLock()

  func record(for app: NSRunningApplication, frontmost: Bool) -> AppRecord {
    AppRecord(bundleId: app.bundleIdentifier ?? "", name: app.localizedName ?? "App", path: app.bundleURL?.path ?? "",
              running: true, frontmost: frontmost)
  }

  func list(includeIcons: Bool) -> [AppRecord] {
    var installed: [AppRecord] = []
    let fm = FileManager.default
    for folder in Self.folders {
      guard let items = try? fm.contentsOfDirectory(atPath: folder) else { continue }
      for item in items where item.hasSuffix(".app") {
        let path = (folder as NSString).appendingPathComponent(item)
        guard let bundle = Bundle(path: path), let id = bundle.bundleIdentifier else { continue }
        let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
          ?? AppCatalog.displayName(forPath: path)
        installed.append(AppRecord(bundleId: id, name: name, path: path))
      }
    }
    let running = NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular }
      .map { record(for: $0, frontmost: false) }
    var apps = AppCatalog.merge(installed: installed, running: running,
                                frontmostBundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
    if includeIcons {
      for i in apps.indices where !apps[i].path.isEmpty { apps[i].iconPng = icon(path: apps[i].path) }
    }
    return apps
  }

  /// 32x32 PNG (64 px backing for Retina sharpness is not needed at Home's tile size), base64, cached by path.
  func icon(path: String, side: Int = 32) -> String? {
    lock.lock()
    if let cached = iconCache[path] { lock.unlock(); return cached }
    lock.unlock()
    let image = NSWorkspace.shared.icon(forFile: path)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0),
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    let b64 = png.base64EncodedString()
    lock.lock(); iconCache[path] = b64; lock.unlock()
    return b64
  }

  func launch(_ bundleId: String, _ completion: @escaping (Result<Void, RPCError>) -> Void) {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
      completion(.failure(.notFound("That app isn't installed on this Mac.")))
      return
    }
    NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
      if let error { completion(.failure(.internalError("couldn't open the app: \(error.localizedDescription)"))) }
      else { completion(.success(())) }
    }
  }

  func activate(_ bundleId: String) -> Bool {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return false }
    if #available(macOS 14.0, *) { return app.activate() }
    return app.activate(options: [])
  }

  func hide(_ bundleId: String) -> Bool {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return false }
    return app.hide()
  }
}
