# Contributing

Agent Lookout has one maintainer. Bug reports, fixes and adapters for other agent tools are welcome. For anything larger than a fix, open an issue first so the approach is agreed before you write it.

## Two rules

By default Agent Lookout itself sends nothing anywhere. Its code makes no network request to anything but its own local server, unless the person has set up email notifications, which go only to the mail server they named, or a webhook, whose posts go only to the address they set. It runs the person's own `gh`, which asks GitHub for pull requests, only with `AGENT_LOOKOUT_PULL_REQUESTS=on`, and their own `ssh` only to the machines `AGENT_LOOKOUT_REMOTES` names. That rules out telemetry, analytics, remote fonts, update checks and CDN links, and it covers dependencies as well as your own code. The one exception is the Mac app's check of GitHub Releases for a newer version, about once a day, which the maintainer decided on and [Updates (Mac app only)](PRIVACY.md#updates-mac-app-only) describes. A new way of sending something off the machine is off until the person sets it up, sends only what PRIVACY.md lists, and is described there and in the README. Claude Code's own listing command, which the Claude Code adapter runs, may contact Anthropic the way Claude Code normally does. That is why the adapter runs it seldom.

No invented data. The dashboard shows what the collector measured, or an honest loading, empty or error state. Sample sessions, placeholder numbers and demo modes stay out of the product. Fixtures exist only under `tests/`.

A pull request that breaks either rule will not be merged.

## Set up

You need Node.js 22.12 or newer and, to see real sessions, Claude Code or Codex. `.nvmrc` holds 22, the version most CI jobs use.

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
AGENT_LOOKOUT_CLAUDE_HOME=/tmp/lookout-empty AGENT_LOOKOUT_CODEX_HOME=/tmp/lookout-empty AGENT_LOOKOUT_STATUS_DIR=/tmp/lookout-empty AGENT_LOOKOUT_HISTORY_DIR=/tmp/lookout-empty npm run dev
```

With all four set, Agent Lookout reads only that folder, does not run the `claude` command, reads neither `~/.codex` nor `~/.agent-lookout/sessions`, and keeps its history in that folder, so the Events log and the charts do not show what earlier runs kept in `~/.agent-lookout/history`. The [guide](docs/GUIDE.md#settings-you-can-change) lists every setting.

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

It starts the app with `npm start` on a port the system picks, pointed at folders it makes for the check, prints one line for each check, runs `agent-lookout mcp` beside it and asks it for its tools and the sessions that need you, as an agent's app would, then stops the app as Ctrl+C would. It reads none of your own sessions and runs no `claude` command. Notifications with no dashboard tab open and Jump to a tab of Terminal or iTerm2 are macOS only, so on Linux their tests run with stand-ins for `osascript` and for Terminal's processes, as they do everywhere. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#on-linux) has what differs between the two systems.

## Running on Windows

The setup and the checks above are the same on Windows, in PowerShell or the Command Prompt. CI runs the tests and the start check on Windows too, in the jobs `test (Windows)` and `start (Windows)`. A test of something Windows does not have, a POSIX sh script, a Unix socket, `ps`, tmux, `osascript`, a POSIX signal, a named pipe or POSIX file modes, is skipped there, and a line above it says why. A few tests make symbolic links, which Windows lets you make only as an administrator or with Developer Mode on. On Windows the start check ends the app with every process under it, since Windows cannot send Ctrl+C to another program. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#on-windows) has what differs there.

## The npm package

The package holds only what `npx agent-lookout` needs: the built dashboard and the bundled command in `dist/`, `bin/agent-lookout.mjs`, and the README, the licence, the changelog, `PRIVACY.md`, `SECURITY.md`, `DISCLAIMER.md`, `docs/INSTALL.md`, `docs/GUIDE.md` and `docs/API.md`. `files` in `package.json` lists them, and nothing else goes in: no source, tests, scripts, site or local notes.

```sh
npm run build:package
```

builds it. It runs `npm run build`, then `scripts/build-package.mjs`, which bundles `src/cli/agentLookout.ts`, with the collector that `agent-lookout start` runs, into plain JavaScript in `dist/cli/` with esbuild, so a person who installs the package needs no TypeScript. The parts of `@modelcontextprotocol/sdk` and `zod` that `agent-lookout mcp` uses are bundled too, into the file only `mcp` loads, with the licence of every package that goes in added to `dist/THIRD-PARTY-LICENSES.md`. So the package installs neither, nor the web servers the SDK depends on for transports the command does not use. `nodemailer` stays outside the bundle and is the package's only dependency. Everything else, React and the rest of the dashboard's libraries included, is a devDependency, since the dashboard ships built. The script stops if the command's code imports any other package: add it to `BUNDLED` in the script, or to `dependencies`. `npm pack` and `npm publish` run it first, through `prepack`.

A bundled package is never updated where Agent Lookout is installed, and `npm audit` there does not see it. So when the SDK or zod has a security fix, update it in `package-lock.json` and publish a new version.

`bin/agent-lookout.mjs` runs the bundle only where there is no `src/` beside it, as in the installed package. In a clone it runs `src/` through tsx, so a bundle left in `dist/cli/` is never used by mistake, and `npm run build` removes it.

To check the package as a person gets it, pack it, install it into a folder of its own and start it there, as the CI job `package` does:

```sh
npm pack --pack-destination /tmp
mkdir /tmp/try && cd /tmp/try && echo '{ "private": true }' > package.json
npm install /tmp/agent-lookout-*.tgz
npx --yes=false agent-lookout --help
node /path/to/agent-lookout/scripts/package-size.mjs /tmp/agent-lookout-*.tgz /tmp/try
node /path/to/agent-lookout/scripts/start-check.mjs --command npx --yes=false agent-lookout
```

`npm pack --dry-run` lists what would go in without writing the tarball. `--yes=false` stops npx installing the published package in place of the one you installed.

`scripts/package-size.mjs` prints three sizes and fails when one has grown past its limit: the tarball, 0.66 MB with a limit of 1 MB, the files in it, 2.37 MB with a limit of 3 MB, and the installed `node_modules`, the package and nodemailer, 3.96 MB with a limit of 5 MB. Before the MCP SDK was bundled they were 0.63 MB, 1.69 MB and 20.45 MB. The CI job `package` runs it, and so does the release workflow before it publishes. Raise a limit only on purpose, and say why in the pull request. The package holds only `.woff2` fonts, and the same job fails if a `.woff` gets in.

## Publishing

The maintainer publishes. A version tag starts `.github/workflows/release-npm.yml`, which publishes the package to npm from GitHub Actions once he approves it, with provenance: the package's page on npmjs.com shows the commit and the workflow run each version was built from. No npm token exists for it, in the repository or anywhere else. The tag is `v` and the version, such as `v0.2.3`, and the version only ever changes in its last number.

The README, `docs/INSTALL.md`, `docs/GUIDE.md` and `CHANGELOG.md` go into the package, and npm shows the package's README on its page. A published version's files can never be changed, so what they say about that version is committed before the tag is pushed.

1. Set the version in `package.json`, and turn the heading `Unreleased` in `CHANGELOG.md` into that version and the day's date. Then run `npm run build:tour`, which builds the landing page's dashboard in `site/tour/` and `site/vendor/` from this version, and bring what `site/index.html` says up to what the version ships. CI checks that a change with a new version has the tour that version builds. Commit, push, and wait for CI to pass for that commit.
2. Tag the commit and push the tag:

   ```sh
   git tag v0.2.3
   git push origin v0.2.3
   ```

3. The workflow runs for the tag, and its first three jobs have read access to the repository only. It stops unless the tag is `v` and the version in `package.json`, and stops with a notice, publishing nothing, when that version is on npm already. It runs `npm ci`, the layout check, the typecheck, the linter and the unit and integration tests (the component tests run in CI for the same commit before the tag is pushed). A job of its own packs the tarball, once, checks it as the CI job `package` does, and hands it on.
4. The last job, `publish`, runs in the environment `npm-publish`, so it waits until the maintainer approves it: open the run from the Actions tab, choose Review deployments, tick `npm-publish` and choose Approve and deploy. It checks out nothing and installs nothing. It checks that the tarball is the one packed and checked, publishes it with `npm publish --provenance`, and checks that npm has that tarball, with provenance. It is the only job that can ask GitHub for an OIDC token, and npm accepts that token in place of one of its own because the package's trusted publisher names this repository, this workflow and this environment.

The same tag starts the Mac app's release, below. To run the npm release again for a tag already pushed, as after a failure, start npm release by hand from the Actions tab: choose the tag under Use workflow from, and enter it as the tag. A run for a branch stops, because the provenance names the ref and the commit a run is for.

### Setting up trusted publishing

Two steps, done once, that only the maintainer can do, in this order. GitHub makes an environment that a workflow names when there is none, with no protection rules, so the environment and its reviewer come first. The `publish` job also refuses to run in an environment with no required reviewer.

1. In the repository's Settings, under Environments, choose New environment, name it `npm-publish` and choose Configure environment. If `npm-publish` is listed already, because the workflow ran before this step, open it instead of choosing New environment. Tick Required reviewers, add yourself and choose Save protection rules. Leave Prevent self-review off: you push the tag, and with it on you could not approve the run.
2. On npmjs.com, in the package's Settings, under Trusted Publisher, choose GitHub Actions and fill in Organization or user `Olanetsoft`, Repository `agent-lookout`, Workflow filename `release-npm.yml` and Environment name `npm-publish`. Under Allowed actions, allow `npm publish`; `npm stage publish` is always allowed. npm checks none of these fields when you save them, and each is case-sensitive. A new trusted publisher expires unless a version is published with it within 2 days, and once expired it can be neither used nor edited, so push the tag and approve the run within 2 days of adding it. If it expires, delete it on npmjs.com and add it again.

Two more settings on the environment's page are optional. Under Deployment branches and tags, choose Selected branches and tags and add a rule of type Tag for `v*`: then only a run for a tag can enter `npm-publish`, which GitHub checks as well as the workflow. Allow administrators to bypass configured protection rules is on by default, and lets an administrator, which you are, deploy without the review; untick it if every run should wait for one.

npm also checks that `repository.url` in `package.json` names this repository.

### By hand, when the workflow cannot

From a clean checkout of the tag, with a version that is not on npm yet:

```sh
git checkout v0.2.3
npm ci
npm pack
npm login
npm publish agent-lookout-0.2.3.tgz
```

Check the tarball before you publish it, as [The npm package](#the-npm-package) describes. npm asks for a one-time password when the account has two-factor authentication on, and `publishConfig` in `package.json` makes the package public. A version published this way has no provenance, which only a run in GitHub Actions can make. A run of the workflow for its tag afterwards publishes nothing.

### The Mac app

The release workflow, `.github/workflows/release-mac.yml`, attaches the Mac app to the release. The tag pushed for the npm release starts it too.

1. The workflow runs on a Mac runner for the tag. It stops unless the tag is `v` and the version in `package.json`. It runs `npm ci`, the layout check, the typecheck, the linter and the unit and integration tests (the component tests run in CI on Linux for the same commit before the tag is pushed), and builds the app with `npm run dist:mac`, signed ad hoc, with read access to the repository only. A second job, the only one with `contents: write`, takes the two disk images, the two zips and `latest-mac.yml` from the first and attaches them to the tag's release with `gh release upload --clobber`, making the release as a draft first if there is none. It runs nothing else, so no dependency's install script, test or build step is ever in reach of a token that can change a release. The workflow uses only its own `GITHUB_TOKEN` and publishes nothing to npm.
2. Write the release's notes on GitHub and publish it, if it is a draft. The apps already installed find it within a day, or at once with Check for Updates…: they read `latest-mac.yml` from the latest published release, and never see a draft or a prerelease.

To run it again for a tag already pushed, as after a failure, start it by hand from the Actions tab with that tag. It replaces the files of the same name. `latest-mac.yml` gives each file's size and SHA-512, and an app checks what it downloads against it, so never attach a file by hand that it does not name.

## Where code goes

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the map of folders and explains how the parts fit together. In short, `src/core/` is logic with no DOM and no Node APIs, `src/collector/` is the Node code that finds sessions, `src/dashboard/` is the React app, and `tests/` holds every test, fixture and test helper.

In the dashboard, primitives are in `src/dashboard/components/ui/` and features in `src/dashboard/components/<feature>/`. The interface follows a fixed system of tokens and primitives, and the tokens are in `src/dashboard/styles/index.css`. Read both before you add or change anything under `src/dashboard/`.

Modules are grouped by what they are about, not left in one long folder: `src/dashboard/lib/` has `api/`, `sessions/`, `sources/`, `charts/`, `notifications/` and `shell/`, and the hooks, the primitives and `src/core/` are grouped the same way. Put a new module in the folder for its area, and its test at the mirrored path under `tests/`. `npm run check` fails when a folder holds more than eight code files side by side.

The dashboard, the landing page's tour in `src/site-tour/` and the tests import through the aliases `@cli`, `@core`, `@collector`, `@dashboard`, `@desktop`, `@site-tour` and `@tests`. Only tests can use `@tests`. The collector, the command in `src/cli/` and `src/core/` import by relative path with the `.ts` extension, because `npm start` and the command run them without a bundler, and the Mac app's main process in `src/desktop/` does the same.

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

An adapter implements the interface in `src/collector/adapters/adapter.ts`. It has an `id`, a `label` and a `poll()` that resolves to `{ health, sessions }`. The poller calls `poll()` every 2 seconds. `poll()` never throws. A failure becomes `health.state`, with a plain-language `detail` that says where the adapter looked. A tool that is not installed is `unavailable`, which is not an error. Once that is known, do not look again on every poll: the Codex adapter looks once a minute. `health.watching` lists what the adapter reads and runs, and the Sources view shows it. `capabilities` says what the tool can report at all, and whether its sessions can be stopped from Agent Lookout, yes, no or partly for each thing in `CAPABILITIES` in `src/core/sessions/session.ts`, with a reason for each no and partly. Take each one from what the adapter reads, and add the adapter's row to the table under "What each agent can report" in [the guide](docs/GUIDE.md#what-each-agent-can-report), and to the agent table under "Supported agents and systems" in [the README](README.md#supported-agents-and-systems): tests check that both agree with it. Add its constant to `DECLARED` in `tests/integration/collector/adapters/adapter.test.ts` and `tests/unit/collector/adapters/adapter.test.ts` too.

1. Write down what the tool exposes in `docs/adapters/<tool>.md`: the commands or paths, which fields mean what, the version you checked and what breaks when it changes. [docs/adapters/codex.md](docs/adapters/codex.md) is an example.
2. Add the tool's id to `SourceId` in `src/core/sessions/session.ts`. You may add optional fields to `Session`. Do not rename or remove existing ones.
3. Map the tool's own states onto `SessionStatus` in a pure function in `src/core/`, as `src/core/mapping/claudeCodeMapping.ts` and `src/core/mapping/codexMapping.ts` do. Anything unrecognised becomes `unknown`. A state the tool does not record is not guessed: Codex's files never say it is waiting for approval, so a Codex session is never `needs-you`. If the tool can be `needs-you`, keep the session's `statusSince` at the moment the wait began for as long as the wait lasts: a later time on a session that is still waiting is announced as a new wait.
4. Write the adapter. Read the tool's cheap local state, such as files it keeps on disk, on every poll, and expect any field in it to be missing. Check what it says against a listing command or API that the vendor documents for outside tools, run seldom, and let that answer win. The Claude Code adapter reads the registry folder every 2 seconds and runs `claude agents --json --all` every 30 seconds. When the local state cannot be read or relied on, take sessions from the documented command. When the command cannot be run, use the local state alone and say so in `detail`. When the tool documents nothing that can be used without changing its settings or writing to its files, as with Codex, read its files alone, say so in `detail` and in the notes from step 1, and open only the files those notes list.
5. Start a program directly, never through a shell, with stdin closed and a timeout. `runProgram` in `src/collector/adapters/claude-code/feed.ts` does this.
6. Add the adapter to the default list in `createCollector`, in `src/collector/collector.ts`.
7. Add tests under `tests/`, at the paths that mirror the adapter's modules. A test that hands the adapter stand-ins for its files and programs goes in `tests/unit/`. Anything that runs a real program or reads real files goes in `tests/integration/`. Cover the tool being missing, the command failing, empty output, malformed output, local state that disagrees with the command and every status mapping. Give the tool's folder a setting like `AGENT_LOOKOUT_CODEX_HOME`, so that no test reads the real one.
8. Add every command the adapter runs and every file it reads to [PRIVACY.md](PRIVACY.md).

Fixtures go in `tests/fixtures/`, as `tests/fixtures/claudeCode.ts` and the folder `tests/fixtures/codex-home/` do. Write them by hand with generic values such as `demo-project` and `/Users/example/code/demo`. Never copy a session name or path from a real machine into the repository.

An adapter is read-only. It never writes to the tool's files and never sends input to a session. Stopping a session is not an adapter's work: Agent Lookout stops a Claude Code session only when the person presses Stop and confirms, through the routes in `src/collector/actions/`, which check everything again before they act. The Claude Code adapter only finds what each session would be stopped by, and the page is told no more than that it can be stopped. Another adapter declares `stop` as no unless it can name a process that can be confirmed in the same way. Answering a permission prompt is not an adapter's work either: it comes through the Agent Lookout plugin's hook and the routes in `src/collector/answers/`, and another adapter declares `answer` as no.

## Pull requests

Keep a pull request to one topic. Say what changed, why, and how you checked it.

If a user would notice the change, add a line to `CHANGELOG.md` under Unreleased. If the app now runs a new command or reads a new file, update `PRIVACY.md` in the same pull request.

Screenshots of the dashboard show session names and folder paths. Crop or blur anything you would not want public.

Commit messages are short and plain, in the imperative: `Mark idle sessions as stale after a day`.

## Security problems

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes. Do not open a public issue for one.
