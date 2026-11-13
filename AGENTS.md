# AGENTS.md

doubletake measures React Native apps on the iOS Simulator and the Android Emulator and answers "is head faster than base?" with paired runs, an interval and a verdict. It is a CLI (with an MCP server) that agents drive, plus a tiny SDK the app under test can import to mark moments and count frames, requests and renders.

## Commands

Bun is the only package manager and script runner. Never use npm, pnpm or yarn. Formatting is oxfmt and linting is oxlint; do not add Prettier, ESLint or editor config files.

| Task                     | Command            |
| ------------------------ | ------------------ |
| Install                  | `bun install`      |
| Format                   | `bun run fmt`      |
| Lint (type-aware oxlint) | `bun run lint`     |
| Unused code and deps     | `bun run knip`     |
| Typecheck (tsgo)         | `bun run check`    |
| Test                     | `bun run test`     |
| Build `dist/`            | `bun run build`    |
| Run from source          | `bun src/cli.ts …` |

`bun run fmt:check`, `bun run lint`, `bun run knip`, `bun run check`, `bun run test` and `bun run build` must all pass before every push. CI runs the same steps.

## Layout

```
src/cli.ts       commands and flags
src/ios.ts       the iOS Simulator: simctl, log stream, footprint, recordVideo
src/android.ts   the Android Emulator or a device: adb, am start -W, gfxinfo, meminfo, logcat, screenrecord
src/run.ts       one run of a case on a device, to metric values
src/experiment.ts  blocks, pairs, order, stopping
src/stats.ts     paired differences, bootstrap interval, signed-rank p, verdicts, pairs needed
src/report.ts    terminal text, markdown and the PR card
src/probe.ts     the app probe's counts per window (renders, requests); cdp.ts and bridge.ts are its transports
src/remote.ts    --host: ship the CLI and artifacts over SSH, run there, fetch the result
src/profile/     --profile: recorders, Hermes/simpleperf/sample parsers, symbolication, diff, flame graph
sdk/             the in-app SDK (zero dependencies, runs in Hermes)
skill/           the agent skill
test/            bun tests
```

## Invariants

- **Valid or nothing.** A number doubletake cannot defend is not printed. A metric a platform cannot give is refused with a reason (`NotOnThisPlatform`, `NoSdk`, `NoMarker`), never a zero or a guess.
- **Measure on the machine with the device.** With `--host`, the whole bench runs on that host; SSH never sits between a launch and its timestamps.
- **Timing and filming never share a block.** A filmed side-by-side comes from extra blocks after the timed pairs. A case whose primary is a visual metric records every run on both sides and says so.
- **Pairs alternate** base, head, then head, base, after one discarded warm-up block per side, so drift and warm caches hit both sides alike.
- **One primary per case**, declared before the run. Secondaries get verdict words only after the primary decided, with Holm correction.
- **Generic.** No product's names, ids, paths or quirks in code, docs or tests. They belong in the app's own bench file.
- Zero runtime dependencies. Node built-ins only in `src/`, no `Bun.*` at runtime (the CLI runs on Node 22.18+ on the device host); the SDK uses only what Hermes has.

## Code standards

- Comments are rare: only a non-obvious why (a platform quirk, a statistical choice).
- No duplication, no speculative abstraction, no pass-through wrappers.
- No `any`, no non-null assertions, validate untrusted input once at the edge (bench files, tool output).
- Fail loudly. Expected failures are refusals with a reason; unexpected ones throw.
- Small focused files: 300 lines is a prompt to split.

## Testing

Test what would mislead a user: statistics (A/A false positives, interval coverage, verdict rules), parsers of tool output (gfxinfo, meminfo, `am start -W`, log lines), bench file validation and the card. Never test what needs a device; verify that on a real simulator or emulator and say how in the PR.

## Privacy

This repository is public. It must never contain anything that identifies a person, a device, a lab or a private app: no hostnames, IPs, bundle ids of private apps, tokens or account names. Results quoted in the README name only public software; a private app is described generically ("a production React Native app: Expo, Hermes, a 24 MB bundle").

`bun scripts/check-terms.ts` (CI, and the pre-push hook after `git config core.hooksPath scripts/hooks`) fails on terms this repo must not name, in tracked files, commit messages and ref names. The terms are stored as hashes; ask the owner for the list.

## Workflow

- Conventional Commits for every commit and PR title (`feat(ios): …`, `fix(stats): …`, `docs: …`).
- Features land as PRs, reviewed by an independent agent before a squash merge; docs and small fixes may go straight to `main` once every check passes.
