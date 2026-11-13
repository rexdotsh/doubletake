# doubletake

Compare two mobile builds with repeatable journeys, paired measurements, and evidence you can review. React Native first; native apps work through the same log lines today, and native measurement integrations (XCTest metrics, Macrobenchmark, Perfetto) are planned.

doubletake installs two builds on the iOS Simulator or the Android Emulator, runs them in alternating pairs, and gives a verdict with an interval instead of a single number from one launch. It is a runner and a referee, not a profiler: it tells you whether head beat base, by how much, and how sure it is.

Status: demonstrated on the iOS Simulator and the Android Emulator (the Compose sample; a production app's Android bench is still to come). Timing needs a machine nothing else uses while the bench runs (see [Running it](#running-it)). `doubletake bundle`, the exact size of a Metro bundle by package, needs no device at all.

```
$ doubletake bench perf/app.bench.ts --base before.app --head after.app

cold start  ★ launch.ttfd  −19.3% [−21.4% … −17.9%]  faster  (8 pairs, decided at 8 pairs)
    before 1825 ms · after 1492 ms
    cpu.time              2345 ms → 1705 ms    −27.8% [−29.5% … −26.4%]       faster
    memory.peak          35.3 MiB → 38.9 MiB   +10.42% [+10.15% … +10.70%]    more
    js.stall               647 ms → 0.0 ms     −646 ms [−677 ms … −617 ms]    ·
```

That is the [sample app](examples/expo-sample) in this repo on an iPhone 17 simulator: the "before" bundle blocks the JS thread for 300 ms at startup and 4 ms per list row, so the known answer is about 350 ms; doubletake measured 333 ms after 8 pairs.

It is inspired by [strobe](https://github.com/anomalyco/strobe), which does this for web pages, Electron and desktop apps, and borrows its rules: one primary metric declared up front, paired blocks in alternating order, planned looks, refusals instead of made-up numbers, and an experiment record shaped like strobe's `result.json`.

## On a production app

doubletake was tried on a production React Native app (Expo, Hermes, a ~24 MB JS bundle, crypto wallet and payments SDKs, a heavy home feed), comparing main with a stack of startup changes:

- `doubletake bundle` gave the exact change: −0.4 MB (−1.6%), almost all of it one web3 library that had been bundled in two module formats, and listed the libraries still bundled at two or three versions (another ~1.6 MB).
- The first timed bench ran beside another Xcode build on the same Mac (load 94 on 10 cores): its pairs swung by ±12% and could not have been trusted. doubletake now samples the other processes' CPU once a second and refuses an experiment when they hold more than half the cores for 5 s during a block, which is what it did on every later attempt while that machine stayed shared.

- Aligning that library and a schema library to one version each cut another 1.0 MB (−4.1%), again exact.
- With the machine reserved by a host lock, and the bench's own app installs no longer counted as "other" load, the cold start decided at 8 pairs: CPU over the first 8 s **same (±2%)**, −0.8% [−1.9% … +0.6%]; peak memory 7.9% lower.
- An idle check on the logged-out first screen read 0.1–0.17 of a core with nothing happening: a full-screen animated WebP looping forever. Making it play once: `cpu.idle` −54.8% [−57.4% … −51.6%], decided at 8 pairs. A video copy of the same animation saved only 9–15%.

The lesson is the one strobe states first: a number you cannot defend is not a result. A refused bench on a busy machine is an answer.

## Install

```sh
bun add -d doubletake        # or npm i -D doubletake; the CLI runs on Node 22.18+ or Bun
```

The machine with the simulator or emulator needs Xcode (`xcrun simctl`) or the Android SDK (`adb`), plus `ffmpeg` for video, [AXe](https://github.com/cameroncooke/AXe) for taps and swipes on iOS (`brew install cameroncooke/axe/axe`), and [Maestro](https://maestro.mobile.dev) only for `maestro` steps and Android taps on an element. `doubletake status` says what it found.

## A bench file

```ts
// perf/app.bench.ts
export default {
  app: { ios: 'com.example.app', android: 'com.example.app' },
  cases: {
    'cold start': { launch: { until: 'mark:home' }, primary: 'launch.ttfd', metrics: ['cpu.time', 'memory.peak'] },
    'first paint': { launch: { visual: true }, primary: 'launch.visual' },
    'feed scroll': {
      setup: ['launch', { wait: 'mark:home' }],
      run: [{ scroll: 'down', times: 5 }],
      primary: 'js.stall',
    },
    idle: { setup: ['launch', { wait: 'mark:home' }], idle: '20s', primary: 'cpu.idle', metrics: ['net.requests'] },
  },
};
```

A case is one of:

- `launch`: terminate, cold launch, and time to the `until` mark (or record the screen with `visual: true`).
- `run`: untimed `setup` steps, then timed `run` steps.
- `idle`: untimed `setup`, then sit on the screen and measure CPU per second and requests: polling shows up here.

Steps: `launch`, `terminate`, `{ open: url }` (deep link), `{ wait: 'mark:name' }`, `{ sleep: '2s' }`, `{ tap: … }`, `{ swipe: { from, to } }`, `{ scroll: 'down', times }`, `{ maestro: 'flow.yaml' }`, `{ shell: '…' }`.

A tap takes a place or an element:

- `[0.5, 0.8]`: fractions of the screen, 0 to 1. `{ points: [200, 640] }`: points on iOS, dp on Android.
- `'Buy'` or `{ label: 'Buy' }`: the element with exactly that accessibility label (text on Android). `{ id: 'pack-card' }`: the element with that test ID.
- `index` picks one of several matches, from 0: `{ id: 'pack-card', index: 2 }`. On iOS it counts top to bottom, then left to right; on Android, in Maestro's order.

On iOS, an `open` step accepts the system's "Open in …?" prompt; it reads the screen until the prompt is answered or an app is in front (about half a second, 3 s at most), which counts in a timed run. Other system prompts (tracking, notifications) cover the app until answered: list the buttons to tap in the bench's `alerts`, such as `alerts: ['Ask App Not to Track', 'Allow']`, and doubletake answers them before each tap or swipe.

## In the app (optional)

```ts
// index.ts
import { start, mark } from 'doubletake/sdk';
start(); // late JS frames and finished requests, each written when it happens

// when the first screen has content
mark('home');
```

The SDK has no dependencies and no timers: each event is one log line written when it happens (`[doubletake] m <time> home`). Native apps can write the same lines with `os_log` or `android.util.Log` and get the same metrics.

## Metrics

| Metric                          | Where     | From                                                                                                                                                                                 |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `launch.ttid`                   | Android   | `am start -W` TotalTime: the intent to the first frame                                                                                                                               |
| `launch.ttfd`, `mark.<name>`    | both, SDK | the process start (iOS) or the launch intent (Android) to the mark                                                                                                                   |
| `launch.visual`                 | both      | a screen recording: the launch (iOS) or its first visible change (Android, whose recorder has no start clock) to the frame after which the screen stays within 1% of its final image |
| `cpu.time`, `cpu.idle`          | both      | the app process's CPU time over the run, or per second idle                                                                                                                          |
| `memory.peak`, `memory.end`     | both      | iOS `footprint` (phys_footprint and its peak); Android VmHWM and PSS                                                                                                                 |
| `frames.janky`, `frames.p90`    | Android   | `dumpsys gfxinfo`, reset before the run                                                                                                                                              |
| `js.stall`, `js.frames.dropped` | both, SDK | requestAnimationFrame frames that came late: a busy JS thread                                                                                                                        |
| `net.requests`, `net.bytes`     | both, SDK | finished XMLHttpRequest/fetch requests and response bytes                                                                                                                            |
| `react.commits`, `react.render` | both, SDK | React Profiler `onRender` (profiling builds only)                                                                                                                                    |

## How a verdict is made

- Each side gets one discarded warm-up block, then pairs alternate base, head and head, base. A block installs the build (when both share a bundle id), does one discarded run, then 3 measured runs; the block's value is their median.
- Per pair: the log ratio head/base (or the difference for counts and zeros). The change is their mean, with a bootstrap interval (10,000 resamples, expanded percentile for small samples). A direction also needs the Wilcoxon signed-rank test to agree. In 2,000 simulated A/A experiments per row (fixed 6 to 20 pairs, normal and t3 noise at σ 3%) that gate brought false calls from up to 6.4% down to 2.6–4.3%; the sequential looks are simulated in the test suite too. This is checked by simulation, not proven: say so when you quote a borderline result.
- `--pairs auto` (the default) looks at 8, 12, 18, 26 and 40 pairs at 98.42% each (Pocock), and stops at the first verdict. Fewer than 6 pairs never decide.
- Verdicts: `faster`/`slower` (or `less`/`more`, `fewer`/`more`), `same (±2%)`, `unclear`, `underpowered (~N pairs needed)`. A count that every run read the same compares exactly.
- Declared secondaries get words only after the primary decided, at a Bonferroni level; the rest are descriptive (`·`).

## Commands

```
doubletake bench <file> --base <app> --head <app> [--case name] [--pairs auto|N] [--runs N] [--video case]
doubletake check <file> --head <app>                # each case once: does it work, what does it read?
doubletake bundle <js> <map> [<base js> <base map>]  # what a Metro bundle ships, by package; with a base, the change
doubletake report [exp|latest] [--format text|md|json] [--comment <pr> [--repo owner/name]]
doubletake status
doubletake mcp                                      # the same commands as MCP tools (stdio)
```

Exit codes: 0 done, 1 error, 4 a primary was refused, 5 not every primary decided, 6 a primary got worse (with `--fail-on-regression`).

- `<app>` is a `.app` built for the simulator, an `.apk`, or `installed:<bundle id>`.
- `--host "ssh mac" --host-init ". ~/env.sh"` runs the whole bench on that machine: the CLI, the bench folder and the builds go over (builds once per content hash), the experiment comes back. Timestamps never cross SSH. `host:<path>` names a build already there.
- `--queue <duration>`: how long the whole bench may wait for a quiet host (30 minutes by default).
- `--side-by-side` (iOS) installs both builds as copies under `<bundle id>.doubletakebase` and `.doubletakehead`, ad-hoc signed without entitlements; both copies are uninstalled first, so each experiment starts from empty containers, and no block reinstalls. Apps with extensions and benches with deep links are refused (both copies claim the same URL schemes).
- `--video <case>` films one more run per side after the pairs (never a timed one) and puts them side by side with a shared timer.
- `report --format md` is the PR card; `--comment <pr>` posts it with `gh pr comment`, attaching the video.

Experiments live in `~/.doubletake/experiments/<id>/`: `result.json` (strobe-shaped: `id`, `kind`, `variants`, `series[].primary` with `verdict_kind`, `lo`, `hi`, `needed_pairs`), `runs.ndjson` (every run, warm-ups included), `blocks.ndjson` (other processes' CPU during each measured block, failed ones included: mean and busiest 5 s, each with the three programs that used the most in it, in cores) and videos.

## Where it fits

- [Reassure](https://github.com/callstack/reassure) catches component render regressions in Jest; doubletake measures the whole app on a simulator. Use both.
- [Flashlight](https://github.com/bamlab/flashlight) scores Android app performance (RN or native) on a device; doubletake A/Bs two builds on iOS and Android with a verdict.
- [Jetpack Macrobenchmark](https://developer.android.com/topic/performance/benchmarking/macrobenchmark-overview) and XCTest's [`XCTApplicationLaunchMetric`](https://developer.apple.com/documentation/xctest/xctapplicationlaunchmetric) are the platforms' own measurement harnesses, with compilation control and signposts. doubletake does not replace them; reading their raw iterations as a backend is planned.
- [strobe](https://github.com/anomalyco/strobe) is the same idea for web pages, Electron and desktop apps.

## Native apps

Swift and Kotlin apps get the same runs and verdicts: copy [`sdk/swift/Doubletake.swift`](sdk/swift/Doubletake.swift) or [`sdk/kotlin/Doubletake.kt`](sdk/kotlin/Doubletake.kt) into the app for marks, or use the metrics that need no SDK. [`examples/swiftui-sample`](examples/swiftui-sample) builds a SwiftUI app without an Xcode project and benches it:

```
cold start  ★ launch.ttfd  −17.4% [−17.9% … −16.9%]  faster  (8 pairs, decided at 8 pairs)
    slow 1939 ms · fast 1602 ms
    cpu.time              2883 ms → 2550 ms    −11.57% [−11.99% … −11.01%]    faster
```

The "slow" build blocks the main thread for 300 ms before showing content, plus 4 ms each time a row's body is evaluated; the measured launch-time reduction is 337 ms (iPhone 17 simulator, marks from `sdk/swift`). The [Jetpack Compose sample](examples/compose-sample), on the Android Emulator with marks from `sdk/kotlin`:

```
cold start  ★ launch.ttfd  −80.5% [−81.4% … −79.3%]  faster  (8 pairs, decided at 8 pairs)
    slow 442 ms · fast 85.0 ms
    cpu.time               400 ms → 60.0 ms    −84.0% [−85.1% … −82.5%]       faster
```

Its scroll case did not decide (`frames.janky` 6 → 6 per 4 flings, underpowered): the slow rows' 4 ms did not turn into janky frames there. What both samples measure, and what a mark times: [docs/native.md](docs/native.md). What is planned (build from source, Macrobenchmark and XCTest metrics as backends, Perfetto and Instruments for attribution): [docs/native.md](docs/native.md).

## Running it

Timed results are only as good as the machine is quiet. doubletake measures the other processes' CPU once a second and refuses a bench rather than report a number taken next to a build. On a shared machine, reserve it for the whole bench by wrapping the command in the host's own lock, for example `flock /tmp/mac.lock doubletake bench …`, and have builds and other benches take the same lock. `--queue 2h` lets a bench wait longer for a quiet host before it gives up (exit 4).

## What it can't do

- **Android is new.** The emulator target is implemented and its parsers are tested, but it has not yet run a full bench end to end; the numbers above are from the iOS Simulator.

- **A busy host.** doubletake reads every other process's CPU time once a second (its own processes and the device's simulator or emulator excluded). Before a block it waits up to 30 minutes for them to use under half the cores; when they hold more than half the cores for 5 s during a block, the experiment is refused (a rerun of one side would give it launches its pair-mate never had). Processes that start and end within one second are not seen: run one bench per machine and nothing heavy beside it.

- **Simulators and emulators are not phones.** They run on the Mac's CPU and GPU, without thermal limits or a phone's storage. Use them to compare two builds on the same machine, never to quote absolute launch times.
- **iOS UI frames.** Hitches and frame times need Instruments; doubletake does not read them yet, and refuses `frames.*` on iOS. JS frames come from the SDK.
- **Cold starts are process-cold, not disk-cold.** Neither simctl nor an unrooted emulator can drop the OS file cache.
- **JS hotspots in release builds.** Hermes's sampling profiler is not reachable in a release build; profile a dev build instead.
- **Input does not wait for the screen to settle.** iOS taps and swipes go through [AXe](https://github.com/cameroncooke/AXe) and Android ones through `adb input`, in milliseconds each, and return when the gesture ends: follow them with a `wait` (a mark) or a `sleep` where the run must include what they start. An element tap waits up to 10 s for its element. On Android it goes through Maestro, which takes seconds to start, so keep element taps in `setup`; with `alerts`, each iOS input batch first reads the accessibility tree (a fraction of a second).
- **Shared CI runners.** Timing verdicts need a machine that runs one bench at a time.

## License

MIT
