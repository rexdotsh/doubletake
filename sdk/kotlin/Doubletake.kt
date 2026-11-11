// doubletake markers for a native Android app: copy this file into the app module. Each call writes one
// logcat line, `[doubletake] <kind> <ms since 1970> …`, with the tag "doubletake". Same protocol as the
// React Native SDK (src/events.ts in doubletake).
package dev.doubletake

import android.util.Log

object Doubletake {
  private fun write(line: String) {
    Log.i("doubletake", "[doubletake] " + line.replace("{t}", System.currentTimeMillis().toString()))
  }

  /** Call once at launch (no frame or network reporting from native yet: those metrics are refused). */
  fun start() = write("s {t} -")

  /** Marks a moment, such as the first screen with content: `mark("home")` gives `mark.home`. */
  fun mark(name: String) = write("m {t} $name")
}
