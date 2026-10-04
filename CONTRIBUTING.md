# Contributing

Agent Lookout has one maintainer. Bug reports, fixes and adapters for other agent tools are welcome. For anything larger than a fix, open an issue first so the approach is agreed before you write it.

## Two rules

Agent Lookout itself sends nothing anywhere. Its code makes no network request to anything but its own local server. That rules out telemetry, analytics, remote fonts, update checks and CDN links, and it covers dependencies as well as your own code. Claude Code's own listing command, which the Claude Code adapter runs, may contact Anthropic the way Claude Code normally does. That is why the adapter runs it seldom.

No invented data. The dashboard shows what the collector measured, or an honest loading, empty or error state. Sample sessions, placeholder numbers and demo modes stay out of the product. Fixtures exist only under `tests/`.

A pull request that breaks either rule will not be merged.

## Set up

You need Node.js 20.19 or newer and, to see real sessions, Claude Code or Codex. `.nvmrc` holds 22, the version most CI jobs use.

Fork the repository, clone your fork, then:

```sh
cd agent-lookout
npm install
npx playwright install chromium
npm run dev
```

The Playwright step downloads the Chromium build that the component tests run in. On Linux, add `--with-deps` to install the system libraries it needs.

`npm run dev` serves the dashboard at <http://localhost:5173> with the collector running inside the dev server. It shows the Claude Code and Codex sessions on your own machine.

To see the dashboard with no sessions, point it away from your own. Set both `AGENT_LOOKOUT_CLAUDE_HOME` and `AGENT_LOOKOUT_CODEX_HOME` to an empty folder:

```sh
mkdir -p /tmp/lookout-empty
AGENT_LOOKOUT_CLAUDE_HOME=/tmp/lookout-empty AGENT_LOOKOUT_CODEX_HOME=/tmp/lookout-empty npm run dev
```

That shows the empty state. With both set, Agent Lookout reads only that folder, does not run the `claude` command and does not read `~/.codex`. Set only the first on a machine with Codex and your Codex sessions still appear, so do not take a screenshot that way.

## Checks

Run this before you open a pull request:

```sh
npm run check
```

It runs the layout check, the typecheck, the linter, the format check and the tests in that order, and stops at the first failure. CI runs the same five and `npm run build`. Most format and lint failures are fixed by `npm run format` and `npm run lint:fix`.

The layout check is `scripts/check-layout.mjs`. It fails, and says where the file belongs, if a test file is outside `tests/`, names no module at its mirrored path or has the wrong ending for that module; if a file in `tests/unit/`, `tests/integration/` or `tests/component/` is not a test; if anything under `src/` is test material, such as a fixture, a mock, a snapshot or a test helper, or sits in a folder named for one; or if a file under `src/` imports from `tests/` or from a test library.

A change in behaviour comes with a test.

## Tests

Every test lives under `tests/`, in one of three groups. The folder decides how a test is run.

| Command                    | Runs                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `npm test`                 | All three groups                                                                             |
| `npm run test:unit`        | `tests/unit/`: one module at a time, in Node, with no sockets, child processes or real files |
| `npm run test:integration` | `tests/integration/`: real sockets, servers, child processes and files, in Node              |
| `npm run test:component`   | `tests/component/`: React components rendered in headless Chromium                           |
| `npm run test:watch`       | All three groups, again after each edit                                                      |

A test that only calls functions goes in `tests/unit/`, even when the module would touch files or start programs if it were not handed stand-ins. It goes in `tests/integration/` as soon as it needs something real from the operating system.

A test file is named for a module that exists, and sits at that module's path, with `tests/<group>/` in place of `src/`. It ends in `.test.tsx` when the module is a `.tsx` file and in `.test.ts` otherwise. The test of `src/core/diff.ts` is `tests/unit/core/diff.test.ts`, and the test of `src/dashboard/styles/index.css` is `tests/component/dashboard/styles/index.test.ts`. Two sets of tests of one module in one group are two `describe` blocks in one file.

No test reads the project's `dist/` folder, so the counts are the same whether or not `npm run build` has been run. The standalone server is tested by calling `runStandalone` in `src/collector/hosts/standalone.ts` against a temporary folder.

One block in `tests/integration/collector/adapters/claude-code/feed.test.ts` runs the real `claude` binary. It is skipped unless `AGENT_LOOKOUT_CHECK_REAL_CLAUDE=1` is set, and runs on macOS only. Run it after a Claude Code update, or after changing how the command is started.

[tests/README.md](tests/README.md) says what belongs in each group, how to run the check against the real `claude` and how fixtures are written.

## Layout

