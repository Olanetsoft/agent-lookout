# Architecture

Agent Lookout has two halves and a shared middle. The collector is Node code that asks each agent tool for its sessions every two seconds and keeps the latest answer in memory. The dashboard is a React page that polls the collector over a local HTTP API and draws what comes back. Both use the session model in `src/core/`.

## Folders

| Folder                 | Holds                                                                                                                              | Runs in                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `src/core/`            | The session model, status mapping, staleness, snapshot diffing and the rule for which waits are announced. No DOM and no Node APIs | Everywhere                 |
| `src/collector/`       | One adapter per agent tool under `adapters/`, the poller, the event and history stores and the request handler                     | Node                       |
| `src/collector/hosts/` | The standalone server behind `npm start`, and the Vite plugin that mounts the handler at `/api/*`                                  | Node                       |
| `src/dashboard/`       | The React app: `main.tsx`, `App.tsx`, `components/`, `hooks/`, `lib/`, `assets/` and `styles/`                                     | The browser                |
| `tests/`               | Every test, in `unit/`, `integration/` and `component/`, with `fixtures/` and `support/`                                           | Node and headless Chromium |
| `scripts/`             | The layout check that `npm run check` runs first                                                                                   | Node                       |
| `public/`              | Static files served as they are                                                                                                    | The browser                |
| `docs/`                | This file, the user guide, the adapter notes in `adapters/` and the screenshots in `images/`                                       | GitHub                     |

It is one npm package with no workspaces. `index.html`, `package.json` and the config files are at the root.

`src/core/` is type-checked twice. `tsconfig.app.json` checks it with the dashboard as browser code, with no Node types. `tsconfig.collector.json` checks it with the collector as Node code, with no DOM library. A Node API or a browser API in it fails the typecheck.

Production code never imports from `tests/`. ESLint refuses the import, the build has no `@tests` alias, and `scripts/check-layout.mjs` checks the same rule with nothing but Node.

[CONTRIBUTING.md](../CONTRIBUTING.md) has the rules for names and imports.

## The session model

`src/core/sessions/session.ts` defines the types that adapters produce and the dashboard consumes.

A `Session` has a stable `id`, the `source` it came from, the `surface` it runs in, a `name`, a working directory, a `status`, and the times it started and last changed status. The surface is `terminal`, `vscode`, `desktop`, `cloud`, `browser` or `unknown`. The Claude Code and Codex adapters report the first three, and `unknown` when they cannot tell.

Every tool's own states map onto six statuses: `needs-you`, `working`, `idle`, `finished`, `failed` and `unknown`. A tool may report only some of them: Codex sessions are never `needs-you` or `failed`. A session that needs you also carries a `waitingReason` of `permission`, `question` or `other`, and the vendor's own wording in `waitingDetail`. A session that has been idle for 24 hours or more has `stale` set. The time of a session's last status change must not move while it goes on needing you, because a later time on a session that is still waiting is read as a new wait.

Each poll produces a `SessionsSnapshot`: the sessions, and a `SourceHealth` for each adapter that says whether it is `ok`, `searching`, `unavailable` or in `error`, with a plain-language detail and a list of what the adapter reads and runs.

The poller compares each source's sessions with the last list that source reported successfully in the same way of reading. A session that appeared, changed status or ended becomes a `SessionEvent`. A change to `needs-you` is a warning, a change to `failed` is critical, and the rest are advisory. The first successful poll is the baseline and produces no events, because the sessions in it were already running. Each poll also appends a `HistoryPoint` with the counts per status. Its idle count leaves out stale sessions, as the Idle count on the Overview does, so the chart behind that count ends at its figure. The Last hour chart and the history charts behind the Overview's counts draw these points, and the Timeline, the Waited on you bars and the Events log use the points to tell the time that was measured from the time that was not.

Fields can be added to these types. Existing fields are never renamed or removed.

## The collector

An adapter implements the interface in `src/collector/adapters/adapter.ts`: an `id`, a `label` and a `poll()` that resolves to a health report and a list of sessions. `poll()` never throws. A failure goes into the health report.

The poller in `src/collector/poller.ts` calls every adapter every two seconds and skips a beat when the previous poll is still running. An adapter that has not answered within 15 seconds is reported as an error until it does. Events and history sit in bounded in-memory buffers: the last 1,000 events and the last 10,800 history points, which is six hours. Both are lost when the process stops. A poll in which no source answered adds no history point, so the gap is not drawn as zero. Nor does a poll in which a source that answered before fails to answer, for as long as it keeps failing, so the charts never draw a total that leaves its sessions out. A source that turns `unavailable` leaves a gap once and then counts as having no sessions.

