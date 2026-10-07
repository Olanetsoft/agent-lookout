# Tests

Every test, fixture and test helper lives in this folder. Nothing under `src/` is a test, and nothing under `src/` imports from here.

## What goes where

| Folder         | Holds                                                                                                                                                                                    | Runs in           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `unit/`        | Tests of one module. No sockets, no child processes, no real files. What a module needs from outside is passed in                                                                        | Node              |
| `integration/` | Tests that open a socket, start a server, start a process or touch the real file system                                                                                                  | Node              |
| `component/`   | React components, and the dashboard code that needs a real page, such as the theme and the stylesheet                                                                                    | Headless Chromium |
| `fixtures/`    | Session data shared by tests: `session.ts`, `claudeCode.ts`, `claudeTranscript.ts`, `codex.ts`, `antigravity.ts`, `statusFiles.ts`, `waits.ts`, `remote.ts` and the folder `codex-home/` |                   |
| `support/`     | Setup files and helpers                                                                                                                                                                  |                   |

The Claude Code plugin is the one thing outside `src/` with tests of its own: `integration/plugins/agent-lookout/hooks/ask-agent-lookout.test.ts` runs its hook script, as Claude Code would, against a stand-in socket of the test's own. No test runs Claude Code, installs the plugin or opens the socket in `~/.agent-lookout`: `nodeSetup.ts` sets `AGENT_LOOKOUT_ANSWER=off`, and a test of answering names a socket in a temporary folder with `AGENT_LOOKOUT_ANSWER_SOCKET`.

A test that only calls functions belongs in `unit/`, even when the module is part of the dashboard, and even when the module would touch files or start programs if it were not handed stand-ins. A test goes in `integration/` as soon as it needs something real from the operating system. A test goes in `component/` when it renders, or when it reads computed styles, local storage or a media query.

`unit/`, `integration/` and `component/` hold tests and nothing else. A helper two test files share goes in `support/`, and data they share goes in `fixtures/`.

The helpers in `support/`:

