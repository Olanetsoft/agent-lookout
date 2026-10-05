# Security

## Reporting a vulnerability

Report it privately through GitHub. On the repository's Security tab, choose "Report a vulnerability", or go straight to <https://github.com/Olanetsoft/agent-lookout/security/advisories/new>. Do not open a public issue for a security problem.

Say what you found, how to reproduce it and what someone could do with it. Leave real session names and folder paths out of the report.

If that page does not open, or shows no form, reach the maintainer, Idris Olubisi, through the links on the [Olanetsoft GitHub profile](https://github.com/Olanetsoft). In that first message, say only that you have a security report for Agent Lookout. The maintainer will agree a private way to send the details.

The project has one maintainer, so replies are best effort. There are no tagged releases yet, so fixes land on `main`.

## What the app handles

Agent Lookout reads metadata about the Claude Code and Codex sessions on your machine: names, working directories, statuses and, for Claude Code, process IDs. It serves that to the dashboard over HTTP on a loopback address. It reads no Claude Code transcripts. It does open Codex's session files, which hold whole conversations, and keeps only when turns started and ended and a few fields. It writes to no agent's files. [PRIVACY.md](PRIVACY.md) lists everything it reads, runs and keeps.

With notifications turned on in Settings, the dashboard page hands a waiting session's name and a fixed reason to the browser's Notifications API, which passes them to the operating system. When no dashboard page is open, the local server shows the notification itself on macOS: it runs `/usr/bin/osascript` with a fixed script, and passes the name and the reason to that script as arguments. Each dashboard page tells the server whether its notifications are on, in a header on its requests, and the server shows its own only while the last page to say so said they are on, or `AGENT_LOOKOUT_NOTIFICATIONS=on` was set and no page has said anything. Nothing is sent over the network for any of this. [PRIVACY.md](PRIVACY.md#notifications) has the details.

Session names and folder paths can be sensitive. The main risk is that something other than your own browser reads them.

## In scope

- A website, or another machine on the network, reading the local API. That includes getting past the `Host` and `Origin` checks and DNS rebinding.
- `npm start` listening on any address other than loopback.
- Any network request from Agent Lookout itself to anything but its own local server.
- Any write to `~/.claude` or to another tool's files, and any read of the `.key` files in `~/.claude/sessions/`.
- Any write under the Codex folder (`~/.codex`, or the folder `CODEX_HOME` or `AGENT_LOOKOUT_CODEX_HOME` names), any open of a file in its `thread-writer-locks/`, and any read of a Codex file that PRIVACY.md does not list.
- Text from a Codex session file, such as a prompt, a reply or a command's output, reaching the API or the dashboard.
- A session name, path or other session field that runs as script or markup in the dashboard.
- A way to make the app run anything other than the `claude` binary it found, `ps` and `/usr/bin/osascript`, or to pass any of them arguments they should not get.
- A session name, or anything else from a session, that `osascript` reads as AppleScript or as one of its options instead of showing it as text.
- A Jump link that opens anything other than the intended `vscode://` address.
- A notification, or the browser's question about allowing them, appearing when you have not turned notifications on, in Settings or with `AGENT_LOOKOUT_NOTIFICATIONS=on`.
- A notification that holds anything but the session's name and the reason, or that makes the browser fetch anything.
- A page at another address reading or steering the dashboard's notifications, or turning the server's own on or off.

## Out of scope

- Other programs on the same machine reading the local API, or sending it the header that turns the server's notifications on or off. The API has no authentication, so any local process can request it, and on a shared computer that includes other user accounts. This is a known limit of this version.
- A notification the server showed staying in Notification Centre after its session has moved on. The server cannot take one down, and PRIVACY.md says so.
- The dev server started with Vite's `--host` flag, which makes it listen on the network. `npm start` refuses to listen on anything but loopback.
- Attacks that need control of your user account first. Someone with that control can read `~/.claude` and `~/.codex` directly.
- Vulnerabilities in Claude Code, Codex or another agent tool. Report those to the vendor.
- Traffic from Claude Code's own `claude agents` command while Agent Lookout runs it. It may contact Anthropic the way Claude Code normally does.
- Another program later served at the same address using the notification permission your browser gave that address. PRIVACY.md describes this.
- Vulnerabilities in a dependency that cannot be shown to affect Agent Lookout. Report those upstream.
