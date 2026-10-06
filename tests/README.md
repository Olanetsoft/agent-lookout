# Tests

Every test, fixture and test helper lives in this folder. Nothing under `src/` is a test, and nothing under `src/` imports from here.

## What goes where

| Folder         | Holds                                                                                                                                         | Runs in           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `unit/`        | Tests of one module. No sockets, no child processes, no real files. What a module needs from outside is passed in                             | Node              |
| `integration/` | Tests that open a socket, start a server, start a process or touch the real file system                                                       | Node              |
| `component/`   | React components, and the dashboard code that needs a real page, such as the theme and the stylesheet                                         | Headless Chromium |
| `fixtures/`    | Session data shared by tests: `session.ts`, `claudeCode.ts`, `claudeTranscript.ts`, `codex.ts`, `statusFiles.ts` and the folder `codex-home/` |                   |
| `support/`     | Setup files and helpers                                                                                                                       |                   |

A test that only calls functions belongs in `unit/`, even when the module is part of the dashboard, and even when the module would touch files or start programs if it were not handed stand-ins. A test goes in `integration/` as soon as it needs something real from the operating system. A test goes in `component/` when it renders, or when it reads computed styles, local storage or a media query.

`unit/`, `integration/` and `component/` hold tests and nothing else. A helper two test files share goes in `support/`, and data they share goes in `fixtures/`.

The helpers in `support/`:

- `componentSetup.ts` loads the stylesheet before every component test, so tokens and fonts resolve as they do in the app.
- `browser.ts` moves the pointer away and puts the keyboard at the top of the page.
- `colours.ts` reads the colours the page computed: a token in the current theme, every colour a token holds, the contrast of two colours, and anything on the page painted in a warm colour. The needs-you tokens and the lamp's light are the only warm colours in the interface, so warm paint anywhere else is amber where amber does not belong. A colour counts as warm by its chroma, so the faint warmth in the blacks, greys and near-white ink is not mistaken for amber.
- `pixels.ts` reads what the browser drew, for what the DOM cannot say: where the hatch shows, whether two patterns line up, and how words read on glass. `textBackdrops` gives each run of words under an element with the worst of what is drawn behind it, the brightest 3% of those pixels at Night or the darkest 3% by Day, so contrast is measured against the glass and the light behind the words.
- `notifications.ts` holds two stand-ins for the notification system. Neither shows anything or asks anybody. `fakeNotificationHost` is put in place with `setNotificationHost`: it writes down what it was asked to show and close, answers a request for permission the way the test says the person would, and lets a test dismiss a notification as a person can. Like a browser, it keeps one notification for each tag, so a second with the same tag takes the place of the first, which is how two pages open at one address share a notification. It has no DOM in it, so the unit tests use it too. `StubNotification` takes the place of the browser's own `window.Notification`, with `installStubNotification`, for tests of the dashboard's own host and of the app over it: it writes down each question, each notification made of it and when, and each close. No test asks the real browser for permission or shows anything on this machine.
- `media.ts` sets what the computer says it prefers, reduced motion or a light or dark colour scheme, for one test. It uses the `emulateMedia` command that `vite.config.ts` gives the component project.
- `claudeCodeAdapter.ts` builds the Claude Code adapter cut off from this machine: a fixed clock, a pretend binary and invented processes. The unit and the integration tests of the adapter both use it. It touches no file and no process: an adapter given a stand-in registry is given `noTranscripts` too, a Claude Code folder with no transcripts in it.
- `codexAdapter.ts` builds the Codex adapter cut off from this machine: a fixed clock and a file system held in memory that writes down every call. The adapter is handed only its four reading methods; a test changes the files through the other side. It also runs code in another time zone, because Codex names its day folders by the local date.
- `http.ts` starts a server on a free loopback port, finds a free port with nothing listening on it, and sends a request exactly as written, with a body when the test gives one.
- `smtp.ts` starts a mail server of the test's own on a free port of `127.0.0.1`. It speaks just enough SMTP for the collector's mail library, writes down each connection and each email with its sign-in, its recipients and the message as sent, and passes nothing on. It can also turn every connection away, or accept one and never answer. It decodes a received message's headers and text the way a mail program would. No test sends an email anywhere else.
- `webhook.ts` starts a webhook of the test's own: an HTTP server on a free port of `127.0.0.1` that writes down each connection and each request, with its path, its headers in the order and case they were sent, and its body, and passes nothing on. It answers 200 as a Slack incoming webhook does, or a redirect, a refusal or a failure, or reads the request and never answers. No test posts to a webhook anywhere else.
- `systemNotifier.ts` holds a stand-in for the notifier the collector shows its own notifications with, the seam in `src/collector/notifications/systemNotifier.ts`. It writes down what it was asked to show and shows nothing. Every test that builds a collector in which a wait begins passes it, with an environment of the test's own, so no test raises a notification on this machine. The script that shows one is never run by a test: `integration/collector/notifications/systemNotifier.test.ts` runs the real `osascript`, on macOS only, with a script that only gives its arguments back.
- `tmux.ts` holds two stand-ins for a person's tmux. `fakeTmux` runs nothing: it writes down each command it is given and answers as tmux would, from the panes and clients a test sets, and can be told that tmux has stopped. It has no Node API in what it answers, so the unit tests use it too. `privateTmux` is the real tmux on a server of the test's own, on a socket named for that test and with no configuration file read. The server, its panes and any client attached to it are stopped when the test finishes, however it ends. No test asks or changes the tmux server a person is using. A test that builds the collector with its real Claude Code adapter passes its own way of running tmux or sets `AGENT_LOOKOUT_TMUX=off`, and the adapter built on its own looks for no pane.
- `terminal.ts` holds stand-ins for a person's Terminal and iTerm2. `fakeOsascript` runs nothing: it writes down the arguments of each run and answers as `osascript` would, with `found`, `missing`, macOS's error -1743 or a run that ran out of time, and can hold its answer as a run does while macOS asks the person. `fakeProcesses` is a table of processes as `ps` would print it, so a test chooses which app a session seems to run in, and counts how often it is read. No test runs `osascript` against Terminal or iTerm2, or asks macOS for permission: `integration/collector/processes/osascript.test.ts` runs the real `osascript`, on macOS only, with scripts that name no app. A test that builds the collector with its real Claude Code adapter and sessions whose processes are real passes both.
- `tempFiles.ts` makes temporary directories, stand-ins for the Claude Code and Codex folders and stub programs. Each is removed when its test finishes. `makeCodexHome` can start from a copy of `fixtures/codex-home`, for a test that changes files.

