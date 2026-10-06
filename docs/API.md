# API

Agent Lookout's server answers a small HTTP API under `/api/`. The dashboard reads it, and so do `agent-lookout status` and `agent-lookout mcp`. It is meant for this computer only: it listens on a loopback address, and it answers only requests made to a loopback name. Every route returns JSON, and every route but two only reads.

The answers hold your session names and folder paths. Check one before you share it.

The response shapes are TypeScript types in `src/core/api.ts` and `src/core/sessions/session.ts`. Fields can be added to them. A field is never renamed or removed.

## Where it listens

| Started with                           | Address                 | Changed with                                                                                                                       |
| -------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`                            | `http://127.0.0.1:4777` | `AGENT_LOOKOUT_PORT`, and `AGENT_LOOKOUT_HOST` set to `127.0.0.1`, `localhost` or `::1`. It refuses to listen on any other address |
| `npx agent-lookout` or `agent-lookout` | `http://127.0.0.1:4777` | `--port`, which takes the place of `AGENT_LOOKOUT_PORT`, and the same settings as `npm start`                                      |
| `npm run dev`                          | `http://localhost:5173` | `npm run dev -- --port 5180`. Vite's own `--host` flag makes it listen on the network: do not use it                               |

## The rules every request passes

The handler in `src/collector/handler.ts` checks each request before it looks at the route:

- The `Host` header must be `localhost`, `127.0.0.1` or `[::1]`, with any port. Anything else, or no `Host` at all, gets 403. This is what stops DNS rebinding, where a website's own name is made to point at this computer.
- An `Origin` header, when there is one, must be `http://` or `https://` followed by one of those names and any port. Anything else gets 403.
- A request the browser marks `Sec-Fetch-Site: cross-site` gets 403.
- No answer ever carries a CORS header, so a page from anywhere else cannot read one. A browser's preflight, an `OPTIONS` request, is refused: with 403 from another site, by the checks above, and with 405 otherwise.

A program on this computer, such as `curl`, sends no `Origin` and passes these checks:

```sh
curl -s http://127.0.0.1:4777/api/sessions
```

Every answer has `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`. Every answer that is not a 200 has the body `{ "error": "<one sentence>" }`.

| Status | When                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 400    | The address, `since` or `windowMs` could not be read                                                               |
| 403    | The `Host`, the `Origin` or `Sec-Fetch-Site` above                                                                 |
| 404    | There is no route at that path                                                                                     |
| 405    | Any method but `GET`, with `Allow: GET`. `/api/jump` and `/api/history/clear` take only `POST`, with `Allow: POST` |
| 500    | Something went wrong that the server did not expect                                                                |

## Routes

