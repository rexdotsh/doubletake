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
- The SwiftUI sample in `examples/swiftui-sample` builds without an Xcode project and runs the same bench as the RN sample.

## Planned, in order

1. **Build from source.** `--base git:main --head .` with a build recipe per platform: an Xcode workspace, scheme, configuration and simulator destination, or a Gradle module and variant. Builds are cached by commit and recipe.
2. **Platform harness backends.** Run Jetpack Macrobenchmark and XCTest performance tests (`XCTApplicationLaunchMetric`, `XCTOSSignpostMetric`, `XCTClockMetric`) as the measurement, and use their raw iterations as doubletake's runs: their compilation control and signposts, doubletake's pairing, verdicts and cards.
3. **Traces for attribution, never in timed blocks.** Perfetto (`FrameTimeline`, CPU scheduling) on Android and Instruments (Time Profiler, Hitches) on iOS, recorded in extra blocks after the pairs, as `--video` films them.
4. **FrameMetrics** on Android as a per-frame probe beside `gfxinfo`, and os_signpost intervals in the Swift SDK.
