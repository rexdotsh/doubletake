---
name: doubletake
description: A/B two builds of a React Native (or native) mobile app on the iOS Simulator or Android Emulator and get a verdict with an interval. Use when asked whether a branch made an app faster, lighter or less janky, to write a mobile bench file, or to put perf evidence in a PR.
---

# doubletake

doubletake runs two builds in alternating pairs and answers with a verdict (`faster`, `slower`, `same (±2%)`, `unclear`, `underpowered (~N pairs needed)`) and an interval. It refuses a metric it cannot measure; a refusal is an answer, never a zero.

## Did my change make it faster?

1. Build both sides as release builds of the same native code: a `.app` for the simulator (`xcodebuild … -configuration Release -sdk iphonesimulator`) or an `.apk`. Debug builds measure Metro and dev tooling, not the app.
2. Write or find a bench file (below). Check it on one build: `doubletake check perf/app.bench.ts --head after.app`.
3. `doubletake bench perf/app.bench.ts --base before.app --head after.app --labels main,branch`.
   - Read the ★ primary first. Secondaries say words only after it decided; `·` is descriptive.
   - `underpowered (~N pairs needed)` means more pairs or a quieter machine, not "no change".
   - Exit 5: some primary undecided. Exit 4: a primary was refused (read why). Exit 6: worse, with `--fail-on-regression`.
4. `doubletake report latest --format md` is the PR card; `--comment <pr>` posts it (with `--video <case>`'s side-by-side attached).

Never put a `check` value or a single launch in a results table: only `bench` verdicts.

## The machine

- Run one bench at a time per machine, and nothing heavy beside it (builds, other simulators, screen recording of something else).
- A Mac over SSH: `--host "ssh mac" --host-init ". ~/env.sh"`; `host:<path>` for builds already there. Everything runs on the Mac; results come back.
- `doubletake status` lists simulators, emulators and tools.

## A bench file

```ts
export default {
  app: { ios: 'com.example.app', android: 'com.example.app' },
  cases: {
    'cold start': { launch: { until: 'mark:home' }, primary: 'launch.ttfd', metrics: ['cpu.time', 'memory.peak'] },
    'cold start, no SDK': { launch: { hold: '8s' }, primary: 'cpu.time', metrics: ['memory.peak'] },
    scroll: { setup: ['launch', { wait: 'mark:home' }], run: [{ scroll: 'down', times: 5 }], primary: 'js.stall' },
    idle: { setup: ['launch', { sleep: '5s' }], idle: '20s', primary: 'cpu.idle', metrics: ['net.requests'] },
  },
};
```

- One of `launch`, `run` or `idle` per case. `setup` is untimed; `run` is timed.
- Steps: `launch`, `terminate`, `{ open }`, `{ wait: 'mark:x' }`, `{ sleep }`, `{ tap }`, `{ swipe }`, `{ scroll }`, `{ maestro: 'flow.yaml' }`, `{ shell }`. iOS taps and swipes go through AXe, Android ones through adb (milliseconds; they do not wait for the screen to settle, so add a `wait` or `sleep`). Android taps by text need Maestro (seconds): keep them in `setup`.
- Unknown keys and metrics fail with the nearest name.

## Picking a primary

- App without the SDK: `cpu.time` (launch to a fixed hold: low noise, sensitive to JS bundle work), `memory.peak`, `launch.visual` (needs a screen that stops moving; `ignore` regions otherwise), `cpu.idle`.
- With the SDK (`import { start, mark } from 'doubletake/sdk'`): `launch.ttfd` to a mark, `js.stall` for scrolls, `net.requests` (exact) for polling.
- Android adds `launch.ttid` (`am start -W`) and `frames.janky` (`gfxinfo`).

## Limits

Simulators and emulators run on the Mac: compare builds, never quote absolute times as a phone's. No UI frame metrics on iOS yet (Instruments). Cold starts are process-cold, not disk-cold.