The browser tests write failure screenshots and attachments to `.artifacts/`, which git ignores. The browser that runs them hides scrollbars, so a test reads a scrollbar's width from its rule rather than measuring it.

## Running them

| Command                    | Runs                                    |
| -------------------------- | --------------------------------------- |
| `npm test`                 | All three groups, once                  |
| `npm run test:unit`        | `unit/`                                 |
| `npm run test:integration` | `integration/`                          |
| `npm run test:component`   | `component/`                            |
| `npm run test:watch`       | All three groups, again after each edit |

`npm run check` runs the layout check, the typecheck, the linter and the format check, then `npm test`.

To run one file, name it: `npx vitest run tests/unit/core/sessions/diff.test.ts`.

The component tests need the Chromium build that Playwright downloads. Install it once with `npx playwright install chromium`. On Linux, add `--with-deps`.

The standalone host, which `npm start` runs, is tested in two ways. `integration/collector/hosts/standalone.test.ts` runs it inside the test process against a temporary folder, with a page in it and without one, so serving the page, refusing a foreign `Host`, stopping on a signal and asking for a build are checked on every run. `integration/collector/hosts/serve.test.ts` starts `npm start` as a real process and checks the addresses and ports it refuses. No test reads `dist/`, so the counts are the same whether or not `npm run build` has been run.

### The check against the real `claude`

One block of tests is skipped in every ordinary run: "the real claude binary, run the way the collector runs it", at the end of `integration/collector/adapters/claude-code/feed.test.ts`. It runs the real `claude` binary on this machine, the way the collector runs it, and watches the sockets it holds. It reads this machine's real sessions, counts them and prints nothing of them. It samples sockets with macOS's `netstat`, so it runs on macOS only. Run it after a Claude Code update, or after changing how the command is started:

```sh
AGENT_LOOKOUT_CHECK_REAL_CLAUDE=1 npx vitest run --project integration tests/integration/collector/adapters/claude-code/feed.test.ts -t "real claude binary"
```

No test asks GitHub for a release. The Mac app's updater is tested against a release of the test's own, a server on `127.0.0.1` that answers as GitHub does, with its redirects, a `latest-mac.yml` and a zip, and the app it would replace is a made-up bundle in a temporary folder. Its helper, which would replace a real app, is a stand-in that starts nothing. On macOS the zip is made and unpacked with the real `ditto`, and elsewhere a stand-in unpacks it.

No other test reads the real `~/.claude` folder or runs the real `claude` command. No test reads the real `~/.codex` folder or the real `~/.agent-lookout` folder: every test that builds the collector names a Codex folder and a folder of status files of its own. No test reads a real git repository either. The branch finder's tests make repositories of plain files in a temporary folder, writing `.git/HEAD` themselves, so they need no git, and the sessions in the fixtures work in folders under `/Users/example`, which is in none.

### The tests against the real tmux