`createCollector` in `src/collector/collector.ts` builds the two adapters, Claude Code's and Codex's, the poller, the two stores and the request handler in one call. Every host starts the collector that way.

## The API

One handler, in `src/collector/handler.ts`, answers every route. All routes are `GET` and return JSON. The response shapes are in `src/core/api.ts`.

| Route                          | Returns                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `/api/health`                  | `{ ok: true, version }`                                                                  |
| `/api/sessions`                | The latest `SessionsSnapshot`                                                            |
| `/api/events?since=<epoch ms>` | `{ events }`, newest first, at most 200                                                  |
| `/api/history?windowMs=<n>`    | `{ points, startedAt }`, one point per poll, 15 minutes by default and six hours at most |

`startedAt` is when the collector began. The dashboard marks the time before it as unmeasured instead of drawing zeros.

The handler refuses any request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`, any request with an `Origin` header that is not one of those, and any request the browser marks as `Sec-Fetch-Site: cross-site`. It sends no CORS headers. This keeps other websites, and DNS rebinding, away from session names and paths.

## The Claude Code adapter

The adapter lives in `src/collector/adapters/claude-code/`. It reads sessions from two places.

The first is the session registry: the folder `~/.claude/sessions`, where Claude Code keeps one small file for each running session, named `<pid>.json`. The adapter reads it on every poll. Reading it starts no process. The format is undocumented, so every field is optional and a malformed file is skipped. A name must end in `.json` to be read and a link is not followed, so the `.key` files in the same folder are never opened.

The second is `claude agents --json --all`, the listing command that Claude Code documents for outside tools. The adapter runs it on the first poll and every 30 seconds after that, and keeps the answer until the next run. Each run starts Claude Code's own program, which costs CPU and may contact Anthropic the way it does for anyone who runs it. That is why the command is run seldom.

The command's answer outranks the registry.

- It supplies the background jobs that are finished or failed and have no process left. The registry holds a file per live process and cannot.
- A registry session that the answer did not list is left out, unless it started too recently for the answer to have known about it.
- When the answer lists a running session the registry lacks, when a registry file has a status the mapping does not know, or when the folder cannot be read, sessions come from the command. It is then run every 5 seconds until the registry can be relied on again.

When the command cannot be found, or fails, the registry is used alone and the health detail says so. If the registry cannot be read either, the source is `unavailable` and the detail names where the adapter looked.

The adapter looks for the `claude` binary on `PATH`, then at `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and `/usr/local/bin/claude`. The fixed locations are there because an app started from the Finder does not inherit the shell's `PATH`.

It starts the command directly, with no shell, with stdin closed and a five second timeout. Shell wrappers and hooks can print before or after the list, so the adapter takes the first JSON array on stdout that holds a session and ignores the rest. A Claude Code too old to know `--all` is asked without it, and its finished jobs are not listed.

A registry file can outlive a crashed session. The adapter checks that each process still exists with `process.kill(pid, 0)`. It also asks `ps` when the process started and compares that with the start time in the registry file, to catch a process ID that has since gone to another program.

`src/core/mapping/claudeCodeMapping.ts` holds the mapping. `busy` becomes `working`, `waiting` becomes `needs-you` and `idle` stays `idle`. The registry's `shell` is `working` too. A background session also has a `state`: `working` stays `working`, `blocked` becomes `needs-you`, `done` and `stopped` become `finished`, and `failed` stays `failed`. A live `busy` or `waiting` wins over the `state`. A live `idle` gives way to a `state` that says more. A value the mapping does not recognise becomes `unknown`. `waitingFor` gives the reason: `permission prompt` is `permission`, `input needed` is `question` and anything else is `other`.

A background job that is finished or failed, with no process left, stays in the list for 24 hours and is then left out. The 24 hours are counted from the moment the collector first saw the job over. For a job that was already over when the collector started, they are counted from its start time. `finishedJobs.ts` in the adapter's folder does this. Any other session that ends leaves the list, and the poller records an `ended` event for it.

A session in VS Code gets a `links.open` of `vscode://anthropic.claude-code/open?session=<sessionId>`. Other surfaces have no link.

