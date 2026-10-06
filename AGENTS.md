# AGENTS.md

Agent Lookout shows the AI agent sessions on a Mac or Linux computer in one browser page. `src/collector/` is the Node code that finds sessions and serves them on a loopback address, `src/dashboard/` is the React app, `src/core/` is logic with no DOM and no Node APIs, and `src/cli/` is the `agent-lookout` command. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the map.

## Commands

- You need Node.js 22.12 or newer. Run `npm install`, then `npx playwright install chromium` once for the component tests. On Linux, add `--with-deps`.
- `npm run dev` serves the dashboard at http://localhost:5173 with the collector inside the dev server, and shows the sessions on the machine. To show none, set `AGENT_LOOKOUT_CLAUDE_HOME`, `AGENT_LOOKOUT_CODEX_HOME`, `AGENT_LOOKOUT_STATUS_DIR` and `AGENT_LOOKOUT_HISTORY_DIR` to an empty folder. Without the last, the Events log and the charts show what earlier runs kept in `~/.agent-lookout/history`.
- `npm run check` runs the layout check, the typecheck, the linter, the format check and the tests, and stops at the first failure. Run it before you finish. CI also runs `npm run build`.
- `npm run format` and `npm run lint:fix` fix most format and lint failures.
- `npm run test:unit`, `npm run test:integration` and `npm run test:component` run one group. `npx vitest run <file>` runs one file.

## Rules

- By default Agent Lookout sends nothing anywhere. Its code makes no network request to anything but its own local server, except email notifications, the webhook and the other machines read over SSH, which are off until the person sets them up, and it runs the person's own `gh`, which asks GitHub for pull requests, only with `AGENT_LOOKOUT_PULL_REQUESTS=on`. No telemetry, analytics, remote fonts, CDN links or update checks, in your code or in a dependency. The one exception is the Mac app's daily check of GitHub Releases, in `src/desktop/updates/`, which [PRIVACY.md](PRIVACY.md#updates-mac-app-only) describes.
- No invented data. The dashboard shows what the collector measured, or an honest loading, empty or error state. Fixtures go in `tests/fixtures/`, written by hand with generic values such as `demo-project` and `/Users/example/code/demo`. Never copy a real session name or path into the repository.
- No test writes to the person's own `~/.agent-lookout` or `~/.claude`. A test that builds a collector or starts the app sets `AGENT_LOOKOUT_HISTORY=off`, or `AGENT_LOOKOUT_HISTORY_DIR` to a temporary folder, and `AGENT_LOOKOUT_SETTINGS_FILE` to `NO_SETTINGS_FILE` from `tests/support/node/tempFiles.ts`, or to a file in a temporary folder.
- A change in behaviour comes with a test. Every test lives under `tests/unit/`, `tests/integration/` or `tests/component/`, named for the module it covers and at the mirrored path. Nothing under `src/` is a test or imports from `tests/`. [tests/README.md](tests/README.md) says which group a test belongs in.
- Put a new module in the folder for its area. `npm run check` fails when a folder holds more than eight code files side by side.
- Folders are kebab-case, React components `PascalCase.tsx`, hooks `useThing.ts` and every other module `camelCase.ts`.
- The collector, `src/cli/` and `src/core/` import by relative path with the `.ts` extension. The dashboard and the tests import through `@cli`, `@core`, `@collector` and `@dashboard`, and only tests can use `@tests`.
- An adapter is read-only. It never writes to the tool's files and never sends input to a session. Start a program directly, never through a shell, with stdin closed and a timeout. Read [Adding an adapter](CONTRIBUTING.md#adding-an-adapter) before you write one.
- Agent Lookout stops a Claude Code session only when the person presses Stop and confirms, and never acts on its own. The routes that do it, in `src/collector/actions/`, make every check of `actionRefusalFor` in `src/collector/handler.ts`, read the session's registry file and ask `ps` again before they act, send SIGTERM and never SIGKILL, and never take a pid, a start time or a job id from a request.
- Agent Lookout answers a Claude Code permission prompt only when the person presses Allow or Deny, through the plugin in `plugins/agent-lookout/`, which the person installs in Claude Code themselves. The socket, the held requests and the route, in `src/collector/answers/`, read the session's registry file again before they answer, write only the two fixed decisions, never `updatedInput` or a permission rule, offer Allow only when the whole request is shown, and keep a request's text in memory only while it is held, never in an event, the history, an email, a webhook post or an MCP answer. Agent Lookout writes nothing under `~/.claude`. A test that starts a collector names its own socket with `AGENT_LOOKOUT_ANSWER_SOCKET`, or sets `AGENT_LOOKOUT_ANSWER=off`.
- Before you add or change anything under `src/dashboard/`, read the tokens in `src/dashboard/styles/index.css` and the primitives in `src/dashboard/components/ui/`.
- If a user would notice the change, add a line to `CHANGELOG.md` under Unreleased. If the app now runs a new command or reads a new file, update `PRIVACY.md` in the same change.
- Keep a pull request to one topic and fill in the template. Commit messages are short and plain, in the imperative: `Mark idle sessions as stale after a day`.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest.
