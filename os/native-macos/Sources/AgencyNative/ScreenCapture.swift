import AgencyNativeCore
import AppKit
import ScreenCaptureKit

/// One downscaled screenshot for the agent, encoded in memory. Nothing is ever written to disk.
enum ScreenCapture {
  static func capture(displayId: Int?, maxWidth: Int?, format: String,
                      completion: @escaping (Result<CaptureResult, RPCError>) -> Void) {
    guard #available(macOS 14.0, *) else {
      completion(.failure(.unsupported("Screen capture needs macOS 14 or later.")))
      return
    }
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let wanted = displayId.map { CGDirectDisplayID($0) } ?? CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == wanted }) ?? (displayId == nil ? content.displays.first : nil)
        else {
          completion(.failure(.notFound("That display isn't connected.")))
          return
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let size = CaptureMath.outputSize(pointsWidth: Double(display.width), pointsHeight: Double(display.height),
                                          pixelScale: Double(filter.pointPixelScale), maxWidth: maxWidth)
        let config = SCStreamConfiguration()
        config.width = size.width
        config.height = size.height
        config.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let rep = NSBitmapImageRep(cgImage: image)
        let data = format == "png"
          ? rep.representation(using: .png, properties: [:])
          : rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7])
        guard let data else {
          completion(.failure(.internalError("couldn't encode the screenshot")))
          return
        }
        completion(.success(CaptureResult(data: data.base64EncodedString(), width: image.width, height: image.height,
                                          scale: size.scale, format: format)))
      } catch {
        if !CGPreflightScreenCaptureAccess() {
          completion(.failure(.permissionMissing(.screenRecording)))
        } else {
          completion(.failure(.internalError("screen capture failed: \(error.localizedDescription)")))
        }
      }
    }
  }
}