- `componentSetup.ts` loads the stylesheet before every component test, so tokens and fonts resolve as they do in the app, and starts each test on a computer that asks for no less motion than usual. Windows Server, as CI runs it, has its animations off, which the browser there reads as a wish for less motion.
- `browser.ts` moves the pointer away and puts the keyboard at the top of the page.
- `colours.ts` reads the colours the page computed: a token in the current theme, every colour a token holds, the contrast of two colours, and anything on the page painted in a warm colour. The needs-you tokens and the lamp's light are the only warm colours in the interface, so warm paint anywhere else is amber where amber does not belong. A colour counts as warm by its chroma, so the faint warmth in the blacks, greys and near-white ink is not mistaken for amber.
- `pixels.ts` reads what the browser drew, for what the DOM cannot say: where the hatch shows, whether two patterns line up, and how words read on glass. `textBackdrops` gives each run of words under an element with the worst of what is drawn behind it, the brightest 3% of those pixels at Night or the darkest 3% by Day, so contrast is measured against the glass and the light behind the words. The glyphs are hidden with transitions off, so a word that fades on hover is gone at once and the screenshot never catches it half drawn.
- `lines.ts` reads where the browser broke a string across lines: how many lines an element's text is drawn on, and, for each piece of it a pattern finds, such as each word of a command or each name of a path with its slash, how many lines that piece is drawn across. A piece a line break runs through is on two. It measures the text itself, so it reads what was drawn whatever elements hold the text.
- `notifications.ts` holds two stand-ins for the notification system. Neither shows anything or asks anybody. `fakeNotificationHost` is put in place with `setNotificationHost`: it writes down what it was asked to show and close, answers a request for permission the way the test says the person would, and lets a test dismiss a notification as a person can. Like a browser, it keeps one notification for each tag, so a second with the same tag takes the place of the first, which is how two pages open at one address share a notification. It has no DOM in it, so the unit tests use it too. `StubNotification` takes the place of the browser's own `window.Notification`, with `installStubNotification`, for tests of the dashboard's own host and of the app over it: it writes down each question, each notification made of it and when, and each close. No test asks the real browser for permission or shows anything on this machine.
- `media.ts` sets what the computer says it prefers, reduced motion or a light or dark colour scheme, for one test. It uses the `emulateMedia` command that `vite.config.ts` gives the component project.
- `claudeCodeAdapter.ts` builds the Claude Code adapter cut off from this machine: a fixed clock, a pretend binary and invented processes. The unit and the integration tests of the adapter both use it. It touches no file and no process: an adapter given a stand-in registry is given `noTranscripts` too, a Claude Code folder with no transcripts in it.
- `codexAdapter.ts` builds the Codex adapter cut off from this machine: a fixed clock and a file system held in memory that writes down every call. The adapter is handed only its four reading methods; a test changes the files through the other side. It also runs code in another time zone, because Codex names its day folders by the local date.
- `antigravityAdapter.ts` builds the Antigravity CLI adapter cut off from this machine: the same file system held in memory, and a stand-in for `ps` that says which agy programs run, which the test changes, and counts how often it was asked.
- `http.ts` starts a server on a free loopback port, finds a free port with nothing listening on it, and sends a request exactly as written, with a body when the test gives one.
- `smtp.ts` starts a mail server of the test's own on a free port of `127.0.0.1`. It speaks just enough SMTP for the collector's mail library, writes down each connection and each email with its sign-in, its recipients and the message as sent, and passes nothing on. It can also turn every connection away, or accept one and never answer, and it can speak TLS from the first byte, as an `smtps://` server does, with a certificate from `selfSigned.ts`, which makes a key and a certificate that names itself as its issuer for each run, so no key is kept in the repository. It decodes a received message's headers and text the way a mail program would. No test sends an email anywhere else.
- `webhook.ts` starts a webhook of the test's own: an HTTP server on a free port of `127.0.0.1` that writes down each connection and each request, with its path, its headers in the order and case they were sent, and its body, and passes nothing on. It answers 200 as a Slack incoming webhook does, or a redirect, a refusal or a failure, or any status a test names, or reads the request and never answers. It stands in for an ntfy server and for Pushover's API too, and can speak HTTPS with a certificate from `selfSigned.ts`, which a client that checks certificates refuses. No test posts to a webhook, pushes to ntfy or Pushover, or reaches any other service: the Pushover sender is aimed at the stand-in through its `endpoint` option, which no setting reaches.
- `systemNotifier.ts` holds a stand-in for the notifier the collector shows its own notifications with, the seam in `src/collector/notifications/systemNotifier.ts`. It writes down what it was asked to show, and the session each was about, and shows nothing. Every test that builds a collector in which a wait begins passes it, with an environment of the test's own, so no test raises a notification on this machine. The script that shows one is never run by a test: `integration/collector/notifications/systemNotifier.test.ts` runs the real `osascript`, on macOS only, with a script that only gives its arguments back.
- `desktop/electronStandIns.ts` holds stand-ins for the parts of Electron the Mac app's main process hands its modules: `fakeNotifications` for the `Notification` class, which writes down each notification it makes, and `FakeNotification`, which a test clicks or presses a button of; `FakeMenu`, a menu with a menu of its own for each submenu, which a test opens, opens a submenu of and leaves it, as Electron tells the top menu of each too, and clicks an item in, the menu closing first as it does; and `FakeTray`, the item in the menu bar, which writes down what it is told. None shows anything on the machine the tests run on.
- `plugins/permissionHook.ts` runs the Agent Lookout plugin's own hook script as Claude Code runs it, with a permission request of the test's own on stdin, against a socket the test names, and hands back what it printed. No Claude Code is run.
- `tmux.ts` holds two stand-ins for a person's tmux. `fakeTmux` runs nothing: it writes down each command it is given and answers as tmux would, from the panes and clients a test sets, and can be told that tmux has stopped. It has no Node API in what it answers, so the unit tests use it too. `privateTmux` is the real tmux on a server of the test's own, on a socket named for that test and with no configuration file read. The server, its panes and any client attached to it are stopped when the test finishes, however it ends. No test asks or changes the tmux server a person is using. A test that builds the collector with its real Claude Code adapter passes its own way of running tmux or sets `AGENT_LOOKOUT_TMUX=off`, and the adapter built on its own looks for no pane.
- `terminal.ts` holds stand-ins for a person's Terminal and iTerm2. `fakeOsascript` runs nothing: it writes down the arguments of each run and answers as `osascript` would, with `found`, `missing`, macOS's error -1743 or a run that ran out of time, and can hold its answer as a run does while macOS asks the person. `fakeProcesses` is a table of processes as `ps` would print it, so a test chooses which app a session seems to run in, and counts how often it is read. No test runs `osascript` against Terminal or iTerm2, or asks macOS for permission: `integration/collector/processes/osascript.test.ts` runs the real `osascript`, on macOS only, with scripts that name no app. A test that builds the collector with its real Claude Code adapter and sessions whose processes are real passes both.
- `standIns.ts` starts stand-ins for Claude Code sessions' processes, for the tests of Stop and of ending the sessions left running: small Node programs the test starts itself that wait until they are stopped, one of them paying SIGTERM no heed, with the start time `ps` gives each, to write in a registry file of the test's own. `startStandInChain` starts three, each the parent of the next, in a process group of their own, so a test can stand the last in for Agent Lookout and check that the first, a session above it, is never stopped. Each is the test's own and is ended when its test finishes. No test signals a process it did not start, and none runs the real `claude stop`: a background job's test stops its stand-in with a stub `claude` from `tempFiles.ts`.
- `tempFiles.ts` makes temporary directories, stand-ins for the Claude Code and Codex folders and stub programs. Each is removed when its test finishes. `makeCodexHome` can start from a copy of `fixtures/codex-home`, for a test that changes files. A stub program is a POSIX sh script, which Windows cannot run, so `writeWindowsStub` makes one for Windows: this Node, linked under a program's name, `claude.exe` unless the test names another such as `gh.exe`, with a preload named in the `NODE_OPTIONS` it returns, which runs the test's code only in that program and does nothing in any other Node.
- `paths.ts` gives a path as the tests write it, `/Users/example/.codex`, from one the code joined by Windows' rules, `D:\Users\example\.codex`. The stand-ins that keep files in memory key them that way, so they meet the code on every system.
- `historyFs.ts` is a history folder held in memory, for the unit tests of the history keeper and its lock. It writes down every change it is asked to make, can hold a link, a folder or a pipe where a file should be, and can be made to fail every write.
- `remotes/standIns.ts` holds stand-ins for another machine read over SSH. `makeStandInSsh` writes a program named `ssh` in a folder of the test's own that runs `remotes/standInSsh.mjs` with Node. That program takes the arguments Agent Lookout gives ssh, writes each run's process ID and arguments to a log, and forwards the port to `127.0.0.1` on this machine, as ssh would once signed in. A target with `refuse` in it is turned away with `Permission denied (publickey).`, and SIGHUP stands in for the machine closing the connection. With `STAND_IN_SSH_IGNORE_TERM` set it pays SIGTERM no heed, so only SIGKILL ends it. It reads no ssh config, key or agent and connects nowhere else. `startStandInLookout` is the Agent Lookout at the far end: a server on a free port of `127.0.0.1` that answers `/api/health` and `/api/sessions` and writes down each request. Every run still going is ended when its test finishes. No test runs the real `ssh` or reads `~/.ssh`.
- `nodeSetup.ts` runs before every unit and integration test file and sets `AGENT_LOOKOUT_HISTORY=off`, `AGENT_LOOKOUT_PULL_REQUESTS=off` and `AGENT_LOOKOUT_SETTINGS_FILE` in `process.env`, so a collector built from the process's environment writes no history, never runs the real `gh`, and reads its time rules from a file that is not there, whatever the shell running the tests has set. A test that builds its own environment for a collector, or for a process it starts, sets `AGENT_LOOKOUT_HISTORY=off` there too, or points `AGENT_LOOKOUT_HISTORY_DIR` at a temporary folder, and sets `AGENT_LOOKOUT_SETTINGS_FILE` to `NO_SETTINGS_FILE` from `node/tempFiles.ts`, or to a file in a temporary folder when it changes a rule. No test reads or writes the history folder or the settings of the person running the tests. It also sets `AGENT_LOOKOUT_ANSWER=off`, so no collector opens the answer socket in `~/.agent-lookout`, and removes `AGENT_LOOKOUT_NTFY_URL`, `AGENT_LOOKOUT_NTFY_TOKEN`, `AGENT_LOOKOUT_PUSHOVER_TOKEN` and `AGENT_LOOKOUT_PUSHOVER_USER`, so no collector built from `process.env` pushes to a phone. A collector given adapters of its own opens none either, unless it is given `answering`.

