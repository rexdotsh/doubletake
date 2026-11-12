# Native apps

doubletake's core does not know React Native. What it knows is a device, a build, a case and a set of observations:

| Layer                                               | Files                                          | Knows RN?       |
| --------------------------------------------------- | ---------------------------------------------- | --------------- |
| Experiment: blocks, ABBA order, looks, verdicts     | `src/experiment.ts`, `src/stats.ts`            | no              |
| Records and reports: `result.json`, text, PR card   | `src/store.ts`, `src/report.ts`                | no              |
| Devices: install, launch, CPU, memory, video, input | `src/ios.ts`, `src/android.ts`                 | no              |
| Cases and steps                                     | `src/run.ts`, `src/flow.ts`                    | no              |
| In-app markers                                      | `sdk/index.ts` (RN), `sdk/swift`, `sdk/kotlin` | the RN SDK only |

The seam is the marker protocol (`src/events.ts`): one log line per event, `[doubletake] <kind> <ms since 1970> …`, read from the simulator's `os_log` stream or from logcat, tagged with the writing process. Any app that writes those lines gets `launch.ttfd`, `mark.*` and the counters it reports.

## What works for a native app today

- Everything that needs no SDK: `cpu.time`, `cpu.idle`, `memory.*`, `launch.visual`, and on Android `launch.ttid` and `frames.*` from `gfxinfo`.
- Marks: copy `sdk/swift/Doubletake.swift` or `sdk/kotlin/Doubletake.kt` into the app and call `Doubletake.mark("home")`.
- Flows: AXe (iOS) and adb (Android) drive any app; existing Maestro flows run as `maestro` steps.
- The SwiftUI sample in `examples/swiftui-sample` builds without an Xcode project; the Jetpack Compose sample in `examples/compose-sample` builds with its Gradle wrapper (`build.sh <out> [SLOW]`). Both run the same kind of bench as the RN sample.

## Measured so far

| Sample                                         | Platform                  | Bench                                                               | Result                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`swiftui-sample`](../examples/swiftui-sample) | iOS Simulator (iPhone 17) | cold start, `launch.ttfd` to `mark("home")`                         | −17.4% [−17.9% … −16.9%], faster, decided at 8 pairs (337 ms; the slow build adds 300 ms plus 4 ms per row-body evaluation)                                                                       |
| [`compose-sample`](../examples/compose-sample) | Android Emulator (API 36) | cold start, `launch.ttfd` to `mark("home")`; scroll, `frames.janky` | cold start −80.5% [−81.4% … −79.3%], faster, decided at 8 pairs (357 ms for a 300 ms wait plus rows); scroll underpowered (4 ms per row composition did not show as janky frames on the emulator) |

## What a mark means

A mark is a log line written when the app calls `mark()`, so it times the code path that calls it, not a frame on the glass. Put it where content is drawn:

- SwiftUI: in `onAppear` of the first view with content, deferred one turn (`DispatchQueue.main.async`) so the layout pass that shows it has run.
- Compose: after `withFrameNanos {}` in a `LaunchedEffect` of the content, so the frame that shows it has been produced.

The samples' "slow" variants busy-wait for a fixed time on the main thread, which is fixed wall time, not fixed CPU work: on a starved machine the same wait does less work. That is one more reason a bench needs a quiet machine; `launch.visual` (from the screen recording) is the cross-check that needs no mark at all.

## Planned, in order

1. **Build from source.** `--base git:main --head .` with a build recipe per platform: an Xcode workspace, scheme, configuration and simulator destination, or a Gradle module and variant. Builds are cached by commit and recipe.
2. **Platform harness backends.** Run Jetpack Macrobenchmark and XCTest performance tests (`XCTApplicationLaunchMetric`, `XCTOSSignpostMetric`, `XCTClockMetric`) as the measurement, and use their raw iterations as doubletake's runs: their compilation control and signposts, doubletake's pairing, verdicts and cards.
3. **Traces for attribution, never in timed blocks.** Perfetto (`FrameTimeline`, CPU scheduling) on Android and Instruments (Time Profiler, Hitches) on iOS, recorded in extra blocks after the pairs, as `--video` films them.
4. **FrameMetrics** on Android as a per-frame probe beside `gfxinfo`, and os_signpost intervals in the Swift SDK.
