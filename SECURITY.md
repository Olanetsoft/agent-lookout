# Security

## Reporting a vulnerability

Report it privately through GitHub. On the repository's Security tab, choose "Report a vulnerability", or go straight to <https://github.com/Olanetsoft/agent-lookout/security/advisories/new>. Do not open a public issue for a security problem.

Say what you found, how to reproduce it and what someone could do with it. Leave real session names and folder paths out of the report.

If that page does not open, or shows no form, reach the maintainer, Idris Olubisi, through the links on the [Olanetsoft GitHub profile](https://github.com/Olanetsoft). In that first message, say only that you have a security report for Agent Lookout. The maintainer will agree a private way to send the details.

The project has one maintainer, so replies are best effort. There are no tagged releases yet, so fixes land on `main`.

## What the app handles

Agent Lookout reads metadata about the Claude Code and Codex sessions on your machine: names, working directories, statuses and, for Claude Code, process IDs. It serves that to the dashboard over HTTP on a loopback address. It reads no Claude Code transcripts. It does open Codex's session files, which hold whole conversations, and keeps only when turns started and ended and a few fields. It writes to no agent's files. It also reads the folder of status files, `~/.agent-lookout/sessions` or the one `AGENT_LOOKOUT_STATUS_DIR` names, where any program can write a small JSON file to show one of its sessions, and it writes nothing there. [PRIVACY.md](PRIVACY.md) lists everything it reads, runs and keeps.

With notifications turned on in Settings, the dashboard page hands a waiting session's name and a fixed reason to the browser's Notifications API, which passes them to the operating system. When no dashboard page is open, the local server shows the notification itself on macOS: it runs `/usr/bin/osascript` with a fixed script, and passes the name and the reason to that script as arguments. Each dashboard page tells the server whether its notifications are on, in a header on its requests, and the server shows its own only while the last page to say so said they are on, or `AGENT_LOOKOUT_NOTIFICATIONS=on` was set and no page has said anything. Nothing is sent over the network for any of this. [PRIVACY.md](PRIVACY.md#notifications) has the details.

Email notifications are off unless they are set up in the environment Agent Lookout starts with. Then, for a session that has waited the delay set, the collector sends one short plain-text email, through the mail server named in `AGENT_LOOKOUT_SMTP_URL`, to the one address in `AGENT_LOOKOUT_EMAIL_TO`. It holds the session's name, the reason, how long it has waited, the name of its project folder, its app and its agent. The password for the mail server is in `AGENT_LOOKOUT_SMTP_URL`, so it lives in the environment of the Agent Lookout process and nowhere else: it is never written to a file, sent to the dashboard or printed. The connection to the mail server is encrypted with TLS, with its certificate checked, except to a mail server on this machine. `GET /api/email` tells the dashboard only whether email is on, the address with most of it hidden, the delay and how the last email went. [PRIVACY.md](PRIVACY.md#email) has the details.

Webhook posts are off unless `AGENT_LOOKOUT_WEBHOOK_URL` is set in the environment Agent Lookout starts with. Then, for each event chosen, the collector sends one short JSON post to that one address, over HTTPS with the certificate checked, or over plain HTTP only to `127.0.0.1` or `localhost`. It holds the session's name, what happened, when, the name of its project folder, its app and its agent. It follows no redirect and tries nothing twice. The address is itself a secret: whoever has a Slack incoming webhook's address can post to its channel. So it lives in the environment of the Agent Lookout process and nowhere else: it is never written to a file, sent to the dashboard or printed. `GET /api/webhook` tells the dashboard only whether the webhook is on, the host, the events, the delay and how the last post went. [PRIVACY.md](PRIVACY.md#webhook) has the details.

One route of the local API changes something: `POST /api/jump`, which the Jump button of a session in tmux sends. Every other route only reads. It can change three things, all inside tmux: which pane is selected in its window, which window is selected in its tmux session, and which tmux session each attached terminal is showing. It sends no keys, runs nothing inside a pane and starts no tmux server.

A request to it names a session by its ID and nothing else. The server looks that session up in its own list and takes the pane it found for that session's process when it last asked tmux. It checks that the pane's ID is a `%` followed by digits, and gives it to a fixed list of tmux commands: `select-window`, `select-pane`, `display-message -p`, `list-clients` and `switch-client`. Nothing from the request is passed to tmux, and tmux is started directly, never through a shell. So the route can never be made to run another program, another tmux command or a command with other arguments. The most a request can do is choose which of the panes already found for a listed session is selected.

On top of the checks every route makes, the route answers only a request that:

- is a `POST`. Any other method gets 405. A preflight's `OPTIONS` is refused like any other request, and never with a CORS header: one from another site gets 403 from the checks every route makes, and one from another port of this machine, under the same name, gets 405.
- has an `Origin` header that names this machine. A request with no `Origin` is refused here, though a read may go without one.
- is marked `same-origin` in `Sec-Fetch-Site`, when the browser sends that header.
- carries `X-Agent-Lookout-Action: jump` and `Content-Type: application/json`. A page at another origin can send neither without a preflight, which is never granted.
- has a body of 1,024 bytes or less that is exactly `{"sessionId": "..."}`.

It makes one jump a second, and one at a time. `AGENT_LOOKOUT_TMUX=off` stops Agent Lookout running tmux, and the route then finds no pane for any session. [PRIVACY.md](PRIVACY.md#tmux) lists each command.

Session names and folder paths can be sensitive. The main risk is that something other than your own browser reads them.

## In scope

- A website, or another machine on the network, reading the local API. That includes getting past the `Host` and `Origin` checks and DNS rebinding.
- `npm start` listening on any address other than loopback.
- Any network request from Agent Lookout itself to anything but its own local server, apart from the mail server named in `AGENT_LOOKOUT_SMTP_URL` once email is set up and the address in `AGENT_LOOKOUT_WEBHOOK_URL` once a webhook is set up.
- An email sent, or a connection to a mail server opened, while `AGENT_LOOKOUT_EMAIL_TO` or `AGENT_LOOKOUT_SMTP_URL` is unset, or while one of the email settings cannot be read.
- The mail server's password, its user name or its address reaching the dashboard, the API, a log, the console or a file.
- An email that holds more than PRIVACY.md lists, or that goes to any address but the one in `AGENT_LOOKOUT_EMAIL_TO`.
- A session's name, folder or anything else from a session that adds or changes a header of an email, adds a recipient, or changes where an email goes.
- An email sent over a connection without TLS to a mail server that is not on this machine, or to a server whose certificate was not checked.
- A post sent, or a connection opened for one, while `AGENT_LOOKOUT_WEBHOOK_URL` is unset, or while one of the webhook settings cannot be read.
- Any part of the webhook's address beyond its host reaching the dashboard, the API, a log, the console or a file.
- A post that holds more than PRIVACY.md lists, or that goes to any address but the one in `AGENT_LOOKOUT_WEBHOOK_URL`, including by following a redirect.
- A session's name, folder or anything else from a session that changes the structure of a post, adds a field or a header to it, or, in Slack or a service that reads Slack's format, mentions someone, pings a channel or makes a link that shows other words than its address.
- A post sent over plain HTTP to an address that is not on this machine, or to a server whose certificate was not checked.
- Any write to `~/.claude` or to another tool's files, and any read of the `.key` files in `~/.claude/sessions/`.
- Any write under the Codex folder (`~/.codex`, or the folder `CODEX_HOME` or `AGENT_LOOKOUT_CODEX_HOME` names), any open of a file in its `thread-writer-locks/`, and any read of a Codex file that PRIVACY.md does not list.
- Text from a Codex session file, such as a prompt, a reply or a command's output, reaching the API or the dashboard.
- A session name, path or other session field that runs as script or markup in the dashboard.
- Anything from a status file that runs as script or markup in the dashboard, or in a notification, or that is used as a link, a Jump, a command or a path to open.
- A file outside the folder of status files being read through it: by a symbolic link inside it, by a folder inside it, by a file's name or by a path written in a file, such as its `cwd`.
- Agent Lookout making the folder of status files, or creating, writing, renaming or deleting anything in it.
- A status file that stops its polls, or makes Agent Lookout read more than 200 files or more than 16 KB of one: by its size, its contents, or by being a pipe or a device.
- A way to make the app run anything other than the `claude` binary it found, `ps`, the `tmux` binary it found and `/usr/bin/osascript`, or to pass any of them arguments they should not get.
- A website, or a page served from anywhere but this machine, making the app select a tmux pane.
- A request to `POST /api/jump` that makes tmux do anything but select a pane found for a listed session, its window and its tmux session: running a command, sending keys, or reaching any other pane.
- A session's name, a tmux session's name, or anything else from a session or from tmux, that `tmux` reads as a command, a target or an option.
- A session name, or anything else from a session, that `osascript` reads as AppleScript or as one of its options instead of showing it as text.
- A Jump link that opens anything other than the intended `vscode://` address.
- A notification, or the browser's question about allowing them, appearing when you have not turned notifications on, in Settings or with `AGENT_LOOKOUT_NOTIFICATIONS=on`.
- A notification that holds anything but the session's name and the reason, or that makes the browser fetch anything.
- A page at another address reading or steering the dashboard's notifications, or turning the server's own on or off.

## Out of scope

- Other programs on the same machine reading the local API, sending it the header that turns the server's notifications on or off, or asking it to select a tmux pane. The API has no authentication, so any local process can request it, and on a shared computer that includes other user accounts. This is a known limit of this version.
- A notification the server showed staying in Notification Centre after its session has moved on. The server cannot take one down, and PRIVACY.md says so.
- The dev server started with Vite's `--host` flag, which makes it listen on the network. `npm start` refuses to listen on anything but loopback.
- Attacks that need control of your user account first. Someone with that control can read `~/.claude` and `~/.codex` directly.
- A program on this machine writing a status file to show a session that does not exist, or to change one that does. Any program that can write in the folder can do that: it is how the format works. The folder sits in your home folder, so that means programs you run.
- More than 200 status files: only the 200 written most recently are read.
- A hard link in the folder of status files to a file elsewhere. It is an ordinary file in the folder and is read as one, and making it takes the same access as writing a status file.
- Vulnerabilities in Claude Code, Codex or another agent tool. Report those to the vendor.
- Other programs running as your user reading the mail server's password from the environment of the Agent Lookout process, or from your shell's history. Settings in the environment can be read that way, and PRIVACY.md says so.
- What the mail server and the mailbox do with an email once it has been handed over.
- Other programs running as your user reading the webhook's address from the environment of the Agent Lookout process, or from your shell's history.
- What the service at the webhook's address, such as Slack or Discord, does with a post once it has been sent, including who can read the channel.
- Slack showing a web address that is written out in a session's name as a link to that address. It shows the address as it is written.
- Traffic from Claude Code's own `claude agents` command while Agent Lookout runs it. It may contact Anthropic the way Claude Code normally does.
- Another program later served at the same address using the notification permission your browser gave that address. PRIVACY.md describes this.
- Vulnerabilities in a dependency that cannot be shown to affect Agent Lookout. Report those upstream.