On Windows, a test of something Windows does not have, a POSIX sh script, a Unix socket, `ps`, tmux, `osascript`, a POSIX signal, a named pipe or POSIX file modes, is skipped, with a line above it that says why. A few run on Windows only, such as those that run a stand-in `claude.exe`.

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

No test runs the real `gh` or asks GitHub about a pull request either. `integration/collector/github/gh.test.ts` runs a stand-in: a shell script named `gh`, or on Windows a `gh.exe` from `writeWindowsStub`, in a folder of the test's own that is the whole of its `PATH`, which writes down its arguments and answers as `gh` does, and the places `gh` is usually installed are not looked in. Every other test that turns `AGENT_LOOKOUT_PULL_REQUESTS` on hands the collector a stand-in for asking `gh`, and the repositories it reads are plain files in a temporary folder.

No other test reads the real `~/.claude` folder or runs the real `claude` command. No test reads the real `~/.codex` folder, the real `~/.gemini` folder or the real `~/.agent-lookout` folder: every test that builds the collector names a Codex folder, an Antigravity CLI folder and a folder of status files of its own, and `support/node/nodeSetup.ts` points `AGENT_LOOKOUT_ANTIGRAVITY_HOME` at an empty folder for a collector built from `process.env`. The one test that asks the real `ps` for agy programs finds a stand-in of its own: this Node, started through a link named `agy`. No test reads a real git repository either. The branch finder's tests make repositories of plain files in a temporary folder, writing `.git/HEAD` themselves, so they need no git, and the sessions in the fixtures work in folders under `/Users/example`, which is in none.

