# doubletake

Did this branch make the app faster? doubletake answers that for React Native apps (and any iOS or Android app that writes its log lines) on the iOS Simulator and the Android Emulator: it installs two builds, runs them in alternating pairs, and gives a verdict with an interval instead of a single number from one launch.

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

## Install

```sh
bun add -d doubletake        # or npm i -D doubletake; the CLI runs on Node 22.18+ or Bun
```

The machine with the simulator or emulator needs Xcode (`xcrun simctl`) or the Android SDK (`adb`), plus `ffmpeg` for video and [Maestro](https://maestro.mobile.dev) for taps and swipes on iOS. `doubletake status` says what it found.

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

Steps: `launch`, `terminate`, `{ open: url }` (deep link), `{ wait: 'mark:name' }`, `{ sleep: '2s' }`, `{ tap: [x, y] | 'text' }`, `{ swipe: { from, to } }`, `{ scroll: 'down', times }`, `{ maestro: 'flow.yaml' }`, `{ shell: '…' }`. Coordinates of 1 or less are fractions of the screen.

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

| Metric                          | Where     | From                                                                                                  |
| ------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `launch.ttid`                   | Android   | `am start -W` TotalTime: the intent to the first frame                                                |
| `launch.ttfd`, `mark.<name>`    | both, SDK | the process start (iOS) or the launch intent (Android) to the mark                                    |
| `launch.visual`                 | both      | a screen recording: the launch to the frame after which the screen stays within 1% of its final image |
| `cpu.time`, `cpu.idle`          | both      | the app process's CPU time over the run, or per second idle                                           |
| `memory.peak`, `memory.end`     | both      | iOS `footprint` (phys_footprint and its peak); Android VmHWM and PSS                                  |
| `frames.janky`, `frames.p90`    | Android   | `dumpsys gfxinfo`, reset before the run                                                               |
| `js.stall`, `js.frames.dropped` | both, SDK | requestAnimationFrame frames that came late: a busy JS thread                                         |
| `net.requests`, `net.bytes`     | both, SDK | finished XMLHttpRequest/fetch requests and response bytes                                             |
| `react.commits`, `react.render` | both, SDK | React Profiler `onRender` (profiling builds only)                                                     |

## How a verdict is made

- Each side gets one discarded warm-up block, then pairs alternate base, head and head, base. A block installs the build (when both share a bundle id), does one discarded run, then 3 measured runs; the block's value is their median.
- Per pair: the log ratio head/base (or the difference for counts and zeros). The change is their mean, with a bootstrap interval (10,000 resamples, expanded percentile for small samples). A direction also needs the Wilcoxon signed-rank test to agree; that keeps A/A false calls under 5% with heavy-tailed noise (6.3% without it, in the test suite's simulations).
- `--pairs auto` (the default) looks at 8, 12, 18, 26 and 40 pairs at 98.42% each (Pocock), and stops at the first verdict. Fewer than 6 pairs never decide.
- Verdicts: `faster`/`slower` (or `less`/`more`, `fewer`/`more`), `same (±2%)`, `unclear`, `underpowered (~N pairs needed)`. Stable counts compare exactly.
- Declared secondaries get words only after the primary decided, at a Bonferroni level; the rest are descriptive (`·`).

## Commands

```
doubletake bench <file> --base <app> --head <app> [--case name] [--pairs auto|N] [--runs N] [--video case]
doubletake check <file> --head <app>                # each case once: does it work, what does it read?
doubletake report [exp|latest] [--format text|md|json] [--comment <pr> [--repo owner/name]]
doubletake status
```

- `<app>` is a `.app` built for the simulator, an `.apk`, or `installed:<bundle id>`.
- `--host "ssh mac" --host-init ". ~/env.sh"` runs the whole bench on that machine: the CLI, the bench folder and the builds go over (builds once per content hash), the experiment comes back. Timestamps never cross SSH. `host:<path>` names a build already there.
- `--video <case>` films one more run per side after the pairs (never a timed one) and puts them side by side with a shared timer.
- `report --format md` is the PR card; `--comment <pr>` posts it with `gh pr comment`, attaching the video.

Experiments live in `~/.doubletake/experiments/<id>/`: `result.json` (strobe-shaped: `id`, `kind`, `variants`, `series[].primary` with `verdict_kind`, `lo`, `hi`, `needed_pairs`), `runs.ndjson` (every run, warm-ups included) and videos.

## What it can't do

- **Simulators and emulators are not phones.** They run on the Mac's CPU and GPU, without thermal limits or a phone's storage. Use them to compare two builds on the same machine, never to quote absolute launch times.
- **iOS UI frames.** Hitches and frame times need Instruments; doubletake does not read them yet, and refuses `frames.*` on iOS. JS frames come from the SDK.
- **Cold starts are process-cold, not disk-cold.** Neither simctl nor an unrooted emulator can drop the OS file cache.
- **JS hotspots in release builds.** Hermes's sampling profiler is not reachable in a release build; profile a dev build instead.
- **Taps on iOS go through Maestro**, which takes seconds to start; keep them in `setup` or measure counts (`js.stall`, `net.requests`), not wall time, across them.
- **Shared CI runners.** Timing verdicts need a machine that runs one bench at a time.

## License

MIT
