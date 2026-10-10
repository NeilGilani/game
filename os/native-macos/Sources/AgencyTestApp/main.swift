// A tiny app with known controls for agency-native integration tests on macOS runners: buttons "Alpha",
// "Beta" and "Gamma", a text field and a password field. Every press prints "pressed: <name>" on stdout so a
// test can check that ax.press reached the right button. AppKit rather than SwiftUI because SwiftUI's macros
// need a full Xcode, and this must build with Command Line Tools too.
import AppKit

final class TestAppDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  let status = NSTextField(labelWithString: "Last pressed: none")

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 520, height: 360),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "AGENCY Test App"

    let buttons = ["Alpha", "Beta", "Gamma"].map { name -> NSButton in
      let b = NSButton(title: name, target: self, action: #selector(pressed(_:)))
      b.bezelStyle = .rounded
      b.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
      b.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
      return b
    }
    let row = NSStackView(views: buttons)
    row.spacing = 24

    let text = NSTextField(string: "")
    text.placeholderString = "Message"
    let secret = NSSecureTextField(string: "")
    secret.placeholderString = "Password"
    for f in [text, secret] { f.widthAnchor.constraint(equalToConstant: 320).isActive = true }

    let stack = NSStackView(views: [row, text, secret, status])
    stack.orientation = .vertical
    stack.spacing = 24
    stack.edgeInsets = NSEdgeInsets(top: 40, left: 40, bottom: 40, right: 40)
    window.contentView = stack
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    print("ready")
    fflush(stdout)
  }

  @objc func pressed(_ sender: NSButton) {
    status.stringValue = "Last pressed: \(sender.title)"
    print("pressed: \(sender.title)")
    fflush(stdout)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = TestAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
