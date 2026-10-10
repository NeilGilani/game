// agency-native: newline-delimited JSON-RPC 2.0 over stdio. Requests on stdin, responses and event
// notifications on stdout (one JSON object per line), logs on stderr only. Exits when stdin closes.
import AgencyNativeCore
import AppKit

let version = "0.1.0"
let args = CommandLine.arguments.dropFirst()
if args.contains("--version") {
  print("agency-native \(version)")
  exit(0)
}
if args.contains("--help") || args.contains("-h") {
  print(
    """
    agency-native \(version): AGENCY OS macOS helper.
    Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. Methods: \(NativeMethodName.allCases.map(\.rawValue).joined(separator: ", ")).
    Only the AGENCY app's main process should run this. See os/native-macos/README.md.
    """)
  exit(0)
}

signal(SIGPIPE, SIG_IGN)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let platform = MacPlatform(emit: { event in Output.shared.send(RPC.event(event)) })
let server = NativeServer(platform: platform, log: Log.info)

let reader = Thread {
  while let line = readLine(strippingNewline: true) {
    server.handle(line: line, send: Output.shared.send)
  }
  // stdin closed: the app quit or crashed. Finish replies already in flight, then leave.
  server.drain()
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
}
reader.name = "org.agency.native.reader"
reader.start()

DispatchQueue.main.async { platform.start() }
Log.info("ready (pid \(getpid()))")
app.run()