| Route                              | Answers                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/health`                  | `{ ok: true, version }`                                                                |
| `GET /api/sessions`                | The latest snapshot: `{ generatedAt, sources, sessions }`                              |
| `GET /api/events?since=<epoch ms>` | `{ events }`, newest first, at most 200                                                |
| `GET /api/history?windowMs=<ms>`   | `{ points, startedAt, since, kept, restarts }`, one point for each poll, oldest first  |
| `GET /api/email`                   | `{ on, to, events, afterMs, problem, last, limitedUntil }`                             |
| `GET /api/webhook`                 | `{ on, host, events, afterMs, problem, last, limitedUntil }`                           |
| `POST /api/jump`                   | `{ ok: true, kind, place }`, with `app` for a terminal tab. One of two routes that act |
| `POST /api/history/clear`          | `{ ok: true, clearedAt }`. The other route that acts                                   |

Times are milliseconds since 1970, and lengths of time are milliseconds.

### `GET /api/health`

```json
{ "ok": true, "version": "0.1.0" }
```

### `GET /api/sessions`

The snapshot the collector made at its last poll, two seconds apart at most:

```json
{
  "generatedAt": 1791205920000,
  "sources": [
    {
      "id": "claude-code",
      "label": "Claude Code",
      "state": "ok",
      "checkedAt": 1791205920000
    }
  ],
  "sessions": [
    {
      "id": "claude-code:00000000-0000-4000-8000-000000000001",
      "source": "claude-code",
      "surface": "vscode",
      "name": "checkout-flow",
      "cwd": "/Users/example/code/storefront",
      "project": "storefront",
      "git": {
        "branch": "checkout-flow",
        "repository": { "id": "ad1b8c7a6a7a8b36", "name": "storefront" }
      },
      "status": "needs-you",
      "waitingReason": "permission",
      "startedAt": 1791204000000,
      "statusSince": 1791205668000,
      "links": {},
      "stale": false
    }
  ]
}
```

Sessions come in this order: those that need you first, longest wait first, then working, idle, finished, failed and unknown, each with the most recent change first.

| Session field    | Holds                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | Stable across polls: the source, a colon, and the agent's own id for the session                                                                                                                                                                                                                                                                                                                        |
| `source`         | `claude-code`, `codex` or `status-files`                                                                                                                                                                                                                                                                                                                                                                |
| `agent`          | The agent's own name, for a session from a status file. Left out for the others, whose agent is the source's `label`                                                                                                                                                                                                                                                                                    |
| `surface`        | `terminal`, `vscode`, `desktop`, `cloud`, `browser` or `unknown`                                                                                                                                                                                                                                                                                                                                        |
| `name`           | What the dashboard calls it                                                                                                                                                                                                                                                                                                                                                                             |
| `cwd`            | The folder it works in, or `null`                                                                                                                                                                                                                                                                                                                                                                       |
| `project`        | The last part of `cwd`, or `null`                                                                                                                                                                                                                                                                                                                                                                       |
| `git`            | `{ branch }`, or `{ commit }` with seven characters when no branch is checked out, each with `repository`. Left out when the folder is in no repository that could be read                                                                                                                                                                                                                              |
| `git.repository` | `{ id, name }`: the repository the folder belongs to, the same for its main folder and every worktree of it. `name` is the main folder's name. `id` is 16 hexadecimal characters, a hash of the path of the repository's own git folder, which its worktrees share, for telling repositories apart. Left out for a repository with no name, at the root, or a worktree whose `commondir` cannot be read |
| `status`         | `needs-you`, `working`, `idle`, `finished`, `failed` or `unknown`                                                                                                                                                                                                                                                                                                                                       |
| `waitingReason`  | For `needs-you` only: `permission`, `question` or `other`                                                                                                                                                                                                                                                                                                                                               |
| `waitingDetail`  | The agent's own words for the wait, when it gives any                                                                                                                                                                                                                                                                                                                                                   |
| `waitingText`    | For `needs-you` Claude Code sessions only: what the session is asking, in a line or two, read from the last message of its transcript, such as `Run: npm test`, `Edit: src/app.ts` or the question it put. Plain text of at most 200 characters. Left out when the transcript does not say, or with `AGENT_LOOKOUT_WAITING_TEXT=off`. No event in `/api/events`, and no history point, holds it         |
| `startedAt`      | When it started, or `null`                                                                                                                                                                                                                                                                                                                                                                              |
| `statusSince`    | When its status last changed, or `null`. It does not move while a wait goes on                                                                                                                                                                                                                                                                                                                          |
| `lastWriteAt`    | When its agent last wrote the file it is read from, for Codex and status files                                                                                                                                                                                                                                                                                                                          |
| `pid`, `alive`   | Its process and whether that still runs, when known                                                                                                                                                                                                                                                                                                                                                     |
| `links.open`     | A `vscode://` address that opens it, for a session in VS Code                                                                                                                                                                                                                                                                                                                                           |
| `jump`           | `{ kind: "tmux", place }` or `{ kind: "terminal", app, place }` when `POST /api/jump` can take you to it                                                                                                                                                                                                                                                                                                |
| `stale`          | `true` once it has been idle for 24 hours                                                                                                                                                                                                                                                                                                                                                               |

