# Contributing

Agent Lookout has one maintainer. Bug reports, fixes and adapters for other agent tools are welcome. For anything larger than a fix, open an issue first so the approach is agreed before you write it.

## Two rules

By default Agent Lookout itself sends nothing anywhere. Its code makes no network request to anything but its own local server, unless the person has set up email notifications, which go only to the mail server they named, or a webhook, whose posts go only to the address they set. That rules out telemetry, analytics, remote fonts, update checks and CDN links, and it covers dependencies as well as your own code. The one exception is the Mac app's check of GitHub Releases for a newer version, about once a day, which the maintainer decided on and [Updates (Mac app only)](PRIVACY.md#updates-mac-app-only) describes. A new way of sending something off the machine is off until the person sets it up, sends only what PRIVACY.md lists, and is described there and in the README. Claude Code's own listing command, which the Claude Code adapter runs, may contact Anthropic the way Claude Code normally does. That is why the adapter runs it seldom.

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
AGENT_LOOKOUT_CLAUDE_HOME=/tmp/lookout-empty AGENT_LOOKOUT_CODEX_HOME=/tmp/lookout-empty AGENT_LOOKOUT_STATUS_DIR=/tmp/lookout-empty npm run dev
```

With all three set, Agent Lookout reads only that folder, does not run the `claude` command, and reads neither `~/.codex` nor `~/.agent-lookout/sessions`. The [guide](docs/GUIDE.md#settings-you-can-change) lists every setting.

## Checks

Run this before you open a pull request:

```sh
npm run check
```

It runs the layout check, the typecheck, the linter, the format check and the tests in that order, and stops at the first failure. CI runs the same five, `npm run build`, the start check described under [Running on Linux](#running-on-linux), and the package check described under [The npm package](#the-npm-package). Most format and lint failures are fixed by `npm run format` and `npm run lint:fix`.

A change in behaviour comes with a test. Every test lives under `tests/`, in `unit/`, `integration/` or `component/`, at the path that mirrors the module it covers. Nothing under `src/` is a test or imports from `tests/`. The layout check fails, and says where the file belongs, when one of those rules is broken.

[tests/README.md](tests/README.md) says what belongs in each group, how to run one group or one file, how fixtures are written and how to run the opt-in check against the real `claude`.

## Running on Linux

The setup and the checks above are the same on Linux, with `--with-deps` on the Playwright step. CI runs every job on Ubuntu. To check that the built app starts and finds sessions, as the CI job `start` does:

```sh
npm run build
npm run start:check
```

It starts the app with `npm start` on a port the system picks, pointed at folders it makes for the check, prints one line for each check, then stops the app as Ctrl+C would. It reads none of your own sessions and runs no `claude` command. Notifications with no dashboard tab open and Jump to a tab of Terminal or iTerm2 are macOS only, so on Linux their tests run with stand-ins for `osascript` and for Terminal's processes, as they do everywhere. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#on-linux) has what differs between the two systems.

## The npm package

The package holds only what `npx agent-lookout` needs: the built dashboard and the bundled command in `dist/`, `bin/agent-lookout.mjs`, and the README, the licence, the changelog, `PRIVACY.md`, `SECURITY.md`, `DISCLAIMER.md`, `docs/GUIDE.md` and `docs/API.md`. `files` in `package.json` lists them, and nothing else goes in: no source, tests, scripts, site or local notes.

```sh
npm run build:package
```

builds it. It runs `npm run build`, then `scripts/build-package.mjs`, which bundles `src/cli/agentLookout.ts`, with the collector that `agent-lookout start` runs, into plain JavaScript in `dist/cli/` with esbuild, so a person who installs the package needs no TypeScript. `@modelcontextprotocol/sdk`, `zod` and `nodemailer` stay outside the bundle and are the package's only dependencies. Everything else, React and the rest of the dashboard's libraries included, is a devDependency, since the dashboard ships built. The script stops if the bundle imports any other package. `npm pack` and `npm publish` run it first, through `prepack`.

`bin/agent-lookout.mjs` runs the bundle only where there is no `src/` beside it, as in the installed package. In a clone it runs `src/` through tsx, so a bundle left in `dist/cli/` is never used by mistake, and `npm run build` removes it.

To check the package as a person gets it, pack it, install it into a folder of its own and start it there, as the CI job `package` does:

```sh
npm pack --pack-destination /tmp
mkdir /tmp/try && cd /tmp/try && echo '{ "private": true }' > package.json
npm install /tmp/agent-lookout-*.tgz
npx --yes=false agent-lookout --help
node /path/to/agent-lookout/scripts/start-check.mjs --command npx --yes=false agent-lookout
```

`npm pack --dry-run` lists what would go in without writing the tarball. `--yes=false` stops npx installing the published package in place of the one you installed.

## Publishing

The maintainer publishes. The README, `docs/GUIDE.md` and `CHANGELOG.md` go into the package, and npm shows the package's README on its page. A published version's files can never be changed, so what they say about that version is written before it is published, not after.

1. Set the version in `package.json`, and turn the heading `Unreleased` in `CHANGELOG.md` into that version and the day's date.
2. For the first version on npm, add the `npx agent-lookout` way to the README's Install, and in `docs/GUIDE.md`, under [Start it with one command](docs/GUIDE.md#start-it-with-one-command), say that Agent Lookout is on npm in place of "Once Agent Lookout is on npm" and "Until then".
3. Check that `npm run check` passes, then publish from the working tree with those changes in it, before they are committed:

   ```sh
   npm pack --dry-run
   npm login
   npm publish
   ```

4. Commit the changes once `npm publish` has succeeded. If it failed, nothing was published.

`npm publish` runs `prepack`, which builds the dashboard and the bundle afresh, then uploads the tarball, made from the files on disk. npm asks for a one-time password when the account has two-factor authentication on. `publishConfig` in `package.json` makes the package public.

### The Mac app

The release workflow, `.github/workflows/release-mac.yml`, attaches the Mac app to the release. The version only ever changes in its last number, and the tag is `v` and the version, such as `v0.2.1`.

1. Once the version is published and its changes are committed, tag that commit and push the tag:

   ```sh
   git tag v0.2.1
   git push origin v0.2.1
   ```

2. The workflow runs on a Mac runner for the tag. It stops unless the tag is `v` and the version in `package.json`. It runs `npm ci` and `npm run check`, and builds the app with `npm run dist:mac`, signed ad hoc, with read access to the repository only. A second job, the only one with `contents: write`, takes the two disk images, the two zips and `latest-mac.yml` from the first and attaches them to the tag's release with `gh release upload --clobber`, making the release as a draft first if there is none. It runs nothing else, so no dependency's install script, test or build step is ever in reach of a token that can change a release. The workflow uses only its own `GITHUB_TOKEN` and publishes nothing to npm.
3. Write the release's notes on GitHub and publish it, if it is a draft. The apps already installed find it within a day, or at once with Check for Updates…: they read `latest-mac.yml` from the latest published release, and never see a draft or a prerelease.

To run it again for a tag already pushed, as after a failure, start it by hand from the Actions tab with that tag. It replaces the files of the same name. `latest-mac.yml` gives each file's size and SHA-512, and an app checks what it downloads against it, so never attach a file by hand that it does not name.

## Where code goes

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the map of folders and explains how the parts fit together. In short, `src/core/` is logic with no DOM and no Node APIs, `src/collector/` is the Node code that finds sessions, `src/dashboard/` is the React app, and `tests/` holds every test, fixture and test helper.

In the dashboard, primitives are in `src/dashboard/components/ui/` and features in `src/dashboard/components/<feature>/`. The interface follows a fixed system of tokens and primitives, and the tokens are in `src/dashboard/styles/index.css`. Read both before you add or change anything under `src/dashboard/`.

Modules are grouped by what they are about, not left in one long folder: `src/dashboard/lib/` has `api/`, `sessions/`, `sources/`, `charts/`, `notifications/` and `shell/`, and the hooks, the primitives and `src/core/` are grouped the same way. Put a new module in the folder for its area, and its test at the mirrored path under `tests/`. `npm run check` fails when a folder holds more than eight code files side by side.

The dashboard and the tests import through the aliases `@cli`, `@core`, `@collector`, `@dashboard`, `@desktop` and `@tests`. Only tests can use `@tests`. The collector, the command in `src/cli/` and `src/core/` import by relative path with the `.ts` extension, because `npm start` and the command run them without a bundler, and the Mac app's main process in `src/desktop/` does the same.

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

An adapter implements the interface in `src/collector/adapters/adapter.ts`. It has an `id`, a `label` and a `poll()` that resolves to `{ health, sessions }`. The poller calls `poll()` every 2 seconds. `poll()` never throws. A failure becomes `health.state`, with a plain-language `detail` that says where the adapter looked. A tool that is not installed is `unavailable`, which is not an error. Once that is known, do not look again on every poll: the Codex adapter looks once a minute. `health.watching` lists what the adapter reads and runs, and the Sources view shows it. `capabilities` says what the tool can report at all, yes, no or partly for each thing in `CAPABILITIES` in `src/core/sessions/session.ts`, with a reason for each no and partly. Take each one from what the adapter reads, and add the adapter's row to the table under "What each agent can report" in [the guide](docs/GUIDE.md#what-each-agent-can-report): a test checks that the two agree. Add its constant to `DECLARED` in `tests/integration/collector/adapters/adapter.test.ts` and `tests/unit/collector/adapters/adapter.test.ts` too.

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