| Folder                 | Holds                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/core/`            | Logic with no DOM and no Node APIs: the session model, status mapping, staleness, snapshot diffing                     |
| `src/collector/`       | Node code: one adapter per agent tool under `adapters/`, the poller, the event and history stores, the request handler |
| `src/collector/hosts/` | The two things that mount the collector: the standalone server behind `npm start`, and the Vite plugin for dev         |
| `src/dashboard/`       | The React app: `main.tsx`, `App.tsx`, `components/`, `hooks/`, `lib/`, `assets/` and `styles/`                         |
| `tests/`               | Every test, fixture and test helper                                                                                    |
| `scripts/`             | The layout check                                                                                                       |
| `public/`              | Static files served as they are                                                                                        |
| `docs/`                | The user guide, the architecture, the adapter notes in `adapters/` and the README's screenshots                        |

`index.html`, `package.json` and the config files are at the root.

In the dashboard, primitives are in `src/dashboard/components/ui/` and features in `src/dashboard/components/<feature>/`.

No test, fixture or test helper lives under `src/`, and nothing under `src/` imports from `tests/`.

The dashboard and the tests import through the aliases `@core`, `@collector`, `@dashboard` and `@tests`. Only tests can use `@tests`. The collector and `src/core/` import by relative path with the `.ts` extension, because `npm start` runs them without a bundler. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the parts fit together.

The interface follows a fixed system of tokens and primitives. The tokens are in `src/dashboard/styles/index.css` and the primitives in `src/dashboard/components/ui/`. Read both before you add or change anything under `src/dashboard/`.

## Names

| Kind                 | Named                 | Example                    |
| -------------------- | --------------------- | -------------------------- |
| Folder               | kebab-case            | `adapters/claude-code/`    |
| React component file | `PascalCase.tsx`      | `components/ui/Button.tsx` |
| Hook                 | `useThing.ts`         | `hooks/useNow.ts`          |
| Every other module   | `camelCase.ts`        | `lib/collectorStore.ts`    |
| Test                 | The module's own name | `collectorStore.test.ts`   |

A primitive under `components/ui/` is a component file like any other. The entry file `main.tsx` is the one `.tsx` file that is not a component.

## Adding an adapter

An adapter finds one agent tool's sessions and reports them in the shared session model. Each tool gets one adapter, in `src/collector/adapters/<tool>/`. There are two to learn from: Claude Code's in `src/collector/adapters/claude-code/`, which checks local files against a documented command, and Codex's in `src/collector/adapters/codex/`, which reads files alone. Read both before you write another.

An adapter implements the interface in `src/collector/adapters/adapter.ts`. It has an `id`, a `label` and a `poll()` that resolves to `{ health, sessions }`. The poller calls `poll()` every 2 seconds. `poll()` never throws. A failure becomes `health.state`, with a plain-language `detail` that says where the adapter looked. A tool that is not installed is `unavailable`, which is not an error. Once that is known, do not look again on every poll: the Codex adapter looks once a minute. `health.watching` lists what the adapter reads and runs, and the Sources view shows it.

1. Write down what the tool exposes in `docs/adapters/<tool>.md`: the commands or paths, which fields mean what, the version you checked and what breaks when it changes. [docs/adapters/codex.md](docs/adapters/codex.md) is an example.
2. Add the tool's id to `SourceId` in `src/core/session.ts`. You may add optional fields to `Session`. Do not rename or remove existing ones.
3. Map the tool's own states onto `SessionStatus` in a pure function in `src/core/`, as `src/core/claudeCodeMapping.ts` and `src/core/codexMapping.ts` do. Anything unrecognised becomes `unknown`. A state the tool does not record is not guessed: Codex's files never say it is waiting for approval, so a Codex session is never `needs-you`.
4. Write the adapter. Read the tool's cheap local state, such as files it keeps on disk, on every poll, and expect any field in it to be missing. Check what it says against a listing command or API that the vendor documents for outside tools, run seldom, and let that answer win. The Claude Code adapter reads the registry folder every 2 seconds and runs `claude agents --json --all` every 30 seconds. When the local state cannot be read or relied on, take sessions from the documented command. When the command cannot be run, use the local state alone and say so in `detail`. When the tool documents nothing that can be used without changing its settings or writing to its files, as with Codex, read its files alone, say so in `detail` and in the notes from step 1, and open only the files those notes list.
5. Start a program directly, never through a shell, with stdin closed and a timeout. `runProgram` in `src/collector/adapters/claude-code/feed.ts` does this.
6. Add the adapter to the default list in `createCollector`, in `src/collector/collector.ts`.
7. Add tests under `tests/`, at the paths that mirror the adapter's modules. A test that hands the adapter stand-ins for its files and programs goes in `tests/unit/`. Anything that runs a real program or reads real files goes in `tests/integration/`. Cover the tool being missing, the command failing, empty output, malformed output, local state that disagrees with the command and every status mapping. Give the tool's folder a setting like `AGENT_LOOKOUT_CODEX_HOME`, so that no test reads the real one.
8. Add every command the adapter runs and every file it reads to [PRIVACY.md](PRIVACY.md).

Fixtures go in `tests/fixtures/`, as `tests/fixtures/claudeCode.ts` and the folder `tests/fixtures/codex-home/` do. Write them by hand with generic values such as `demo-project` and `/Users/example/code/demo`. Never copy a session name or path from a real machine into the repository.

An adapter is read-only. It never writes to the tool's files and never sends input to a session.

## Pull requests

Keep a pull request to one topic. Say what changed, why, and how you checked it.

If a user would notice the change, add a line to `CHANGELOG.md` under Unreleased. If the app now runs a new command or reads a new file, update `PRIVACY.md` in the same pull request.

Screenshots of the dashboard show session names and folder paths. Crop or blur anything you would not want public.

Commit messages are short and plain, in the imperative: `Mark idle sessions as stale after a day`.

## Security problems

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes. Do not open a public issue for one.
