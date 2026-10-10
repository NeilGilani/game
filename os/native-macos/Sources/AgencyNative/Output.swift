import Foundation

/// stdout carries protocol lines only, written whole and in order from any thread.
final class Output: @unchecked Sendable {
  static let shared = Output()
  private let lock = NSLock()

  func send(_ line: String) {
    let data = Data((line + "\n").utf8)
    lock.lock()
    FileHandle.standardOutput.write(data)
    lock.unlock()
  }
}

/// Logs go to stderr. Never pass typed text, transcripts or labels of password fields here.
enum Log {
  static func info(_ message: String) {
    FileHandle.standardError.write(Data("agency-native: \(message)\n".utf8))
  }
}
