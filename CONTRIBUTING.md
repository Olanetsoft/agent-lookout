# Contributing

Agent Lookout has one maintainer. Bug reports, fixes and adapters for other agent tools are welcome. For anything larger than a fix, open an issue first so the approach is agreed before you write it.

## Two rules

By default Agent Lookout itself sends nothing anywhere. Its code makes no network request to anything but its own local server, unless the person has set up email notifications, which go only to the mail server they named. That rules out telemetry, analytics, remote fonts, update checks and CDN links, and it covers dependencies as well as your own code. A new way of sending something off the machine is off until the person sets it up, sends only what PRIVACY.md lists, and is described there and in the README. Claude Code's own listing command, which the Claude Code adapter runs, may contact Anthropic the way Claude Code normally does. That is why the adapter runs it seldom.

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

To see the dashboard with no sessions, point it at an empty folder:

```sh
mkdir -p /tmp/lookout-empty
AGENT_LOOKOUT_CLAUDE_HOME=/tmp/lookout-empty AGENT_LOOKOUT_CODEX_HOME=/tmp/lookout-empty npm run dev
```

With both set, Agent Lookout reads only that folder, does not run the `claude` command and does not read `~/.codex`. The [guide](docs/GUIDE.md#settings-you-can-change) lists every setting.

## Checks

Run this before you open a pull request:

```sh
npm run check
```

It runs the layout check, the typecheck, the linter, the format check and the tests in that order, and stops at the first failure. CI runs the same five and `npm run build`. Most format and lint failures are fixed by `npm run format` and `npm run lint:fix`.

A change in behaviour comes with a test. Every test lives under `tests/`, in `unit/`, `integration/` or `component/`, at the path that mirrors the module it covers. Nothing under `src/` is a test or imports from `tests/`. The layout check fails, and says where the file belongs, when one of those rules is broken.

[tests/README.md](tests/README.md) says what belongs in each group, how to run one group or one file, how fixtures are written and how to run the opt-in check against the real `claude`.

## Where code goes

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the map of folders and explains how the parts fit together. In short, `src/core/` is logic with no DOM and no Node APIs, `src/collector/` is the Node code that finds sessions, `src/dashboard/` is the React app, and `tests/` holds every test, fixture and test helper.

In the dashboard, primitives are in `src/dashboard/components/ui/` and features in `src/dashboard/components/<feature>/`. The interface follows a fixed system of tokens and primitives, and the tokens are in `src/dashboard/styles/index.css`. Read both before you add or change anything under `src/dashboard/`.

Modules are grouped by what they are about, not left in one long folder: `src/dashboard/lib/` has `api/`, `sessions/`, `sources/`, `charts/`, `notifications/` and `shell/`, and the hooks, the primitives and `src/core/` are grouped the same way. Put a new module in the folder for its area, and its test at the mirrored path under `tests/`. `npm run check` fails when a folder holds more than eight code files side by side.

The dashboard and the tests import through the aliases `@core`, `@collector`, `@dashboard` and `@tests`. Only tests can use `@tests`. The collector and `src/core/` import by relative path with the `.ts` extension, because `npm start` runs them without a bundler.

## Names

| Kind                 | Named                 | Example                             |
| -------------------- | --------------------- | ----------------------------------- |
| Folder               | kebab-case            | `adapters/claude-code/`             |
| React component file | `PascalCase.tsx`      | `components/ui/controls/Button.tsx` |
| Hook                 | `useThing.ts`         | `hooks/data/useNow.ts`              |
| Every other module   | `camelCase.ts`        | `lib/api/collectorStore.ts`         |
| Test                 | The module's own name | `collectorStore.test.ts`            |

A primitive under `components/ui/` is a component file like any other. The entry file `main.tsx` is the one `.tsx` file that is not a component.

## Adding an adapter

A status file is the quickest way to show another agent, and needs no code in Agent Lookout: the agent writes one small JSON file for each session into `~/.agent-lookout/sessions`, as the [guide](docs/GUIDE.md#your-own-agents) describes. Try that first. Write an adapter for a tool that keeps its own record of its sessions and cannot be made to write one, as Claude Code and Codex do.

An adapter finds one agent tool's sessions and reports them in the shared session model. Each tool gets one adapter, in `src/collector/adapters/<tool>/`. There are two to learn from: Claude Code's in `src/collector/adapters/claude-code/`, which checks local files against a documented command, and Codex's in `src/collector/adapters/codex/`, which reads files alone. Read both before you write another.

An adapter implements the interface in `src/collector/adapters/adapter.ts`. It has an `id`, a `label` and a `poll()` that resolves to `{ health, sessions }`. The poller calls `poll()` every 2 seconds. `poll()` never throws. A failure becomes `health.state`, with a plain-language `detail` that says where the adapter looked. A tool that is not installed is `unavailable`, which is not an error. Once that is known, do not look again on every poll: the Codex adapter looks once a minute. `health.watching` lists what the adapter reads and runs, and the Sources view shows it.

1. Write down what the tool exposes in `docs/adapters/<tool>.md`: the commands or paths, which fields mean what, the version you checked and what breaks when it changes. [docs/adapters/codex.md](docs/adapters/codex.md) is an example.
2. Add the tool's id to `SourceId` in `src/core/sessions/session.ts`. You may add optional fields to `Session`. Do not rename or remove existing ones.
3. Map the tool's own states onto `SessionStatus` in a pure function in `src/core/`, as `src/core/mapping/claudeCodeMapping.ts` and `src/core/mapping/codexMapping.ts` do. Anything unrecognised becomes `unknown`. A state the tool does not record is not guessed: Codex's files never say it is waiting for approval, so a Codex session is never `needs-you`. If the tool can be `needs-you`, keep the session's `statusSince` at the moment the wait began for as long as the wait lasts: a later time on a session that is still waiting is announced as a new wait.
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