| Source field   | Holds                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`, `label`  | `claude-code` and `Claude Code`, `codex` and `Codex`, or `status-files` and `Status files`                                  |
| `state`        | `ok`, `searching`, `unavailable`, `not-set-up` or `error`                                                                   |
| `detail`       | One plain sentence: how it is being read, or what went wrong                                                                |
| `advice`       | One plain sentence saying what you can do about a problem, when the collector knows                                         |
| `watching`     | `[{ label, value }]`: what it reads and runs, and how often                                                                 |
| `basis`        | Which way the sessions were read, for a source that has more than one                                                       |
| `capabilities` | What its agent can report: for each of seven things, `{ level: "yes" }`, or `{ level: "no" }` or `"partly"` with a `reason` |
| `checkedAt`    | When it was last read                                                                                                       |

The [guide](GUIDE.md#what-each-agent-can-report) has the table `capabilities` holds.

### `GET /api/events?since=<epoch ms>`

`{ "events": [...] }`: what changed, newest first, at most 200, and with `since` only those after it. Each event is `{ id, at, sessionId, sessionName, kind, from, to, severity }`, where `kind` is `appeared`, `status-changed` or `ended`, `from` and `to` are statuses, and `severity` is `advisory`, `warning` for a change to `needs-you` or `critical` for a change to `failed`. The collector keeps the last 1,000 in memory, and with history kept on disk it reads them back when it starts again.

### `GET /api/history?windowMs=<ms>`

One point for each poll, oldest first, each `{ at, needsYou, working, idle, total }`, over the last 15 minutes or the `windowMs` given, up to six hours, with where the history begins, where it is kept and when Agent Lookout was started again:

```json
{
  "points": [{ "at": 1791204002000, "needsYou": 1, "working": 2, "idle": 3, "total": 6 }],
  "startedAt": 1791204000000,
  "since": { "at": 1790944800000, "by": "started" },
  "kept": {
    "where": "disk",
    "folder": "~/.agent-lookout/history",
    "bytes": 1468006,
    "maxBytes": 20971520,
    "maxAgeMs": 691200000,
    "canClear": true,
    "problem": null
  },
  "restarts": [{ "at": 1791204000000, "lastBefore": 1791190800000 }]
}
```

| Field       | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startedAt` | When this run of Agent Lookout began. A new one means it was started again                                                                                                                                                                                                                                                                                                                                                                |
| `since`     | Where the history it holds begins: `at`, a time, and `by`, which is `started` when Agent Lookout started watching then, `cleared` when the history was cleared then, or `trimmed` when that is the oldest history kept and what came before it was deleted for its age or the size. Time before `since.at` was not measured. With history kept on disk it can be days before `startedAt`                                                  |
| `kept`      | `where` is `disk` or `memory`, with `AGENT_LOOKOUT_HISTORY=off`. On disk, `folder` is the folder with the home folder written `~`, and `bytes` how much the files hold. `maxBytes` is the cap, 20 MB, and `maxAgeMs` how long after its day a day's history is kept, 8 days. `canClear` says whether this copy can clear it, and `problem`, while it does not write the files, one sentence saying why, such as another copy writing them |
| `restarts`  | Each time Agent Lookout started again after `since.at` with history kept from before, oldest first, this run's start among them: `at`, when it started, and `lastBefore`, the newest moment the history before it holds. Nothing was measured between the two, however close they are. Empty in memory only, and before the first restart                                                                                                 |

A poll adds no point when no source answered, or when a source that answered before did not. Two points further apart than a few polls had time between them that was not measured: the computer asleep, a source that stopped answering, or Agent Lookout not running. So had two points either side of a restart. The dashboard draws that time hatched.

After a restart, the first poll that reads a source compares each session with the last event the history kept of it. A session whose status changed while Agent Lookout was stopped gets a `status-changed` event, one that ended an `ended` event, and one back after it ended an `appeared` event, all at that poll. A session the history kept no event of is taken as it is found.

