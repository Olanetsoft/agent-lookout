# Changelog

Changes that a user of Agent Lookout would notice, newest first.

## Unreleased

The first version. It shows Claude Code and Codex sessions and changes nothing on the machine.

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
- A rail down the left edge moves between the Overview, Sources and Settings, and its mark lights up while any session needs you.
- The browser tab's title shows how many sessions need you, so it can be read while the tab is in the background.
- Turn on notifications in Settings, and your browser shows a system notification when a Claude Code session starts waiting for you. It names the session and the reason, and is cleared when the session moves on.
- The Sources view says whether Claude Code and Codex were found, what Agent Lookout reads and runs for each, and how often.
- Night and Day themes: panels of tinted glass over a warm black at Night or a warm stone by Day, with amber kept for the sessions that need you. Settings can make the theme follow the computer's setting.
- `npm run build` followed by `npm start` serves the dashboard from one local process at `127.0.0.1:4777`.