The [guide](GUIDE.md#settings-you-can-change) lists the settings that change where the adapter looks. One of them needs a reason: when `AGENT_LOOKOUT_CLAUDE_HOME` replaces `~/.claude`, a `claude` found on the machine is not run, because it would list the sessions of the usual folder.

## The Codex adapter

The adapter lives in `src/collector/adapters/codex/`. [adapters/codex.md](adapters/codex.md) is its reference: every file it reads and how often, which sessions are listed, the full status table, the Codex version it was checked against and what breaks when Codex changes.

Codex documents no way to list its sessions that works without starting Codex's own server, which writes to its folder, or without editing its config to add hooks. So the adapter reads files alone and runs no program. Nothing it reads is documented.

Each poll lists the day folders for today and yesterday under `sessions/` and reads the `rollout-*.jsonl` files in them. From each file it reads the first `session_meta` line, for the session's folder, start time and source, and the last line that says a turn started or ended. After that it reads only what was appended. It lists `thread-writer-locks/`, where Codex keeps a lock for each session a Codex process has open, and never opens those files. It reads `session_index.jsonl` for the names people give sessions. `io.ts` opens only ordinary files, never a link or a pipe, and `rolloutFile.ts` bounds every read.

`src/core/mapping/codexMapping.ts` maps the last turn line and the lock to a status. A turn under way is `working`, a turn that is over is `idle`, and a session whose lock has gone is `finished`. Codex does not write approval waits to these files, so a Codex session is never `needs-you`: one that is waiting for approval is in a turn that has started, and shows as `working`. Codex older than 0.155 keeps no locks, so a session it created is never `finished`. The health detail states each limit when it applies.

The Codex folder is `AGENT_LOOKOUT_CODEX_HOME` if set, then Codex's own `CODEX_HOME`, then `~/.codex`. When it is missing, the source is `unavailable`, and the adapter looks for it again once a minute with one `stat`. Polls in between touch nothing. A folder named by `AGENT_LOOKOUT_CODEX_HOME` that holds no `sessions/` is an answer instead: the source is `ok` with no sessions.

A session's id is `codex:<thread id>`. A Codex session has no process ID and no link, so it has no Jump button.

## Hosts

The same collector and the same dashboard are meant to run under more than one host. Three seams make that possible.

On the server side, the handler has a Node-style `(req, res)` signature and knows nothing about what mounts it. Two hosts mount it today, and both are in `src/collector/hosts/`. `collectorPlugin.ts` mounts it inside Vite's server for `npm run dev` and `npm run preview`. `standalone.ts` is the standalone server: `runStandalone` serves the built files and the API on `127.0.0.1`, on port 4777 or `AGENT_LOOKOUT_PORT`, and stops on SIGINT or SIGTERM. It takes the folder of built files, the environment, where to print and the process to stop as arguments, so tests run it against a temporary folder. `serve.ts` is the entry that `npm start` runs, and calls it with `dist/` and this process's environment. `server.ts` and `staticFiles.ts` hold its HTTP server and its file handler. `AGENT_LOOKOUT_HOST` can move it to `::1`, and it refuses to bind to any address that is not loopback.

On the dashboard side, every request goes through `apiRequest(path, init)` in `src/dashboard/lib/api/apiHost.ts`. It has the shape of `fetch` and defaults to a same-origin request. It accepts only root-relative paths, so the dashboard cannot name another host. `setApiHost` replaces the transport, which is how a desktop window or a browser extension could supply the data without an HTTP server. Neither of those hosts exists yet.

Notifications have a seam of the same kind. `notificationHost()` in `src/dashboard/lib/notifications/notificationHost.ts` says what the permission is, asks for it and shows a notification, and defaults to the browser's Notifications API. `setNotificationHost` replaces it, which is how a desktop app could show native notifications.

## The dashboard

`src/dashboard/App.tsx` puts a rail down the left edge and, beside it, the header over the current view. The rail, in `components/rail/Rail.tsx`, links to three views: Overview, Sources and Settings. Each view has its own address in the URL fragment, `#overview`, `#sources` or `#settings`, which `lib/shell/view.ts` reads, so the back button, a reload and a bookmark land on the same view. Choosing one replaces the view in `<main>` and moves focus there, and the rail and the header stay. A fault inside a view is caught there and leaves the rail and the header standing.

The Overview holds the Needs you panel, the Last hour chart, the Sessions list, the Events log and the Timeline. It leaves out a tool that was not found, unless none was, so someone who uses one tool sees what they would if only that one were watched. The Sources view shows each source's health and the facts it reports about what it reads and runs. Settings holds the theme and the choice of whether to be notified.

The Needs you panel, in `components/hero/`, lists the sessions that need you, longest wait first, and the Sessions list leaves them out. Under them the Waited on you bars draw how long each session waited, which `lib/sessions/waits.ts` works out with `lib/charts/timeline.ts` over the time the page holds, and the panel ends with the counts of sessions working, idle and stale, and of every session. The Last hour chart, built in `lib/charts/lastHour.ts`, takes the mean of the history's counts over each five minutes of the clock. Once more than one tool is found, each row of the Sessions list names its tool in plain text, from the source's `label`, in an Agent column. When the card is too narrow for every column, the App column gives way first, then the Folder column. The Events log, built in `lib/sessions/events.ts`, adds a row wherever the history shows a break in the polls. The Timeline, built in `lib/charts/timeline.ts`, draws each session's status over the last hour from the snapshot, the events and the history, and hatches each row where that session's status is not known. The Timeline, the Last hour chart and the Waited on you bars all take the time that was measured from `lib/charts/measured.ts`, so they agree on it.

`src/dashboard/lib/api/collectorStore.ts` polls `/api/sessions`, `/api/events` and `/api/history` every two seconds and never starts a poll while the last one is still running. It holds the last hour of history: it asks for the whole hour at first, then for the last 15 minutes on each beat, which it joins to what it holds. If the collector stops answering for more than five seconds, the last good data stays on screen under a notice that says when it was read. Durations tick every second from the clock in `src/dashboard/hooks/data/useNow.ts`, using the timestamps already loaded, without another request.

The store polls on a beat it is handed, and `lib/api/beat.ts` has two. `timerBeat` is the page's own timer and the default. `workerBeat`, which the app gives its own store, is a worker, `lib/api/beatWorker.ts`, that keeps time and does nothing else. A browser can slow the timers of a page in a background tab to as little as one a minute, and a worker's timer is not slowed that way in Chrome, where this was measured. So the page goes on polling its own server every two seconds while its tab is hidden, and learns that a session is waiting without that delay. If the worker cannot be made, fails, or is not heard from within ten seconds, the beat falls back to the page's timer. The worker is loaded from the app's own address, which the standalone server's `script-src 'self'` allows.

A session that starts waiting can send a notification. `waitChanges` in `src/core/sessions/waitChanges.ts` decides which sessions: it compares each snapshot with what it remembered from the one before, and returns the sessions that began to need you and the ids of those that stopped. Only a source that is `ok` is compared, and a source's first `ok` answer is a baseline that announces nothing, as in the poller. A session that still needs you, with a later status time than its wait has been seen with, was answered and asked again between two polls, so it has stopped and started. A new reason on the same wait, with no later status time, announces nothing. When a source gives no status time, two waits less than a poll apart are seen as one.

`lib/notifications/waitNotifier.ts` carries that out through the notification host. For each session that started it shows one notification, with the session's name as the title, the reason in the Needs you panel's words as the body, and the tag `agent-lookout:<session id>`. It closes the notification of each session that stopped. When `/api/history` gives a new `startedAt`, the collector has been restarted under an open page, and the notifier begins again from a baseline. `hooks/notifications/useWaitNotifications.ts` runs it from `App.tsx`, on every view. It listens to the store itself, not to a render, so it works while the tab is hidden, and it closes every notification when notifications are turned off and on `pagehide`.

Two pages open at one address give a wait the same tag, so the browser keeps one notification for both, and only the page that made it can close it. A page that leaves therefore names the sessions whose notifications it closed on a `BroadcastChannel`, in `lib/notifications/notificationHandover.ts`, and a page that stays shows them again for the sessions it still sees waiting.

`lib/notifications/notificationSetting.ts` keeps the choice, `on` or `off`, in local storage under `agent-lookout-notifications`. It is off by default. A notification is sent only while the choice is on and the browser's permission is granted, and both are read at the moment of sending. `turnOnNotifications` is the only code that asks for permission, and the Settings card calls it from a click.

The interface is built from the tokens in `src/dashboard/styles/index.css` and the primitives in `src/dashboard/components/ui/`.

## Tests

`vite.config.ts` defines three Vitest projects and picks a test's project by its folder. `tests/unit/` and `tests/integration/` run in Node. `tests/component/` runs in headless Chromium, because those tests assert computed styles and layout. A test sits at the path of the module it covers, with `tests/<group>/` in place of `src/`.

The config leaves the collector plugin out of test runs, so a test never starts the poller or reads real sessions from the machine it runs on.

[tests/README.md](../tests/README.md) says what belongs in each folder and how to run each group.
