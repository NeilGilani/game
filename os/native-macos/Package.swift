// swift-tools-version:6.0
// agency-native: the macOS helper for AGENCY OS (accessibility targets, input, apps, capture, speech).
// Newline-delimited JSON-RPC 2.0 over stdio; see README.md and os/contracts/src/native.ts.
import Foundation
import PackageDescription

// The helper's Info.plist is embedded in the binary so macOS can show usage descriptions for the camera,
// microphone and speech prompts and attribute permissions to org.agency.native.
let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let infoPlist = "\(packageDir)/Support/Info.plist"

let package = Package(
  name: "agency-native",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "agency-native", targets: ["AgencyNative"]),
    .executable(name: "AgencyTestApp", targets: ["AgencyTestApp"]),
    .library(name: "AgencyNativeCore", targets: ["AgencyNativeCore"]),
  ],
  targets: [
    // Platform-independent logic: JSON-RPC, role mapping, filtering, rate limiting, key tables.
    .target(name: "AgencyNativeCore"),
    // macOS glue: Accessibility, CGEvent, NSWorkspace, ScreenCaptureKit, AVFoundation, Speech.
    .executableTarget(
      name: "AgencyNative",
      dependencies: ["AgencyNativeCore"],
      linkerSettings: [
        .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist])
      ]
    ),
    // A tiny app with known buttons and fields for integration tests on macOS runners.
    .executableTarget(name: "AgencyTestApp"),
    .testTarget(name: "AgencyNativeCoreTests", dependencies: ["AgencyNativeCore"]),
  ],
  swiftLanguageModes: [.v5]
)
