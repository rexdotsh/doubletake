// doubletake markers for a native iOS app: copy this file into the app target. Each call writes one line,
// `[doubletake] <kind> <ms since 1970> …`, through os_log at the default level, which the simulator's log
// stream shows in release builds. Same protocol as the React Native SDK (src/events.ts in doubletake).
import Foundation
import os

public enum Doubletake {
  private static let log = OSLog(subsystem: "doubletake", category: "marks")

  private static func write(_ line: String) {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    os_log("%{public}@", log: log, type: .default, "[doubletake] \(line.replacingOccurrences(of: "{t}", with: String(now)))")
  }

  /// Call once at launch (no frame or network reporting from native yet: those metrics are refused).
  public static func start() { write("s {t} -") }

  /// Marks a moment, such as the first screen with content: `mark("home")` gives `mark.home`.
  public static func mark(_ name: String) { write("m {t} \(name)") }
}
