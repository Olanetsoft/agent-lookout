# Changelog

Changes that a user of Agent Lookout would notice, newest first.

## Unreleased

### Added

- The email and the webhook post for a wait can say what the session is asking, as the dashboard does, such as `Run: npm test`. Each has its own setting, off unless you set it: `AGENT_LOOKOUT_EMAIL_ASKING=on` puts it in the email, as an `Asking:` line in the body and never in the subject, and `AGENT_LOOKOUT_WEBHOOK_ASKING=on` puts it in the post, after the reason in the line Slack shows and in a field of its own, `asking`. That line can hold a command, a web address or a file's full path, so with either on it leaves this computer. It is taken at the moment the email or post is sent, is never kept, and is never sent for a session that finished, failed or ended, and `agent-lookout mcp` still never carries it. The Email and Webhook cards in Settings say whether each one includes it.
- The Mac app shows in the menu bar how many sessions need you, beside its icon, with the window open or closed, and the icon alone when none do. Click it to list those sessions, the longest wait first, each with how long it has waited, its reason and what it is asking, cut to one line. Two sessions with the same name show their agent, project, branch or app in brackets. Choose one to open its details in the window, which opens if it was closed. The menu also has Open Agent Lookout, Check for Updates…, Settings… and Quit Agent Lookout. Show in menu bar, under Menu bar in Settings, takes the icon away. [Menu bar](docs/GUIDE.md#menu-bar) has the details.

### Changed

- Agent Lookout needs Node.js 22.12 or newer. Node.js 20 reached the end of its life on 30 April 2026 and no longer gets security fixes, so it is no longer supported. On an older Node, `npx agent-lookout` and `agent-lookout` stop at once with one line that names the version needed and the version found, and exit with 1, or with 2 for `agent-lookout status`. The Mac app needs no Node.js.

## 0.2.2 - 2026-10-06

History now survives a restart. The Mac app offers this version as its first update.

### Added

- The Events log and the charts are kept on this computer, in `~/.agent-lookout/history`, so they are still there after Agent Lookout restarts, with the time it was not running shown as not measured and a Watching resumed row for each restart. A session that changed status or ended while it was stopped is recorded at the first poll after it starts again. They are kept for 8 days and up to 20 MB, and hold no folder path, prompt or anything a waiting session is asking. The History card in Settings says where they are, how much they hold and since when, and Clear history deletes them, after asking. `AGENT_LOOKOUT_HISTORY_DIR` keeps them in another folder, and `AGENT_LOOKOUT_HISTORY=off` keeps them in memory only, as before.

## 0.2.1 - 2026-10-06

The first version with a Mac app to download: its [release on GitHub](https://github.com/Olanetsoft/agent-lookout/releases/tag/v0.2.1) has a disk image for Apple silicon and one for Intel.

### Added

- A Mac app for Apple silicon and for Intel, to download from the release or build from the repository with `npm run dist:mac`. It shows the dashboard in its own window, runs Agent Lookout inside itself with no port opened, keeps running in the Dock when the window is closed, shows on its Dock icon how many sessions need you, and shows notifications under its own name. It is not signed yet, so macOS asks once before it first opens: [Desktop app](docs/GUIDE.md#desktop-app) has the steps.
- The Mac app can update itself from the project's releases on GitHub. About once a day while it runs, it asks GitHub whether a newer version is out, sending nothing about your sessions, and a switch under Updates in Settings turns that off. Check for Updates…, in the Agent Lookout menu and in Settings, checks at once. A newer version is downloaded and checked against the size and SHA-512 its release gives, and installed only when you press Install and Restart, which quits the app and opens the new version. It updates itself from Applications or any folder it can change, and run from its disk image, another disk or a read-only copy it says how to move it instead. The npm package and the repository never check. [Updates](docs/GUIDE.md#updates) has the details.

## 0.2.0 - 2026-10-06

The first version on npm. It shows Claude Code and Codex sessions, and those of any agent that writes a status file. The one thing it changes on the machine is which tmux pane, or which tab of Terminal or iTerm2, is in front, when you press Jump.

### Added

#### Sessions

- Claude Code sessions on this machine appear on one dashboard with no setup, whether they run in a terminal, in VS Code or in the desktop app.
- Codex sessions appear beside Claude Code's with no setup, including the Codex desktop app's, and each row names its agent once both are found.
- A Codex session shows as working, idle or finished, never as needing you, because Codex does not record in its files when it is waiting for approval.
- Any other agent, including one you wrote yourself, can show its sessions by writing one small JSON file for each into `~/.agent-lookout/sessions`, or the folder `AGENT_LOOKOUT_STATUS_DIR` names. A session appears within 2 seconds under the agent's own name, needs you and sends a notification when its file says `waiting`, and goes when its file is deleted or its process ends. The guide's Your own agents part has the format. Agent Lookout only reads the folder.
- Each session shows its status: needs you, working or idle.
- A session that needs you says whether it is waiting for permission or asked you a question.
- A Claude Code session that needs you also says what it is asking, under its reason in the Needs you panel, in its details and in the notification of its wait: the command it wants to run, as in `Run: npm test`, the file it wants to edit, write or read, the page or search it wants, a plan to approve, the tool it wants to use, or the question it put to you, with how many more it has. It is read from the last message of the session's transcript only while the session waits, is cut to two lines, and is forgotten when the wait ends. Emails, webhook posts and `agent-lookout mcp` never carry it. `AGENT_LOOKOUT_WAITING_TEXT=off` stops any transcript being read.
- A session that has been idle for 24 hours or more is marked stale.
- Background sessions that finished or failed stay on the dashboard for 24 hours, marked Finished or Failed.
- A session whose folder is in a git repository shows the branch it has checked out, under the folder in the Sessions list and in the Needs you panel, as in `storefront on checkout-flow`, so sessions in worktrees of one repository can be told apart. With no branch checked out, it shows the first seven characters of the commit instead. It works the same for every agent, reads only the repository's `.git` file and `HEAD` for it, for each session's folder at most every 10 seconds, writes nothing and runs no git command.
- Sessions in worktrees of one repository can be seen together. Choose Repos in the switch at the top of the Sessions list, beside List and Board, and the list is grouped under one heading for each repository, as in `storefront 3`, with sessions in no repository last, under `No repository`, and the status order kept inside each group. The choice is kept in the browser. On the board, a worktree's card names its repository before its folder, as in `storefront · storefront-checkout on checkout-flow`, and a session's details name its repository. A worktree belongs to the repository it was made from, and a submodule is a repository of its own. Agent Lookout works this out from the `.git` file and `HEAD` it already reads and, for a worktree, the `commondir` file beside its `HEAD`, which names the repository's own git folder, so worktrees kept beside a bare repository, as in `storefront/.bare`, group together too. The page is sent the repository's name and a hash of its git folder's path, never the path.
- A working session whose agent has written nothing to its session file for 5 minutes or more says how long in the Sessions list, as in `quiet for 12m`, with the time of the last write when you hover over it or move to it with Tab. It is a measurement beside the status, which stays Working, and it never moves a session to the Needs you panel. A Codex session waiting for your approval shows as working, so a long quiet stretch is the sign to look. Codex sessions and status files give the time, from the file's modified time alone, and a Codex session's time also counts the files of the subagents it started. Claude Code sessions do not, because the file Agent Lookout reads for them is not rewritten as the session works.
- When a session's app is not known, nothing names it: the header, the Needs you panel, a board card, a search result, an email and a webhook post leave it out, and the Sessions list shows a dash. A status file can name its app with `app`: `terminal`, `vscode` or `desktop`.

#### The Overview

- Sessions that need you sit in the Needs you panel at the top of the Overview, longest wait first, each with a timer of how long it has waited. When none does, the panel says so and shows the last wait that ended in the last hour.
- Bars in that panel show how long each session has waited on you, going back at most an hour, and a row under them counts the sessions that are working, idle and stale, and every session found.
- The Last hour chart shows how many sessions were waiting on you, working and idle, on average, in each five minutes of the last hour.
- The Needs you panel's heading and its Working and Idle counts open a chart of up to six hours.
- The Sessions list can be shown as a board, with a column each for Needs you, Working, Idle, and Finished or failed, each with its count. Each card gives the session's name, agent, folder, branch, app and how long it has had its status, with Jump where the list has it. A card moves to its new column by itself within about 2 seconds of its status changing, and cannot be dragged. A switch at the top of the list chooses List or Board, and the choice is kept in the browser.
- The Events log records when a session appears, changes status or ends, and when Agent Lookout started watching again after a break.
- Come back to the dashboard's tab after it was in the background, or open the dashboard again, and a line in the Events log marks where you left off, such as New since 14:02:37, with the number of events since beside the log's title, such as 3 new. Both go once the line has been in view for 10 seconds, or when you open another view. With the tab in front all the time, nothing is marked. The only thing kept for it is the time you left off, in the browser.
- The Timeline shows each session's status over the last hour, with the time Agent Lookout did not measure hatched.
- Find a session from the keyboard. `/`, or `Cmd+K` on a Mac and `Ctrl+K` elsewhere, or the magnifier in the header opens a search over each session's name, folder, branch and agent, with every word typed found in any order. Sessions that need you are listed first, longest wait first, then the rest in the order of the Sessions list. Up and Down move through them, and Enter presses the session's Jump when it has one, or takes you to its row on the Overview. `?` lists every shortcut, including the arrow keys the charts, the Timeline and the switches already had.
- Open a session to see everything Agent Lookout knows about it. Click its row in the Sessions list or its card on the board, or move to its name with Tab and press Enter, and its details open over the Overview: its status with the reason and how long, its agent, app, full folder path, branch, start time and process ID, how many times and how long it waited for you, its own events and its row of the Timeline, with its Jump button where it has one. Each session's details have their own address, so a bookmark, a reload and the browser's Back button land on them, and closing them puts focus back on the row or card.
- A session that needs you opens its details from its name in the Needs you panel, and Enter in the search opens the details of a session with no Jump button.

#### Jump

- A Jump button opens a Claude Code session that runs in VS Code.
- A Claude Code session that runs inside tmux has a Jump button too. It selects the session's pane, the pane's window and, on any attached terminal that is showing another tmux session, the pane's session. The row says what happened: Selected in tmux, That pane has closed or tmux has stopped. It does not bring your terminal to the front. `AGENT_LOOKOUT_TMUX=off` stops Agent Lookout running tmux, and takes the button off sessions in tmux.
- On a Mac, a Claude Code session in a tab of Terminal or iTerm2, outside tmux, has a Jump button too. It brings that tab to the front, in its window, with the app. The first time, macOS asks once whether the program Agent Lookout runs in may control the app, and the row says so while it asks. If macOS did not allow it, the row says where to allow it: System Settings, Privacy & Security, Automation. Sessions in other terminals, such as Warp, Ghostty or the VS Code terminal, have no button. `AGENT_LOOKOUT_TERMINAL_JUMP=off` stops Agent Lookout looking for tabs of Terminal and iTerm2, and takes the button off sessions there.

#### Notifications

- Turn on notifications in Settings, and your browser shows a system notification when a session starts waiting for you. It names the session and the reason, and is cleared when the session moves on.
- With notifications on, Agent Lookout goes on sending them on a Mac after the dashboard tab is closed, for as long as it keeps running. It shows those itself, so they come from Script Editor and stay until you clear them. An open tab that is polling and Agent Lookout do not both send one for the same wait. `AGENT_LOOKOUT_NOTIFICATIONS=on` turns these on from the moment it starts, without the dashboard being opened.
- Choose what sends a notification. While notifications are on, Settings lists four events, each with its own switch: Needs you, Finished, Failed and Ended, which is a session leaving the list without having finished or failed. Needs you is on and the others are off until you change them. A notification names the session and what happened, and one that says Finished, Failed or Ended stays until you clear it. The choice is kept in the browser, and Agent Lookout's own notifications, with no tab open, follow it too. Nothing is sent for what was already true when the page opened or Agent Lookout started.

#### Email and webhooks

- Agent Lookout can email you when a session has waited for you for a minute, or as long as `AGENT_LOOKOUT_EMAIL_AFTER` says. It is off unless you start it with `AGENT_LOOKOUT_EMAIL_TO` and `AGENT_LOOKOUT_SMTP_URL`, and by default it sends nothing anywhere. Once set up, it sends one short plain-text email for each wait, through the mail server you name, to the one address you name, over TLS, at most 20 in an hour. The Email card in Settings says whether it is on and how the last email went.
- `AGENT_LOOKOUT_EMAIL_EVENTS` chooses what is emailed: any of `needs-you`, `finished`, `failed` and `ended`, separated by commas. It is `needs-you` unless you set it. A session that finishes, fails or ends is emailed at once, within the same 20 an hour, with a subject such as "billing-webhooks finished". The Email card names the events it sends.
- Agent Lookout can post to a webhook, such as a Slack channel's incoming webhook, when a session has waited for you for a minute, or as long as `AGENT_LOOKOUT_WEBHOOK_AFTER` says, and, with `AGENT_LOOKOUT_WEBHOOK_EVENTS`, when one finishes, fails or ends. It is off unless you start it with `AGENT_LOOKOUT_WEBHOOK_URL`, and by default it sends nothing anywhere. Once set, it sends one short JSON post for each, to that one address and no other, over HTTPS, at most 20 in an hour, counted apart from emails. Each post names the session, what happened and when, and its folder's name, app and agent, and nothing in a session's name can mention someone, ping a channel or make a link that shows other words than its address. A Slack incoming webhook takes the posts with nothing more to set up, and Discord takes them with `/slack` added to its address. The Webhook card in Settings says whether it is on, names the host alone and says how the last post went.

#### Sources, Settings and the page

- A rail down the left edge moves between the Overview, Sources and Settings, and its mark lights up while any session needs you.
- The browser tab's title shows how many sessions need you, so it can be read while the tab is in the background.
- The Sources view says whether Claude Code and Codex were found, what Agent Lookout reads and runs for each, and how often. A card for status files says whether their folder is there, how often it is read, and how many files were read and skipped.
- Under the source cards, What each agent can report says Yes, No or Partly for each agent and each thing it can show, such as needs you, finished, Jump and quiet for, with the reason for each No and Partly. The guide has the same table.
- Night and Day themes: panels of tinted glass over a warm black at Night or a warm stone by Day, with amber kept for the sessions that need you. Settings can make the theme follow the computer's setting.

#### Outside the dashboard

- `npm run build` followed by `npm start` serves the dashboard from one local process at `127.0.0.1:4777`.
- `agent-lookout`, or `agent-lookout start`, starts Agent Lookout as `npm start` does and prints its address. `--port` chooses the port, and `--open` opens the address in the default browser. The package for npm holds the built dashboard and the command as plain JavaScript, so `npx agent-lookout` runs it with nothing to clone and no TypeScript. It also holds `dist/THIRD-PARTY-LICENSES.md`, with the licences of the libraries and fonts the dashboard includes.
- `agent-lookout --version`, or `-v`, prints the version.
- `agent-lookout status` prints in the terminal which sessions need you: the counts, then each waiting session's name, the reason and how long it has waited. `--count` prints only the number, for a tmux status line or a shell prompt, and `--json` prints the same as JSON. The exit code is 0 when nothing needs you, 1 when a session does and 2 when it cannot tell, such as when Agent Lookout could not be reached or read. It reads the Agent Lookout already running on this machine, at a loopback address only, and starts nothing. Run it with `npx agent-lookout status`, as `agent-lookout status` after `npm install -g agent-lookout`, or in a clone with `npm run --silent status`.
- `agent-lookout mcp` lets an AI agent keep track of your other agents. It is a Model Context Protocol server that the agent's app starts and speaks to over stdin and stdout, so it listens on no port, and it reads the Agent Lookout already running on this machine, at a loopback address only, as `agent-lookout status` does. Its three tools only read: `list_sessions` gives every session with its status, the reason it waits, its folder's name, branch, app and how long it has been quiet, or only those with one status; `sessions_needing_you` gives the waits, longest first, with how long each has waited and one sentence that sums them up; and `sources` says whether each agent is being read and what it can and cannot report. Each tool says that session names are untrusted text written by other programs, and anything a terminal would act on, and any character that shows nothing, is taken out of them. When Agent Lookout is not running, each tool says so and how to start it. Add it to Claude Code with `claude mcp add agent-lookout -- npx -y agent-lookout mcp`, or in a clone with `<path to the clone>/bin/agent-lookout.mjs mcp` in place of `npx -y agent-lookout mcp`.
- docs/API.md describes the local API: every route and its answer, the `Host` and `Origin` rules, the notifications header and the checks on `POST /api/jump`. The API is for this machine only, and has no token.

#### On Linux

- Agent Lookout runs on Linux, started the same way and reading the same folders. It has been checked in CI on Ubuntu by starting it with `npm start` and reading back its sessions, and not yet by a person on a Linux desktop. The guide's On Linux part says what works there.
- When it is not on `PATH`, the `claude` command is also looked for in `~/.npm-global/bin` and `/usr/bin`, after the places it was looked for on a Mac.
- A Claude Code session whose start time `ps` now gives up to a minute away from the one in its registry file is still shown. Linux's `ps` gives another start time after the clock is set, as it often is after waking from sleep.
- Notifications with no dashboard tab open, and Jump to a tab of Terminal or iTerm2, are macOS only. Started with `AGENT_LOOKOUT_NOTIFICATIONS=on` anywhere else, Agent Lookout prints a line saying it shows no notifications itself.