`integration/collector/tmux/selectPane.test.ts` runs the real `tmux`, and is skipped where tmux is not installed. Each test starts a tmux server of its own on a private socket, runs `sleep` in its panes, finds the pane a process is in and checks with tmux itself that selecting it changed the selected window, the selected pane and what an attached client shows. The server is killed when the test finishes, pass or fail. Nothing in it lists, attaches to or changes your own tmux server.

## Names and paths

A test file is named for the module it covers and sits at that module's path, with `tests/<group>/` in place of `src/`. It ends in `.test.tsx` when the module is a `.tsx` file, and in `.test.ts` otherwise. There are no exceptions: every test file names a module that exists.

| Module                                             | Test                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `src/core/sessions/diff.ts`                        | `tests/unit/core/sessions/diff.test.ts`                            |
| `src/collector/hosts/standalone.ts`                | `tests/integration/collector/hosts/standalone.test.ts`             |
| `src/dashboard/components/ui/controls/Button.tsx`  | `tests/component/dashboard/components/ui/controls/Button.test.tsx` |
| `src/dashboard/lib/shell/theme.ts`, in a real page | `tests/component/dashboard/lib/shell/theme.test.ts`                |
| `src/dashboard/styles/index.css`, the theme        | `tests/component/dashboard/styles/index.test.ts`                   |

A module can have a file in more than one group, but only one in each. `src/collector/adapters/claude-code/index.ts` has a unit test, which hands the adapter stand-ins for everything, and an integration test, which gives it real folders and real programs. Two sets of tests of one module in one group are two `describe` blocks in one file, as the opt-in check is in `feed.test.ts`.

The `unit/` and `integration/` projects run `*.test.ts`. The `component/` project runs `*.test.ts` and `*.test.tsx`, because it tests plain modules that need a page as well as components.

Tests import through the aliases `@cli`, `@core`, `@collector`, `@dashboard`, `@desktop` and `@tests`, so a test file can move without its imports changing.

## What the layout check refuses

`npm run check:layout` runs first in `npm run check`. It fails, and says where the file belongs, when:

- a test file is outside `tests/`, or in a folder no project runs;
- a test file names no module at its mirrored path, such as `nothing.test.ts` or `diff.extra.test.ts` beside `src/core/sessions/diff.ts`;
- a test file has the wrong ending for its module: `.test.tsx` for a `.ts` module, `.test.ts` for a `.tsx` one, or a `.tsx` test in `unit/` or `integration/`, which run only `.test.ts`;
- a code file in `unit/`, `integration/` or `component/` is not a test, such as a helper;
- anything under `src/` sits in a folder named `fixtures`, `__fixtures__`, `mocks`, `__mocks__`, `__tests__`, `__snapshots__`, `__screenshots__`, `test`, `tests` or `testing`, or has `.fixture.`, `.mock.`, `.stub.` or `.snap` in its name, or is named as a test setup or helper file, such as `setupTests.ts`, `test-utils.ts` or `vitest.setup.ts`;
- a file under `src/` imports from `tests/`, or from a test library.

The layout check has no test file of its own: `scripts/` has no folder under `src/` to mirror. To see it work, add one of the files above and run it.

## Fixtures

Fixtures are written by hand and are generic. Nothing in them is copied from a real machine: no session name, no folder path, no process ID, no session ID.

Use values that could belong to nobody: `demo-project` for a name, `/Users/example/code/demo` for a path, `00000000-0000-4000-8000-000000000001` for a session ID. The same rule covers values written inside a test file, and screenshots.

`fixtures/session.ts` builds one generic session, and a test overrides the fields it cares about. `fixtures/claudeCode.ts` holds output shaped like `claude agents --json` and files shaped like the session registry. `fixtures/statusFiles.ts` writes the text of a status file, which a test changes field by field.

`fixtures/codex-home/` is a folder laid out as Codex lays out its own, as `docs/adapters/codex.md` describes: session files under `sessions/YYYY/MM/DD/` that are working, idle, finished, stopped, only just begun, malformed, a subagent, an `mcp` thread, a reverted pair, a day too old, run by the Codex desktop app, and imported by that app from another agent; a resumed session in an older folder; a compressed file; an archived session; `thread-writer-locks/` with a lock for each open session and `.coordination.lock`; `session_index.jsonl`; and placeholders for the files the adapter never opens. `fixtures/codex.ts` names its sessions, says what the adapter reports for them with the clock at its `NOW`, and builds lines of the same shapes for tests that write their own. The clock is midday UTC on the day of its day folder, so the folder is today's or yesterday's in every time zone. Tests read `codex-home/` and never write in it; a test that changes files works on a copy. A link and a named pipe cannot be kept in git, so the tests that need them make them in a copy.

Product code never imports a fixture. The dashboard shows what the collector measured and nothing else.