### `GET /api/email` and `GET /api/webhook`

Whether [email](GUIDE.md#email) or a [webhook](GUIDE.md#webhook) is set up, and how the last one went. They only read: both are set up in the environment Agent Lookout starts with.

| Field          | Holds                                                                                   |
| -------------- | --------------------------------------------------------------------------------------- |
| `on`           | Whether it sends                                                                        |
| `to`           | Email only: the address, with all but its first letter before the `@` hidden            |
| `host`         | Webhook only: the host the posts go to, and never the rest of the address               |
| `events`       | What is sent: `needs-you`, `finished`, `failed` and `ended`, any of them                |
| `afterMs`      | How long a wait lasts before it is sent                                                 |
| `problem`      | While off because a setting is wrong, one sentence naming the setting, never its value  |
| `last`         | `{ at, sent: true }` or `{ at, sent: false, reason }` for the last one tried, or `null` |
| `limitedUntil` | While the limit of 20 an hour holds them back, when the next may go                     |

Neither ever holds the mail server's address, its user name or its password, or the webhook's path.

### `POST /api/jump`

One of the two routes that act. It selects the tmux pane a session runs in, or brings its tab of Terminal or iTerm2 to the front, as the Jump button does. Its checks, on top of the ones every request passes, are `jumpRefusalFor` in `src/collector/jumpRoute.ts`, which makes those `actionRefusalFor` in `src/collector/handler.ts` makes for every route that acts. It answers only a request that:

- is a `POST`. Any other method gets 405, with `Allow: POST`.
- has an `Origin` that names this computer. A request with no `Origin` gets 403 here, though a read may go without one.
- is marked `same-origin` in `Sec-Fetch-Site`, when that header is sent, or gets 403.
- carries `X-Agent-Lookout-Action: jump`, or gets 403. A page at another address cannot send that header without a preflight, which is never granted.
- has `Content-Type: application/json`, or gets 415.
- has a body of 1,024 bytes or less, or gets 413, that is exactly `{ "sessionId": "..." }`, or gets 400.

The server then looks the session up in its own latest snapshot and acts on the pane or tab it found for that session's process. Nothing in the request reaches a command. It makes one jump a second, and one at a time.

| Status | Body                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 200    | `{ "ok": true, "kind": "tmux", "place": "work:2.1" }`, or `{ "ok": true, "kind": "terminal", "app": "iTerm2", "place": "iTerm2" }` |
| 404    | `reason: "no-pane"`: the session is not listed, or no pane or tab is known for it                                                  |
| 409    | `reason: "pane-gone"`, `"tmux-stopped"` or `"tab-gone"`                                                                            |
| 403    | `reason: "not-allowed"`: macOS has not allowed the program Agent Lookout runs in to control the app                                |
| 429    | `reason: "too-soon"`, with `Retry-After: 1`                                                                                        |
| 500    | `reason: "failed"`: tmux or `osascript` could not be run, or did not answer in time                                                |

Each of these has an `error` sentence beside its `reason`. [SECURITY.md](../SECURITY.md) says what the route can and cannot change.

### `POST /api/history/clear`

The other route that acts. It deletes the files the history is kept in, except any that a later version of Agent Lookout wrote, and empties the Events log and the history in memory, as Clear history in Settings does. The history then begins again from that moment, with `since` set to `{ at, by: "cleared" }`. It makes the same checks as `POST /api/jump`, with its own action, in `src/collector/history/clearRoute.ts`, and answers only a request that:

- is a `POST`. Any other method gets 405, with `Allow: POST`.
- has an `Origin` that names this computer, or gets 403.
- is marked `same-origin` in `Sec-Fetch-Site`, when that header is sent, or gets 403.
- carries `X-Agent-Lookout-Action: clear-history`, or gets 403.
- has `Content-Type: application/json`, or gets 415.
- has a body of 64 bytes or less, or gets 413, that is exactly `{}`, or gets 400.

Nothing in the request names a file: the files are the ones in the history's own folder.

| Status | Body                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| 200    | `{ "ok": true, "clearedAt": 1791204000000 }`                                                                             |
| 409    | `reason: "memory-only"`: history is kept in memory only, with `AGENT_LOOKOUT_HISTORY=off`, and there is nothing to clear |
| 409    | `reason: "not-writing"`: another copy of Agent Lookout writes the files, or they cannot be written here                  |
| 500    | `reason: "failed"`: the files could not all be deleted, and nothing in memory was emptied                                |

Each of these has an `error` sentence beside its `reason`.

## In the Mac app only

The Mac app serves the dashboard and this API from its own address, `agent-lookout://app/`, with no port, and answers four more routes there, for its updates. `npm start`, `npx agent-lookout` and `npm run dev` do not have them: there, each answers 404.

| Route                          | Body                               | Does                                                                                                                              |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/app/update`          |                                    | Where updates stand: the version, the switch, the last check, what was found and how far a download has got                       |
| `POST /api/app/update/check`   | `{}`                               | Checks GitHub now, and answers once it has                                                                                        |
| `POST /api/app/update/install` | `{}`                               | Installs the version that is ready, then quits and opens it. 409 when none is ready, or it cannot be installed where the app runs |
| `POST /api/app/update/setting` | `{ "automatic": true }` or `false` | Turns the daily check on or off                                                                                                   |

Each POST passes the checks `POST /api/jump` does, with its own `X-Agent-Lookout-Action`: `check-for-updates`, `install-update` or `update-setting`, and a body of 256 bytes or less that is exactly what the table says. Each answers with the status `GET /api/app/update` gives, `AppUpdateStatus` in `src/core/appUpdate.ts`. Nothing in a request reaches a command or a path.

## The notifications header

A dashboard page sends `X-Agent-Lookout-Notifications` on every request, to say which events its notifications are on for: `off`, `on` for a session starting to wait, or `on; events=` followed by names, such as `on; events=needs-you,finished`. Any other value, or the header sent twice, says nothing. It changes no answer. The server reads it only from a `GET` that passed the checks above, and keeps the last thing a page said, to decide whether it shows notifications itself while no page is open. [ARCHITECTURE.md](ARCHITECTURE.md#notifications-from-the-collector) has the rules.

A program that only reads should not send it. `agent-lookout status` and `agent-lookout mcp` never do, so asking leaves what the server believes about the dashboard's pages as it was.

## For this computer only

The API has no token or password. The `Host` and `Origin` rules keep websites, and other computers on the network, away from it: it listens on loopback, and a browser cannot be made to read it from another site. What they do not stop is another program on this computer, which can read it as `curl` does, and on a shared computer that includes other user accounts. [SECURITY.md](../SECURITY.md) lists that as a known limit.

A token would not keep out programs running as you, which could read it as easily as the API. It could keep out other accounts on a shared computer, the known limit above, and is left for a later version. The MCP server changes none of this: it opens no port of its own, speaks to the app that started it over stdin and stdout, and reads the same loopback API the dashboard and `agent-lookout status` read without one. A token is also for an API that can be reached some other way, such as from another computer, and Agent Lookout has none.

## The MCP server

`agent-lookout mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server for an agent that keeps track of your other agents. The agent's app starts it and speaks to it over stdin and stdout. For each tool call it reads `GET /api/sessions` once, exactly as `agent-lookout status` does: from a loopback address only, with no `Origin` and no notifications header. It has three tools, and none of them acts:

| Tool                   | Answers                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions`        | Every session, or those with the `status` given, with its id, name, agent, status, reason, folder, branch, app, since and how long it has been quiet |
| `sessions_needing_you` | The waiting sessions, longest wait first, with how long each has waited, and a sentence that sums them up                                            |
| `sources`              | Each source's state in words, and its row of what its agent can and cannot report                                                                    |

The [guide](GUIDE.md#for-your-agents) says how to add it to an agent's app and what each answer holds.
