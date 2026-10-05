# Changelog

Changes that a user of Agent Lookout would notice, newest first.

## Unreleased

The first version. It shows Claude Code and Codex sessions, and those of any agent that writes a status file. The one thing it changes on the machine is which tmux pane is selected, when you press Jump.

### Added

- Claude Code sessions on this machine appear on one dashboard with no setup, whether they run in a terminal, in VS Code or in the desktop app.
- Codex sessions appear beside Claude Code's with no setup, including the Codex desktop app's, and each row names its agent once both are found.
- A Codex session shows as working, idle or finished, never as needing you, because Codex does not record in its files when it is waiting for approval.
- Each session shows its status: needs you, working or idle.
- A session that needs you says whether it is waiting for permission or asked you a question.
- A session that has been idle for 24 hours or more is marked stale.
- Background sessions that finished or failed stay on the dashboard for 24 hours, marked Finished or Failed.
- Sessions that need you sit in the Needs you panel at the top of the Overview, longest wait first, each with a timer of how long it has waited. When none does, the panel says so and shows the last wait that ended in the last hour.
- Bars in that panel show how long each session has waited on you, going back at most an hour, and a row under them counts the sessions that are working, idle and stale, and every session found.
- The Last hour chart shows how many sessions were waiting on you, working and idle, on average, in each five minutes of the last hour.
- The Needs you panel's heading and its Working and Idle counts open a chart of up to six hours.
- The Events log records when a session appears, changes status or ends, and when Agent Lookout started watching again after a break.
- The Timeline shows each session's status over the last hour, with the time Agent Lookout did not measure hatched.
- A Jump button opens a Claude Code session that runs in VS Code.
- A Claude Code session that runs inside tmux has a Jump button too. It selects the session's pane, the pane's window and, on any attached terminal that is showing another tmux session, the pane's session. The row says what happened: Selected in tmux, That pane has closed or tmux has stopped. It does not bring your terminal to the front.
- `AGENT_LOOKOUT_TMUX=off` stops Agent Lookout running tmux, and takes the Jump button off sessions in tmux.
- A rail down the left edge moves between the Overview, Sources and Settings, and its mark lights up while any session needs you.
- The browser tab's title shows how many sessions need you, so it can be read while the tab is in the background.
- Turn on notifications in Settings, and your browser shows a system notification when a Claude Code session starts waiting for you. It names the session and the reason, and is cleared when the session moves on.
- With notifications on, Agent Lookout goes on sending them on a Mac after the dashboard tab is closed, for as long as it keeps running. It shows those itself, so they come from Script Editor and stay until you clear them. An open tab that is polling and Agent Lookout do not both send one for the same wait.
- `AGENT_LOOKOUT_NOTIFICATIONS=on` turns Agent Lookout's own notifications on from the moment it starts, without the dashboard being opened.
- Any other agent, including one you wrote yourself, can show its sessions by writing one small JSON file for each into `~/.agent-lookout/sessions`, or the folder `AGENT_LOOKOUT_STATUS_DIR` names. A session appears within 2 seconds under the agent's own name, needs you and sends a notification when its file says `waiting`, and goes when its file is deleted or its process ends. The guide's Your own agents part has the format. Agent Lookout only reads the folder.
- Agent Lookout can email you when a session has waited for you for a minute, or as long as `AGENT_LOOKOUT_EMAIL_AFTER` says. It is off unless you start it with `AGENT_LOOKOUT_EMAIL_TO` and `AGENT_LOOKOUT_SMTP_URL`, and by default it sends nothing anywhere. Once set up, it sends one short plain-text email for each wait, through the mail server you name, to the one address you name, over TLS, at most 20 in an hour. The Email card in Settings says whether it is on and how the last email went.
- The Sources view says whether Claude Code and Codex were found, what Agent Lookout reads and runs for each, and how often. A card for status files says whether their folder is there, how often it is read, and how many files were read and skipped.
- Night and Day themes: panels of tinted glass over a warm black at Night or a warm stone by Day, with amber kept for the sessions that need you. Settings can make the theme follow the computer's setting.
- `npm run build` followed by `npm start` serves the dashboard from one local process at `127.0.0.1:4777`.
- `agent-lookout status` prints in the terminal which sessions need you: the counts, then each waiting session's name, the reason and how long it has waited. `--count` prints only the number, for a tmux status line or a shell prompt, and `--json` prints the same as JSON. The exit code is 0 when nothing needs you, 1 when a session does and 2 when it cannot tell, such as when Agent Lookout could not be reached or read. It reads the Agent Lookout already running on this machine, at a loopback address only, and starts nothing. Run it in the clone with `npm run --silent status`, or anywhere after `npm link`.
