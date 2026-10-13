import AgencyNativeCore
import EventKit
import Foundation

/// Today's events from the Calendar app, read-only, for My day. Asks for Calendar access the first time (the
/// usage description is in the embedded Info.plist). Never writes, never keeps a copy.
final class CalendarService {
  private let store = EKEventStore()
  private let queue = DispatchQueue(label: "org.agency.native.calendar")

  func today(completion: @escaping (Result<[CalendarEventRecord], CalendarProblem>) -> Void) {
    switch access() {
    case .granted:
      queue.async { completion(.success(self.fetch())) }
    case .denied:
      completion(.failure(.notAllowed))
    case .notDetermined:
      request { granted in
        guard granted else { return completion(.failure(.notAllowed)) }
        self.queue.async { completion(.success(self.fetch())) }
      }
    }
  }

  private enum Access { case granted, denied, notDetermined }

  private func access() -> Access {
    let status = EKEventStore.authorizationStatus(for: .event)
    if status == .notDetermined { return .notDetermined }
    if #available(macOS 14.0, *) {
      return status == .fullAccess ? .granted : .denied
    }
    return status == .authorized ? .granted : .denied
  }

  private func request(_ done: @escaping (Bool) -> Void) {
    if #available(macOS 14.0, *) {
      store.requestFullAccessToEvents { granted, _ in done(granted) }
    } else {
      store.requestAccess(to: .event) { granted, _ in done(granted) }
    }
  }

  private func fetch() -> [CalendarEventRecord] {
    let cal = Calendar.current
    let start = cal.startOfDay(for: Date())
    guard let end = cal.date(byAdding: .day, value: 1, to: start) else { return [] }
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let fmt = DateFormatter()
    fmt.locale = Locale(identifier: "en_US_POSIX")
    fmt.dateFormat = "HH:mm"
    return store.events(matching: predicate).prefix(50).map { e in
      // An event that began yesterday shows at midnight.
      let begins = max(e.startDate ?? start, start)
      return CalendarEventRecord(
        title: e.title ?? "",
        start: fmt.string(from: begins),
        allDay: e.isAllDay,
        location: e.location ?? "",
        calendar: e.calendar?.title ?? ""
      )
    }
  }
}
