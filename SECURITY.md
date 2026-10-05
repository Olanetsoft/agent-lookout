# Security

## Reporting a vulnerability

Report it privately through GitHub. On the repository's Security tab, choose "Report a vulnerability", or go straight to <https://github.com/Olanetsoft/agent-lookout/security/advisories/new>. Do not open a public issue for a security problem.

Say what you found, how to reproduce it and what someone could do with it. Leave real session names and folder paths out of the report.

If that page does not open, or shows no form, reach the maintainer, Idris Olubisi, through the links on the [Olanetsoft GitHub profile](https://github.com/Olanetsoft). In that first message, say only that you have a security report for Agent Lookout. The maintainer will agree a private way to send the details.

The project has one maintainer, so replies are best effort. There are no tagged releases yet, so fixes land on `main`.

## What the app handles

Agent Lookout reads metadata about the Claude Code and Codex sessions on your machine: names, working directories, statuses and, for Claude Code, process IDs. It serves that to the dashboard over HTTP on a loopback address. It reads no Claude Code transcripts. It does open Codex's session files, which hold whole conversations, and keeps only when turns started and ended and a few fields. It writes to no agent's files. [PRIVACY.md](PRIVACY.md) lists everything it reads, runs and keeps.

Session names and folder paths can be sensitive. The main risk is that something other than your own browser reads them.

## In scope

- A website, or another machine on the network, reading the local API. That includes getting past the `Host` and `Origin` checks and DNS rebinding.
- `npm start` listening on any address other than loopback.
- Any network request from Agent Lookout itself to anything but its own local server.
- Any write to `~/.claude` or to another tool's files, and any read of the `.key` files in `~/.claude/sessions/`.
- Any write under the Codex folder (`~/.codex`, or the folder `CODEX_HOME` or `AGENT_LOOKOUT_CODEX_HOME` names), any open of a file in its `thread-writer-locks/`, and any read of a Codex file that PRIVACY.md does not list.
- Text from a Codex session file, such as a prompt, a reply or a command's output, reaching the API or the dashboard.
- A session name, path or other session field that runs as script or markup in the dashboard.
- A way to make the app run anything other than the `claude` binary it found and `ps`, or to pass either of them arguments they should not get.
- A Jump link that opens anything other than the intended `vscode://` address.

## Out of scope

- Other programs on the same machine reading the local API. The API has no authentication, so any local process can request it, and on a shared computer that includes other user accounts. This is a known limit of this version.
- The dev server started with Vite's `--host` flag, which makes it listen on the network. `npm start` refuses to listen on anything but loopback.
- Attacks that need control of your user account first. Someone with that control can read `~/.claude` and `~/.codex` directly.
- Vulnerabilities in Claude Code, Codex or another agent tool. Report those to the vendor.
- Traffic from Claude Code's own `claude agents` command while Agent Lookout runs it. It may contact Anthropic the way Claude Code normally does.
- Vulnerabilities in a dependency that cannot be shown to affect Agent Lookout. Report those upstream.
