# API

Agent Lookout's server answers a small HTTP API under `/api/`. The dashboard reads it, and so do `agent-lookout status` and `agent-lookout mcp`. It is meant for this computer only: it listens on a loopback address, and it answers only requests made to a loopback name. Every route returns JSON, and every route but eight only reads.

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

| Status | When                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 400    | The address, `since` or `windowMs` could not be read                                                    |
| 403    | The `Host`, the `Origin` or `Sec-Fetch-Site` above                                                      |
| 404    | There is no route at that path                                                                          |
| 405    | Any method but `GET`, with `Allow: GET`. The eight routes that act take only `POST`, with `Allow: POST` |
| 500    | Something went wrong that the server did not expect                                                     |

## Routes

| Route                                 | Answers                                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                     | `{ ok: true, version }`                                                                                                                                                                              |
| `GET /api/sessions`                   | The latest snapshot: `{ generatedAt, sources, sessions, answering, timeRules, quiet }`                                                                                                               |
| `GET /api/events?since=<epoch ms>`    | `{ events }`, newest first, at most 200                                                                                                                                                              |
| `GET /api/history?windowMs=<ms>`      | `{ points, startedAt, since, kept, restarts }`, one point for each poll, oldest first                                                                                                                |
| `GET /api/email`                      | `{ on, to, events, afterMs, asking, problem, last, limitedUntil }`                                                                                                                                   |
| `GET /api/webhook`                    | `{ on, host, events, afterMs, asking, problem, last, limitedUntil }`                                                                                                                                 |
| `GET /api/ntfy`                       | `{ on, host, tokenSet, events, afterMs, asking, problem, last, limitedUntil }`                                                                                                                       |
| `GET /api/pushover`                   | `{ on, events, afterMs, asking, problem, last, limitedUntil }`                                                                                                                                       |
| `GET /api/pull-requests`              | `{ on, problem, gh, last }`: whether each branch's pull request is shown                                                                                                                             |
| `GET /api/waits`                      | `{ at, today, sevenDays, since, where }`: how long sessions waited on you                                                                                                                            |
| `GET /api/settings`                   | `{ timeRules, file, problem, permissionRules, permissionRulesProblem, ruleAnswers, ruleAnswersSince }`: the time rules, the permission rules, the file they are kept in, and what the rules answered |
| `POST /api/jump`                      | `{ ok: true, kind, place }`, with `app` for a terminal tab. One of eight routes that act                                                                                                             |
| `POST /api/history/clear`             | `{ ok: true, clearedAt }`. A route that acts                                                                                                                                                         |
| `POST /api/sessions/stop`             | `{ ok: true }` once the session's process has ended. A route that acts                                                                                                                               |
| `POST /api/sessions/clean-up`         | `{ results }`, what became of each session left running. A route that acts                                                                                                                           |
| `POST /api/permission/answer`         | `{ ok: true, decision }` once a permission prompt was answered. A route that acts                                                                                                                    |
| `POST /api/settings/time-rules`       | `{ ok: true, timeRules }` once the time rules are saved. A route that acts                                                                                                                           |
| `POST /api/settings/permission-rules` | `{ ok: true, permissionRules }` once one change to the permission rules is saved. A route that acts                                                                                                  |
| `POST /api/phone/test`                | `{ ok: true, channel, sentAt }` once a test push went through ntfy or Pushover. A route that acts                                                                                                    |

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
  ],
  "timeRules": {
    "longWait": { "on": true, "minutes": 10 },
    "idle": { "on": false, "hours": 48 },
    "quietHours": {
      "on": true,
      "from": "22:00",
      "to": "08:00",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "leaveOutAnswered": false
    }
  },
  "quiet": false
}
```

`timeRules` are the [time rules](GUIDE.md#time-rules) in force when the snapshot was made, as `GET /api/settings` gives them. Every session's `stale` follows the idle rule, worked out again at each poll whatever its source said, and the dashboard's notifications follow the reminder by them, at the snapshot's `generatedAt`. `quiet` says whether the snapshot was made in quiet hours, by the clock and time zone of the computer Agent Lookout runs on, and the dashboard holds its notifications by it rather than by its own clock. A session on another machine is stale by this computer's idle rule, and its waits are reminded of and held back here by this computer's rules: the `timeRules` and `quiet` in that machine's own snapshot are not read.

Sessions come in this order: those that need you first, longest wait first, then working, idle, finished, failed and unknown, each with the most recent change first.

| Session field     | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | Stable across polls: the source, a colon, and the agent's own id for the session. A session on another machine has that machine's own id for it after its source: `remote:devbox:claude-code:…`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `source`          | `claude-code`, `codex` or `status-files`, or for a session on another machine `remote:` and the machine's name, such as `remote:devbox`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `agent`           | The agent's own name, for a session from a status file, and for a session on another machine, such as `Claude Code`. Left out for the others, whose agent is the source's `label`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `machine`         | The other machine it runs on, as `AGENT_LOOKOUT_REMOTES` names it: letters, digits and dashes, such as `devbox`. Left out for a session on this computer. Such a session has no `pid`, `links.open`, `jump`, `stop`, `ask` or `git.pullRequest`, since those act on this computer or are read from its folders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `surface`         | `terminal`, `vscode`, `desktop`, `cloud`, `browser` or `unknown`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `name`            | What the dashboard calls it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cwd`             | The folder it works in, or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `project`         | The last part of `cwd`, or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `git`             | `{ branch }`, or `{ commit }` with seven characters when no branch is checked out, each with `repository`. Left out when the folder is in no repository that could be read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `git.repository`  | `{ id, name }`: the repository the folder belongs to, the same for its main folder and every worktree of it. `name` is the main folder's name. `id` is 16 hexadecimal characters, a hash of the path of the repository's own git folder, which its worktrees share, for telling repositories apart. Left out for a repository with no name, at the root, or a worktree whose `commondir` cannot be read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `git.pullRequest` | With `AGENT_LOOKOUT_PULL_REQUESTS=on` only, for a branch whose pull request on github.com your own `gh` found: `{ number, title, state, checks, url }`. Described below. Left out with the setting off, for a commit, for the default branch, for a branch named with digits alone, such as `51`, for a repository with no remote on github.com, for a branch with no pull request, and for a session on another machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `status`          | `needs-you`, `working`, `idle`, `finished`, `failed` or `unknown`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `waitingReason`   | For `needs-you` only: `permission`, `question` or `other`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `waitingDetail`   | The agent's own words for the wait, when it gives any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `waitingText`     | For `needs-you` Claude Code sessions only, and sessions on another machine whose Agent Lookout sent it: what the session is asking, in a line or two, read from the last message of its transcript, such as `Run: npm test`, `Edit: src/app.ts` or the question it put. Plain text of at most 200 characters. Left out when the transcript does not say, or with `AGENT_LOOKOUT_WAITING_TEXT=off`. No event in `/api/events`, and no history point, holds it. An email, a webhook post or a push holds it only with `AGENT_LOOKOUT_EMAIL_ASKING=on`, `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, `AGENT_LOOKOUT_NTFY_ASKING=on` or `AGENT_LOOKOUT_PUSHOVER_ASKING=on`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `startedAt`       | When it started, or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `statusSince`     | When its status last changed, or `null`. It does not move while a wait goes on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lastWriteAt`     | When its agent last wrote the file it is read from, for Codex and status files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pid`, `alive`    | Its process and whether that still runs, when known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `links.open`      | A `vscode://` address that opens it, for a session in VS Code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `jump`            | `{ kind: "tmux", place }` or `{ kind: "terminal", app, place }` when `POST /api/jump` can take you to it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `stop`            | `{ how: "signal" }` or `{ how: "background" }` when `POST /api/sessions/stop` can stop it: a Claude Code session in a terminal or VS Code, or a background job. It holds nothing else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ask`             | For `needs-you` Claude Code sessions with the Agent Lookout plugin only, while Agent Lookout holds the session's permission request: `{ requestId, tool, command, description, inputs, allow, denyOnly, subagent, until }`. `command` is the whole command for `Bash`, every line, and `inputs` is `[{ name, value }]`, each input as text, for any other tool or the rest of a command's. `allow` says whether `POST /api/permission/answer` takes `allow`, which it does only when the whole of what is allowed is here: never for `Edit`, `Write`, `MultiEdit` or `NotebookEdit`, and not for `ExitPlanMode` or `AskUserQuestion`, past 4,000 characters or 40 lines, with a character that cannot be shown as it is, with more than two blank lines in a row, or for a command holding right-to-left letters, with `denyOnly` saying why: `edit`, `too-long`, `hidden-characters`, `not-yes-or-no`, `right-to-left` or `blank-lines`. `until` is when the request is let go. Kept in memory only while it is held: no event, history point, email, webhook post, push or answer of `agent-lookout mcp` holds it |
| `answered`        | `true` for a `needs-you` Claude Code session whose permission request Agent Lookout has answered, from Allow, Deny or a [permission rule](GUIDE.md#permission-rules), or is answering by a rule, while its registry file still says it waits in that wait, as it can for a second or two after the answer, and for 10 seconds after the answer at most. A session on another machine has it when Agent Lookout there sent it, for an answer given there. The wait is over: the dashboard's notifications and Agent Lookout's own, email, the webhook, ntfy and Pushover send nothing more for it, no reminder comes, `/api/waits` does not count it as waiting, `/api/history` counts it as working, not as needing you, and the dashboard, the Mac app's Dock badge and menu bar, `agent-lookout status` and the MCP tools count it as working too. Left out otherwise                                                                                                                                                                                                                                             |
| `stale`           | `true` once it has been idle for 24 hours, or for as long as the idle rule in `timeRules` says while it is on. For a session on another machine too, by this computer's rule, whatever that machine said                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

| Source field   | Holds                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `label`  | `claude-code` and `Claude Code`, `codex` and `Codex`, or `status-files` and `Status files`, or for another machine `remote:devbox` and `devbox`                                  |
| `state`        | `ok`, `searching`, `unavailable`, `not-set-up` or `error`                                                                                                                        |
| `detail`       | One plain sentence: how it is being read, or what went wrong                                                                                                                     |
| `advice`       | One plain sentence saying what you can do about a problem, when the collector knows                                                                                              |
| `watching`     | `[{ label, value }]`: what it reads and runs, and how often                                                                                                                      |
| `basis`        | Which way the sessions were read, for a source that has more than one                                                                                                            |
| `capabilities` | What its agent can report, and whether its sessions can be stopped and answered: for each of nine things, `{ level: "yes" }`, or `{ level: "no" }` or `"partly"` with a `reason` |
| `checkedAt`    | When it was last read                                                                                                                                                            |
| `machine`      | For another machine: its name, which its sessions carry as their `machine`                                                                                                       |
| `agents`       | For another machine: `[{ label, capabilities }]`, what each agent found there can report, as last read from it, with `jump`, `stop` and `answer` always `no`                     |

The [guide](GUIDE.md#what-each-agent-can-report) has the table `capabilities` holds.

Another machine that `AGENT_LOOKOUT_REMOTES` names is a source of its own, after this computer's three. Its `state` is `ok` while its sessions are read, `searching` while ssh signs in the first time, for 10 seconds at most, and `unavailable`, with the reason in `detail` and what to do in `advice`, for anything else: still connecting after those 10 seconds, ssh not found, the machine turned ssh away, the connection dropped, no Agent Lookout answering there, or an answer that cannot be read. A machine that is switched off is no fault of this computer, so it is not `error`. Its `watching` gives the ssh target, the command, the routes asked for, how often, the version there and the state of each source there, the first 20. When `AGENT_LOOKOUT_REMOTES` is set but cannot be read, one source stands for the machines instead: `remote:`, with no name after it, labelled `Other machines`, `not-set-up`, with what is wrong in `detail` and how to correct it in `advice`, and no sessions. Its sessions are listed with this computer's, in the same order, and counted in the same way. [Another machine over SSH](GUIDE.md#another-machine-over-ssh) has the rest.

With `AGENT_LOOKOUT_PULL_REQUESTS=on`, a session on a branch that has a pull request carries it in `git`:

```json
"git": {
  "branch": "checkout-flow",
  "repository": { "id": "ad1b8c7a6a7a8b36", "name": "storefront" },
  "pullRequest": {
    "number": 51,
    "title": "Show the pull request and its checks",
    "state": "open",
    "checks": { "state": "failing", "passing": 4, "failing": 2, "pending": 1 },
    "url": "https://github.com/example-org/storefront/pull/51"
  }
}
```

| Pull request field | Holds                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number`           | Its number on github.com                                                                                                                                                                                                                       |
| `title`            | Its title, as someone wrote it on GitHub, cleaned of control characters and of the characters that change the direction of text, and cut to 200 characters, as a session's name is. Plain text                                                 |
| `state`            | `open`, `draft`, `merged` or `closed`                                                                                                                                                                                                          |
| `checks`           | `{ state, passing, failing, pending }`, from each check on its latest commit, a check run again counted once. `state` is `failing` when any failed, `pending` when none failed and some have not finished, `passing`, or `none` with no checks |
| `checks.passing`   | Checks that passed, were skipped or ended neutral                                                                                                                                                                                              |
| `checks.failing`   | Checks that failed, timed out, were cancelled, went stale or need an action                                                                                                                                                                    |
| `checks.pending`   | Checks queued or still running, and commit statuses still pending                                                                                                                                                                              |
| `url`              | Its page, `https://github.com/<owner>/<repository>/pull/<number>`, which the collector builds from the remote and the number rather than take from GitHub                                                                                      |

It is what `gh` last said, asked at most once every 2 minutes for each repository and branch, so it can be up to about 2 minutes old. [Pull requests](GUIDE.md#pull-requests) in the guide says when it is asked for.
`answering` says whether permission prompts can be answered from the dashboard: `{ state, plugin, holdMs, problem }`. `state` is `on` while Agent Lookout listens for the plugin's requests, `off` with `AGENT_LOOKOUT_ANSWER=off`, and `unavailable` when it could not listen or does not, as on Windows, which has no Unix socket for the plugin's hook, with `problem` saying why in one sentence. `plugin` is `seen` once a request has arrived since the last permission prompt it missed, `missed` when a Claude Code session waited for permission and no request arrived, as for a session without the plugin, and `unknown` before either. `holdMs` is how long a request is held.

### `GET /api/events?since=<epoch ms>`

`{ "events": [...] }`: what changed, newest first, at most 200, and with `since` only those after it. Each event is `{ id, at, sessionId, sessionName, kind, from, to, severity }`, where `kind` is `appeared`, `status-changed`, `ended`, `stopped` or `answered`, `from` and `to` are statuses, and `severity` is `advisory`, `warning` for a change to `needs-you` or `critical` for a change to `failed`. A `stopped` event says that Agent Lookout stopped the session, when you pressed Stop or ended the sessions left running: it has `from`, the status the session had, no `to`, and `by: "agent-lookout"`. Its leaving the list is an `ended` event of its own. An `answered` event says that Agent Lookout answered a permission prompt of the session's, when you pressed Allow or Deny, or by a permission rule: it has `from`, `by: "agent-lookout"` and `decision`, `allow` or `deny`, and nothing of what was asked. One a rule gave also has `tool`, the tool's name as Claude Code gave it, and `rule`, `{ tool, command }`, the rule as you wrote it, with `command` only for a Bash rule that names one; its decision is the event's. Neither holds the command the session asked to run. A reader should pass over a `kind` it does not know: later versions may add others. The collector keeps the last 1,000 in memory, and with history kept on disk it reads them back when it starts again.

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

### `GET /api/waits`

How long sessions waited on you today, from local midnight, and over the last seven days, which are today and the six days before it, from midnight. It is worked out from the whole of the history kept, eight days of it, and not only the six hours `/api/history` serves, and counts only the time Agent Lookout measured: while it was running and every source it reads answered. Days are this computer's own, by its clock and time zone.

```json
{
  "at": 1791298800000,
  "today": {
    "from": 1791244800000,
    "to": 1791298800000,
    "waitedMs": 2100000,
    "openMs": 298000,
    "waits": 3,
    "measuredMs": 8998000,
    "days": [
      {
        "day": "2026-10-06",
        "from": 1791244800000,
        "to": 1791298800000,
        "waitedMs": 2100000,
        "openMs": 298000,
        "waits": 3,
        "measuredMs": 8998000
      }
    ],
    "sessions": [
      {
        "sessionId": "claude-code:00000000-0000-4000-8000-000000000001",
        "name": "demo-project",
        "waitedMs": 1200000,
        "waits": 1,
        "open": false
      }
    ],
    "sessionCount": 3
  },
  "sevenDays": { "from": 1790726400000, "to": 1791298800000, "days": [], "sessions": [] },
  "since": { "at": 1791018000000, "by": "started" },
  "where": "disk"
}
```

`today` and `sevenDays` have the same fields. `sevenDays` above is cut short: it has its own totals, seven `days`, oldest first, and its own `sessions`.

| Field          | Holds                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`           | When it was worked out, by the server's clock. Both periods end here                                                                                        |
| `waitedMs`     | How long sessions waited on you. Each session's waits are added up, so two waiting at once for a minute are two minutes. Only time that was measured counts |
| `openMs`       | The part of `waitedMs` that is a wait still open: a session that needs you now                                                                              |
| `waits`        | How many waits had time in the period. A wait that runs on across midnight, or across time that was not measured, is one wait                               |
| `measuredMs`   | How much of the period Agent Lookout measured. The rest it was not running, the computer was asleep, a source did not answer, or it came before `since`     |
| `days`         | Each local day in the period, oldest first, with the same four figures: `day` as `2026-10-06`, `from` its midnight and `to` the next, or `at` for today     |
| `sessions`     | The ten sessions that waited longest, longest first: `sessionId`, `name` as it was last seen, `waitedMs`, `waits`, and `open`, true while it needs you      |
| `sessionCount` | How many sessions waited in the period in all                                                                                                               |
| `since`        | Where the history held begins, as in `/api/history`. Nothing before it is counted                                                                           |
| `where`        | `disk`, or `memory` with `AGENT_LOOKOUT_HISTORY=off`, when the history begins as this run of Agent Lookout started, so only the time since then counts      |

A wait begins with a move into `needs-you` and ends with the session's next move out of it, or its end. A wait already under way when Agent Lookout found the session, as when it started while the session waited, is counted from when that run of Agent Lookout started. A wait the history holds no end for, of a session that does not need you now, ended while Agent Lookout was stopped, so it is counted up to the start of this run and no further. Only Claude Code sessions and sessions from a status file can be seen waiting: a Codex session never needs you, so it is never in this answer.

### `GET /api/email` and `GET /api/webhook`

Whether [email](GUIDE.md#email) or a [webhook](GUIDE.md#webhook) is set up, and how the last one went. They only read: both are set up in the environment Agent Lookout starts with.

| Field          | Holds                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on`           | Whether it sends                                                                                                                                                                                                                                     |
| `to`           | Email only: the address, with all but its first letter before the `@` hidden                                                                                                                                                                         |
| `host`         | Webhook only: the host the posts go to, and never the rest of the address                                                                                                                                                                            |
| `events`       | What is sent: `needs-you`, `finished`, `failed` and `ended`, any of them                                                                                                                                                                             |
| `afterMs`      | How long a wait lasts before it is sent                                                                                                                                                                                                              |
| `asking`       | Whether the email or post for a wait says what the session is asking: `true` with `AGENT_LOOKOUT_EMAIL_ASKING=on` or `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, `false` when that setting is `off` or left out, and `null` while email or the webhook is off |
| `problem`      | While off because a setting is wrong, one sentence naming the setting, never its value                                                                                                                                                               |
| `last`         | `{ at, sent: true }` or `{ at, sent: false, reason }` for the last one tried, or `null`                                                                                                                                                              |
| `limitedUntil` | While the limit of 20 an hour holds them back, when the next may go                                                                                                                                                                                  |

Neither ever holds the mail server's address, its user name or its password, the webhook's path, or anything a session was asking.

### `GET /api/ntfy` and `GET /api/pushover`

Whether pushes to a phone go through [ntfy](GUIDE.md#ntfy) or [Pushover](GUIDE.md#pushover), and how the last one went. They only read: both are set up in the environment Agent Lookout starts with.

```json
{
  "on": true,
  "host": "ntfy.sh",
  "tokenSet": false,
  "events": ["needs-you"],
  "afterMs": 60000,
  "asking": false,
  "problem": null,
  "last": { "at": 1791205920000, "sent": true },
  "limitedUntil": null
}
```

Each has the fields of `GET /api/webhook`, ntfy's with one more, `tokenSet`, and Pushover's without `host`. These differ:

| Field      | Holds                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`     | ntfy only: the host of the server the topic is on, such as `ntfy.sh`, and never the topic                                                     |
| `tokenSet` | ntfy only: whether `AGENT_LOOKOUT_NTFY_TOKEN` is set, `true` or `false`, and `null` while ntfy is off. Never the token                        |
| `asking`   | `true` with `AGENT_LOOKOUT_NTFY_ASKING=on` or `AGENT_LOOKOUT_PUSHOVER_ASKING=on`, `false` when that setting is `off` or left out              |
| `last`     | The last push of a notice that was tried. A test push from `POST /api/phone/test` is not counted here, though it counts toward the 20 an hour |

Neither ever holds the ntfy topic or its token, Pushover's application token or the user key, or anything a session was asking.

### `GET /api/pull-requests`

Whether Agent Lookout shows each session's [pull request](GUIDE.md#pull-requests), with `AGENT_LOOKOUT_PULL_REQUESTS=on`, and whether the GitHub CLI, `gh`, can be asked for them. It only reads.

```json
{ "on": true, "problem": null, "gh": "ready", "last": { "at": 1791205920000, "ok": true } }
```

| Field     | Holds                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on`      | Whether pull requests are asked for                                                                                                                                                                                           |
| `problem` | While off because the setting is neither `on` nor `off`, one sentence naming it                                                                                                                                               |
| `gh`      | While on, what `gh` was last found to be: `unknown` before it was needed, `ready`, `not-found` when there is no `gh` on `PATH` or in the usual places, or `signed-out` when it is not signed in. `null` while off             |
| `last`    | `{ at, ok: true }` or `{ at, ok: false, reason }` for the last question `gh` was asked, or `null`. A `reason` is one of Agent Lookout's own sentences, such as `gh did not answer within 15 seconds`, never what `gh` printed |

It never holds a token: `gh` signs in with its own login, which Agent Lookout never reads.

### `GET /api/settings`

The settings Agent Lookout keeps itself, in a file on this computer, so they hold with no dashboard open: the [time rules](GUIDE.md#time-rules) and the [permission rules](GUIDE.md#permission-rules), with what the permission rules answered since Agent Lookout started. It only reads.

```json
{
  "timeRules": {
    "longWait": { "on": true, "minutes": 10, "repeat": { "on": true, "minutes": 30 } },
    "idle": { "on": true, "hours": 48 },
    "quietHours": {
      "on": true,
      "from": "22:00",
      "to": "08:00",
      "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      "leaveOutAnswered": false
    }
  },
  "file": "~/.agent-lookout/settings.json",
  "problem": null,
  "permissionRules": [
    { "id": "3f9c2a71b0de", "decision": "deny", "tool": "Bash", "command": "git push --force:*" },
    { "id": "8a41d07e6c2b", "decision": "allow", "tool": "Bash", "command": "npm test:*" },
    { "id": "c5e0b9124fa3", "decision": "allow", "tool": "WebFetch" }
  ],
  "permissionRulesProblem": null,
  "ruleAnswers": [
    {
      "at": 1791331869617,
      "sessionId": "claude-code:00000000-0000-4000-8000-000000000001",
      "sessionName": "checkout-flow",
      "tool": "Bash",
      "decision": "allow",
      "rule": { "decision": "allow", "tool": "Bash", "command": "npm test:*" }
    }
  ],
  "ruleAnswersSince": 1791328269617
}
```

| Field                         | Holds                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeRules.longWait`          | The long wait reminder: `on`, and `minutes`, a whole number from 1 to 1,440, how long a wait lasts before it is reminded of. 10 unless set                                                                                                                                                                                        |
| `longWait.repeat`             | Whether the reminder goes again while the wait goes on: `on`, and `minutes`, a whole number from 5 to 1,440, how long from one reminder to the next. Left out until it is first set, which is the same as off, so a file from before it reads as it did. The Time rules card sets 30 when it is first turned on                   |
| `timeRules.idle`              | The idle rule: `on`, and `hours`, a whole number from 1 to 720, how long a session is idle before it is stale. 48 unless set. While it is off a session is stale after 24 hours                                                                                                                                                   |
| `timeRules.quietHours`        | Quiet hours: `on`, `from` and `to` on the 24-hour clock as `HH:MM`, two different times, which run past midnight when `to` is the earlier, and `days`, the days they begin on, any of `mon` to `sun`. 22:00 to 08:00 every day unless set                                                                                         |
| `quietHours.leaveOutAnswered` | Whether the summary sent when quiet hours end leaves out the waits that were answered while they held                                                                                                                                                                                                                             |
| `file`                        | The file they are kept in, `~/.agent-lookout/settings.json` or the one `AGENT_LOOKOUT_SETTINGS_FILE` names, with your home folder written `~`                                                                                                                                                                                     |
| `problem`                     | While the file could not be read when Agent Lookout started, or the last change could not be saved: one sentence that says why and names the file. `null` otherwise                                                                                                                                                               |
| `permissionRules`             | The permission rules in force, in their order, each `{ id, decision, tool, command }`: `decision` `allow`, `ask` or `deny`, `tool` a tool's name as Claude Code writes it or `*` for every tool, and `command` only for a Bash rule that names one, exactly, `npm test`, or as a prefix, `npm test:*`. 100 at most. Empty is none |
| `permissionRulesProblem`      | While the permission rules in the file could not be read whole, which leaves none in force, or the last change to them could not be saved: one sentence that says so. `null` otherwise                                                                                                                                            |
| `ruleAnswers`                 | The requests the permission rules answered since Agent Lookout started, newest first, 100 at most, each `{ at, sessionId, sessionName, tool, decision, rule }`, with `rule` as it read then. Never the command the session asked to run                                                                                           |
| `ruleAnswersSince`            | When Agent Lookout started, which is where `ruleAnswers` begins                                                                                                                                                                                                                                                                   |

Every time rule is off until you turn it on, and there is no permission rule until you add one. A time rule the file holds in a form that cannot be read is off, and `problem` names it. Permission rules are read whole or not at all: a list that cannot be read whole is none in force, so an allow rule never answers what an ask rule beside it, unread, would have held back.

### `POST /api/settings/time-rules`

A route that acts. It puts the time rules in force and saves them in the settings file, as the Time rules card in Settings does. It makes the same checks as `POST /api/jump`, with its own action, in `src/collector/settings/timeRulesRoute.ts`, and answers only a request that:

- is a `POST`. Any other method gets 405, with `Allow: POST`.
- has an `Origin` that names this computer, or gets 403.
- is marked `same-origin` in `Sec-Fetch-Site`, when that header is sent, or gets 403.
- carries `X-Agent-Lookout-Action: time-rules`, or gets 403.
- has `Content-Type: application/json`, or gets 415.
- has a body of 2,048 bytes or less, or gets 413, that is exactly the three rules, `longWait`, `idle` and `quietHours`, each whole, with exactly the fields `GET /api/settings` gives and every value in range, or gets 400. `longWait.repeat` may be left out, which is no repeat, and when it is there it is `{ "on", "minutes" }` whole.

The rules are in force once they are saved, and not before: the file is written whole, with mode 600, in a folder made with mode 700, and never through a link. Nothing in the request names a file.

| Status | Body                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 200    | `{ "ok": true, "timeRules": { ... } }`: the rules now in force                                          |
| 400    | `reason: "invalid"`, with an `error` sentence that says what the body must be                           |
| 500    | `reason: "not-saved"`: the file could not be read or written, as when it is a link, and nothing changed |

### `POST /api/settings/permission-rules`

A route that acts. It makes one change to the permission rules and saves the list in the settings file, as the Permission rules card in Settings does. It makes the same checks as `POST /api/jump`, with `X-Agent-Lookout-Action: permission-rules`, in `src/collector/settings/permissionRulesRoute.ts`, and takes a body of 1,024 bytes or less that is exactly one of:

```text
{ "add": { "decision": "allow", "tool": "Bash", "command": "npm test:*" } }
{ "edit": { "id": "8a41d07e6c2b", "decision": "ask", "tool": "Bash", "command": "npm test:*" } }
{ "move": { "id": "8a41d07e6c2b", "to": "up" } }
{ "remove": { "id": "8a41d07e6c2b" } }
```

A new rule goes to the end of the list, with an ID the server makes. A move at either end of the list changes nothing. The change is made to the list the settings file holds, read again just before, so one saved by another copy of Agent Lookout is kept. The server checks the rule itself, whatever the page checked, by `ruleProblem` in `src/core/permission-rules/permissionRules.ts`: a tool's name of letters, digits, `_` and `-` starting with a letter, or `*`; a command for Bash alone, in plain ASCII with one space between words, with no `;`, `&`, `|`, `<`, `>`, parentheses, quotes, backslashes, `$`, braces, and no `*` but a final `:*`; a command that begins with the program's name, not a variable set before it; and an allow rule that names one tool, never an MCP server alone such as `mcp__docs`, for Bash a command, and never `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `ExitPlanMode` or `AskUserQuestion`, whose command is one plain command that does not begin with a program that runs another, such as `sudo`, `env`, `xargs` or a shell (`COMMAND_RUNNERS` in `src/core/permission-rules/commandWords.ts`), or with one that sends requests or runs the code it is given, such as `curl`, `wget`, `nc`, `ssh`, `node`, `python` or `awk` (`NETWORK_CLIENTS_AND_INTERPRETERS` in the same file). The rules are in force once they are saved, and not before. Nothing in the request names a file.

| Status | Body                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------- |
| 200    | `{ "ok": true, "permissionRules": [ ... ] }`: the rules now in force                                      |
| 400    | `reason: "invalid"`, with an `error` sentence that says what the body or the rule must be                 |
| 404    | `reason: "no-rule"`: no rule has that ID, as when another tab or another copy of Agent Lookout removed it |
| 409    | `reason: "full"`, the list holds 100 rules, or `reason: "duplicate"`, it holds that rule already          |
| 500    | `reason: "not-saved"`: the file could not be read or written, and nothing changed                         |

A held permission request is put to the rules as its session's registry file confirms its wait, and a deny or an allow rule answers it through the same path as `POST /api/permission/answer`, below, with every check it makes. [Permission rules](GUIDE.md#permission-rules) says what each rule matches.

### `POST /api/phone/test`

A route that acts. It sends one test push through ntfy or Pushover, as Send a test on the card in Settings does. The push is titled "Agent Lookout test", says "Pushes from Agent Lookout reach this device.", and holds nothing of any session. It goes during quiet hours too, since the person asked, and counts toward the channel's 20 an hour. It makes the same checks as `POST /api/jump`, with its own action, in `src/collector/outbound/testSendRoute.ts`, and answers only a request that:

- is a `POST`. Any other method gets 405, with `Allow: POST`.
- has an `Origin` that names this computer, or gets 403.
- is marked `same-origin` in `Sec-Fetch-Site`, when that header is sent, or gets 403.
- carries `X-Agent-Lookout-Action: phone-test`, or gets 403.
- has `Content-Type: application/json`, or gets 415.
- has a body of 64 bytes or less, or gets 413, that is exactly `{ "channel": "ntfy" }` or `{ "channel": "pushover" }`, or gets 400.

Nothing in the request reaches the push or says where it goes: that is the channel's own setting. It sends one test a second, and one at a time.

| Status | Body                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | `{ "ok": true, "channel": "ntfy", "sentAt": 1791205920000 }`: the service took it                                                         |
| 409    | `reason: "off"`: the channel is not set up                                                                                                |
| 429    | `reason: "too-soon"`, with `Retry-After: 1`                                                                                               |
| 429    | `reason: "limited"`, with `limitedUntil` and `Retry-After` in seconds: 20 pushes were tried through that channel in the last hour         |
| 502    | `reason: "not-sent"`: it was tried, and the service did not take it. The `error` says why, such as `Pushover had a problem (status 503).` |

Each of these has an `error` sentence beside its `reason`, and none holds the topic, a token or a key.

### `POST /api/jump`

One of the eight routes that act. It selects the tmux pane a session runs in, or brings its tab of Terminal or iTerm2 to the front, as the Jump button does. Its checks, on top of the ones every request passes, are `jumpRefusalFor` in `src/collector/jumpRoute.ts`, which makes those `actionRefusalFor` in `src/collector/handler.ts` makes for every route that acts. It answers only a request that:

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

A route that acts. It deletes the files the history is kept in, except any that a later version of Agent Lookout wrote, and empties the Events log and the history in memory, as Clear history in Settings does. The history then begins again from that moment, with `since` set to `{ at, by: "cleared" }`. It makes the same checks as `POST /api/jump`, with its own action, in `src/collector/history/clearRoute.ts`, and answers only a request that:

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

### `POST /api/sessions/stop`

A route that acts. It ends one Claude Code session's process, as Stop session does in the session's details. It makes the same checks as `POST /api/jump`, with its own action, in `src/collector/actions/stopRoute.ts`, and answers only a request that:

- is a `POST`. Any other method gets 405, with `Allow: POST`.
- has an `Origin` that names this computer, or gets 403.
- is marked `same-origin` in `Sec-Fetch-Site`, when that header is sent, or gets 403.
- carries `X-Agent-Lookout-Action: stop`, or gets 403.
- has `Content-Type: application/json`, or gets 415.
- has a body of 1,024 bytes or less, or gets 413, that is exactly `{ "sessionId": "..." }`, or gets 400.

The server looks the session up in its own latest snapshot, and stops only one with a `stop` field, by what it found for it itself: its process, or its background job. Before it acts it reads the session's registry file again, which must still name that session, that process, the same kind, `interactive` or `bg`, and the same start time, and asks `ps` for the process's start time again, which must be the same, to the second. It never stops process 1, its own process, the one it was started from or any process above that. Then it sends SIGTERM, or runs `claude stop` with the job's ID, and waits up to 10 seconds for the process to end. Nothing in the request reaches a signal or a command. A stop adds a `stopped` event, and the server reads the sessions again before it answers. It makes one stop a second, and one at a time, with the clean-up's.

| Status | Body                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | `{ "ok": true }`: the process has ended, or the background job was stopped                                                              |
| 202    | `{ "ok": false, "reason": "still-running" }`: SIGTERM was sent, and the process is still running 10 seconds later. Nothing more is sent |
| 404    | `reason: "gone"`: the session is not listed, or its process has already ended                                                           |
| 409    | `reason: "unsupported"`: Agent Lookout does not stop this session, such as one in the desktop app or one whose kind is not known        |
| 409    | `reason: "cannot-confirm"`: its registry file changed, or `ps` did not give the same start time                                         |
| 403    | `reason: "not-allowed"`: the process is another user's, or one Agent Lookout never stops                                                |
| 429    | `reason: "too-soon"`, with `Retry-After: 1`                                                                                             |
| 500    | `reason: "failed"`: the signal could not be sent, or `claude stop` failed                                                               |

Each of these has an `error` sentence beside its `reason`. With `AGENT_LOOKOUT_STOP=off`, or on Windows, there is no such route, and a POST to it gets 405. Windows has no `ps` to confirm a process's start time and no POSIX signal to send, so no session there has a `stop` field.

### `POST /api/sessions/clean-up`

A route that acts. It ends the sessions left running that you chose, as End does under Left running in the Sessions card. It makes the same checks as `POST /api/sessions/stop`, with `X-Agent-Lookout-Action: clean-up`, and takes a body of 8 KiB or less that is exactly:

```json
{
  "sessions": [
    {
      "sessionId": "claude-code:00000000-0000-4000-8000-000000000004",
      "statusSince": 1791118800000
    }
  ]
}
```

with 1 to 20 sessions, none named twice, each with the `statusSince` the page showed for it. Anything else gets 400. For each session in turn the server makes every check of `POST /api/sessions/stop`, and then reads in the session's registry file, and in its own latest list of sessions, that it is still idle, since that same `statusSince`, and that this was 24 hours or more ago, or as long ago as the idle rule says while it is on. A session that has done anything since is left running. Then it stops each one that passed, as the stop route does, and waits up to 10 seconds for them all.

```json
{
  "results": [
    { "sessionId": "claude-code:00000000-0000-4000-8000-000000000004", "outcome": "ended" },
    { "sessionId": "claude-code:00000000-0000-4000-8000-000000000005", "outcome": "became-active" }
  ]
}
```

The answer is 200 with an `outcome` for each session asked for, in order: `ended`, `became-active`, `not-stale`, `gone`, `unsupported`, `cannot-confirm`, `not-allowed`, `still-running` or `failed`, which mean what the stop route's reasons do. One `stopped` event is added for each session ended. A clean-up while a stop or another clean-up is under way, or less than a second after one began, gets 429 with `reason: "too-soon"`. With `AGENT_LOOKOUT_STOP=off`, or on Windows, there is no such route either, and a POST to it gets 405.

### `POST /api/permission/answer`

A route that acts. It answers one permission prompt of a Claude Code session, as Allow and Deny do in Needs you and in the session's details. It makes the same checks as `POST /api/jump`, with `X-Agent-Lookout-Action: answer`, in `src/collector/answers/answerRoute.ts`, and takes a body of 1,024 bytes or less that is exactly:

```json
{
  "sessionId": "claude-code:00000000-0000-4000-8000-000000000001",
  "requestId": "0123456789abcdef0123456789abcdef",
  "decision": "allow"
}
```

with `decision` `allow` or `deny`, and `requestId` the one the session's `ask` gave. Anything else gets 400. The server answers only a request it holds for that session under that ID, `allow` only when `ask.allow` is `true`, and only after it has read the session's registry file again and found it still says the session is waiting. It then hands the plugin's hook one of two fixed answers, allow, or deny with a sentence that says the person denied it from Agent Lookout, and never a rewritten input or a permission rule. An answer adds an `answered` event, and the server reads the sessions again before it replies, so a `GET /api/sessions` sent once the reply has come finds the session gone on, or `answered`.

| Status | Body                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------- |
| 200    | `{ "ok": true, "decision": "allow" }`: the answer was handed to the session                              |
| 404    | `reason: "no-ask"`: no such request is held, or the session is not listed                                |
| 409    | `reason: "not-allowable"`: `allow` for a request that offers only Deny                                   |
| 409    | `reason: "gone"`: the session was answered there, is no longer waiting, or the request was held too long |
| 429    | `reason: "too-soon"`: that request is being answered                                                     |

Each of these has an `error` sentence beside its `reason`. With `AGENT_LOOKOUT_ANSWER=off`, on Windows, or with an `AGENT_LOOKOUT_ANSWER_WAIT` it cannot read, `AGENT_LOOKOUT_CLAUDE_HOME` set without `AGENT_LOOKOUT_ANSWER_SOCKET`, or a socket path too long for a socket, there is no such route, and a POST to it gets 405. When the socket could not be opened as Agent Lookout started, as in a folder other users can open that it did not make, with something other than a socket at its path, or while another copy of Agent Lookout listens on it, nothing is held, and a POST that passes the checks above gets the same 405.

The plugin's hook reaches Agent Lookout another way, not through this API: a Unix socket, `~/.agent-lookout/answer.sock` unless `AGENT_LOOKOUT_ANSWER_SOCKET` names another, of mode 600 in a folder of mode 700. It takes `POST /hooks/permission-request` with `X-Agent-Lookout-Hook: permission-request` and the hook's input as a JSON body of 1 MiB or less, holds it, and answers it with the decision JSON when you press Allow or Deny or a permission rule decides it, or with an empty 200 when the request is let go. [Answer a permission prompt](GUIDE.md#answer-a-permission-prompt) says when that is.

## In the Mac app only

The Mac app serves the dashboard and this API from its own address, `agent-lookout://app/`, with no port, and answers six more routes there, for its updates and its menu bar item. `npm start`, `npx agent-lookout` and `npm run dev` do not have them: there, each answers 404.

| Route                            | Body                               | Does                                                                                                                              |
| -------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/app/update`            |                                    | Where updates stand: the version, the switch, the last check, what was found and how far a download has got                       |
| `POST /api/app/update/check`     | `{}`                               | Checks GitHub now, and answers once it has                                                                                        |
| `POST /api/app/update/install`   | `{}`                               | Installs the version that is ready, then quits and opens it. 409 when none is ready, or it cannot be installed where the app runs |
| `POST /api/app/update/setting`   | `{ "automatic": true }` or `false` | Turns the daily check on or off                                                                                                   |
| `GET /api/app/menu-bar`          |                                    | Whether the menu bar item is shown: `{ "show": true }` or `false`                                                                 |
| `POST /api/app/menu-bar/setting` | `{ "show": true }` or `false`      | Shows the menu bar item or takes it away                                                                                          |

Each POST passes the checks `POST /api/jump` does, with its own `X-Agent-Lookout-Action` and a body that is exactly what the table says. For updates, the action is `check-for-updates`, `install-update` or `update-setting`, the body is 256 bytes or less, and each answers with the status `GET /api/app/update` gives, `AppUpdateStatus` in `src/core/appUpdate.ts`. For the menu bar item, the action is `menu-bar-setting`, the body is 64 bytes or less, and it answers with what `GET /api/app/menu-bar` gives, `MenuBarStatus` in `src/core/appMenuBar.ts`. That says `false` while the item could not be put in the menu bar, even with the switch on. Nothing in a request reaches a command or a path.

## The notifications header

A dashboard page sends `X-Agent-Lookout-Notifications` on every request, to say which events its notifications are on for: `off`, `on` for a session starting to wait, or `on; events=` followed by names, such as `on; events=needs-you,finished`. Any other value, or the header sent twice, says nothing. It changes no answer. The server reads it only from a `GET` that passed the checks above, and keeps the last thing a page said, to decide whether it shows notifications itself while no page is open. [ARCHITECTURE.md](ARCHITECTURE.md#notifications-from-the-collector) has the rules.

A program that only reads should not send it. `agent-lookout status` and `agent-lookout mcp` never do, so asking leaves what the server believes about the dashboard's pages as it was.

## For this computer only

The API has no token or password. The `Host` and `Origin` rules keep websites, and other computers on the network, away from it: it listens on loopback, and a browser cannot be made to read it from another site. What they do not stop is another program on this computer, which can read it as `curl` does, and on a shared computer that includes other user accounts. Such a program can also send the headers a route that acts asks for, since no browser is involved, so another account can ask the server to stop your Claude Code sessions, which it could not do itself. [SECURITY.md](../SECURITY.md) lists that as a known limit. The Mac app opens no port, and `AGENT_LOOKOUT_STOP=off` takes stopping away.

A token would not keep out programs running as you, which could read it as easily as the API. It could keep out other accounts on a shared computer, stopping your sessions included, the known limit above, and is left for a later version. The MCP server changes none of this: it opens no port of its own, speaks to the app that started it over stdin and stdout, and reads the same loopback API the dashboard and `agent-lookout status` read without one. A token is also for an API that can be reached some other way, such as from another computer, and Agent Lookout has none.

Another computer reads it only through SSH: with `AGENT_LOOKOUT_REMOTES` set there, Agent Lookout on that computer runs `ssh` to this one and forwards a port of its own loopback to this one's `127.0.0.1:4777`. Its requests then arrive on this computer's loopback, from the ssh server, which only someone who can sign in to this computer can open. It asks for `GET /api/health` and `GET /api/sessions`, with no `Origin` and no notifications header, and nothing else. [Another machine over SSH](GUIDE.md#another-machine-over-ssh) describes it.

## The MCP server

`agent-lookout mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server for an agent that keeps track of your other agents. The agent's app starts it and speaks to it over stdin and stdout. For each tool call it reads `GET /api/sessions` once, exactly as `agent-lookout status` does: from a loopback address only, with no `Origin` and no notifications header. It has three tools, and none of them acts:

| Tool                   | Answers                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_sessions`        | Every session, or those with the `status` given, with its id, name, agent, status, reason, folder, branch, pull request, app, since and how long it has been quiet |
| `sessions_needing_you` | The waiting sessions, longest wait first, with how long each has waited, and a sentence that sums them up                                                          |
| `sources`              | Each source's state in words, and its row of what its agent can and cannot report                                                                                  |

A session's `pullRequest` is `{ number, checks }`, its number and the state of its checks, `failing`, `pending`, `passing` or `none`, only with `AGENT_LOOKOUT_PULL_REQUESTS=on` and for a branch that has one, and `null` otherwise. It never holds the title or the address. `agent-lookout status --json` gives a waiting session the same `pullRequest`, and leaves it out when there is none.

The [guide](GUIDE.md#for-your-agents) says how to add it to an agent's app and what each answer holds.