### The tests against the real tmux

`integration/collector/tmux/selectPane.test.ts` runs the real `tmux`, and is skipped where tmux is not installed, and on Windows. Each test starts a tmux server of its own on a private socket, runs `sleep` in its panes, finds the pane a process is in and checks with tmux itself that selecting it changed the selected window, the selected pane and what an attached client shows. The server is killed when the test finishes, pass or fail. Nothing in it lists, attaches to or changes your own tmux server.

### The examples in the guide

`integration/collector/adapters/status-files/index.test.ts` takes the Python and the Node.js examples from "Your own agents" in `docs/GUIDE.md`, as published, and runs them with `python3` and with the Node that runs the tests, each in a folder of its own, with `HOME`, `USERPROFILE`, which Windows keeps the home folder in, and `AGENT_LOOKOUT_STATUS_DIR` pointed at temporary folders. Each wait in them is replaced by a stop that lasts until the test lets it go on, so a run takes well under a second, and the real status-file source reads what they write. The Python example is skipped where `python3` is not installed.

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

`fixtures/session.ts` builds one generic session, and a test overrides the fields it cares about. `fixtures/waits.ts` builds an answer of `GET /api/waits` in which no session waited, for the tests of the Overview that are not about the Waits card. `fixtures/claudeCode.ts` holds output shaped like `claude agents --json` and files shaped like the session registry. `fixtures/statusFiles.ts` writes the text of a status file, which a test changes field by field.

`fixtures/codex-home/` is a folder laid out as Codex lays out its own, as `docs/adapters/codex.md` describes: session files under `sessions/YYYY/MM/DD/` that are working, idle, finished, stopped, only just begun, malformed, a subagent, an `mcp` thread, a reverted pair, a day too old, run by the Codex desktop app, and imported by that app from another agent; a resumed session in an older folder; a compressed file; an archived session; `thread-writer-locks/` with a lock for each open session and `.coordination.lock`; `session_index.jsonl`; and placeholders for the files the adapter never opens. `fixtures/codex.ts` names its sessions, says what the adapter reports for them with the clock at its `NOW`, and builds lines of the same shapes for tests that write their own. The clock is midday UTC on the day of its day folder, so the folder is today's or yesterday's in every time zone. Tests read `codex-home/` and never write in it; a test that changes files works on a copy. A link and a named pipe cannot be kept in git, so the tests that need them make them in a copy.

Product code never imports a fixture. The dashboard shows what the collector measured and nothing else.
