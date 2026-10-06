# Agent Lookout

Agent Lookout puts the AI agent sessions running on your Mac or Linux computer on one page in your browser, and shows which of them are waiting for you. It finds Claude Code and Codex sessions with no setup, and the sessions of any other agent that writes a small status file. By default it sends nothing anywhere.

[Install](#install) · [Guide](docs/GUIDE.md) · [Privacy](#privacy) · [Website](https://agent-lookout.vercel.app)

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/dashboard-day.png">
  <img alt="The Agent Lookout dashboard. A rail on the left links to Overview, Sources and Settings, and the header has a magnifier that opens the search. At the top, the Needs you panel shows the one session waiting for permission, with its folder and branch, its timer and a Jump button, bars of how long sessions waited on you, and counts of working, idle and stale sessions. Beside it is the Last hour chart. Below are the Sessions list, grouped by status with each session's branch under its folder and a switch between List and Board, the Events log and the Timeline." src="docs/images/dashboard-night.png">
</picture>

For Claude Code it reads the list of sessions Claude Code keeps on your computer, so it finds sessions in a terminal, in VS Code or in the desktop app. For Codex it reads the session files Codex saves in `~/.codex`. It never starts, stops or answers a session. A Jump button takes you to a Claude Code session: it opens it in VS Code, selects its tmux pane, or brings its tab of Terminal or iTerm2 to the front. Turn on notifications in Settings to be told when a session starts waiting and, if you choose, when one finishes, fails or ends, on a Mac even after you close the dashboard's tab. If you set it up, it can also email you or post to a Slack channel.

Codex does not record when it is waiting for your approval, so a Codex session shows as working, idle or finished, never as needing you. Codex support has been checked with the Codex desktop app, and not yet with the Codex CLI or its IDE extension. To show another agent, including one you wrote yourself, see [Your own agents](docs/GUIDE.md#your-own-agents). Other coding agents, AI chat tabs in the browser and a Mac app are planned, in the [roadmap](https://github.com/Olanetsoft/agent-lookout/milestones).

It runs on macOS and Linux. On Linux it has been checked in CI by starting it with `npm start`, and not yet by a person on a Linux desktop. Notifications with no dashboard tab open, and Jump to a tab of Terminal or iTerm2, are macOS only: [On Linux](docs/GUIDE.md#on-linux) has the rest.

## Install

1. Check that Node.js is installed, and Claude Code, Codex or both.

   ```sh
   node --version
   claude --version
   codex --version
   ```

   The first prints `v20.19.0` or newer (on Node 22, `v22.12.0` or newer). The second prints a version number followed by `(Claude Code)`, and the third `codex-cli` followed by a version number. You need Node.js and at least one of the other two. If a command you need is not found, install that program first. Agent Lookout never runs `codex`, so if you use only the Codex desktop app and `codex` is not found, carry on.

2. Download Agent Lookout and install what it needs.

   ```sh
   git clone https://github.com/Olanetsoft/agent-lookout.git
   cd agent-lookout
   npm install
   ```

   npm prints `added ... packages` and no line that starts with `npm error`.

3. Start it. It keeps running until you press Ctrl+C, so leave this terminal open or run it in the background.

   ```sh
   npm run dev
   ```

   It prints `Local:   http://localhost:5173/`. If 5173 is already in use it picks the next number and prints that instead. Use the number it printed in the next two steps.

4. From a second terminal, check that it answers.

   ```sh
   curl -s http://localhost:5173/api/health
   ```

   It prints `{"ok":true,"version":"0.1.0"}`, or a later version number.

5. Open <http://localhost:5173>. Your sessions appear within a few seconds.

To start it again later, run `npm run dev` in the `agent-lookout` folder. The [guide](docs/GUIDE.md) explains each part of the screen, the settings, and what to do when no sessions appear.

To see which sessions need you without opening the browser, run `npm run --silent status` in the same folder, or put it in a tmux status line or a shell prompt as the [guide](docs/GUIDE.md#in-the-terminal) shows. An AI agent can ask the same of `agent-lookout mcp`, a Model Context Protocol server whose tools only read, so one agent can keep track of the others, as [For your agents](docs/GUIDE.md#for-your-agents) shows.

## Privacy

By default Agent Lookout itself sends nothing anywhere: no telemetry, no analytics, no update check and no account. [PRIVACY.md](PRIVACY.md) lists everything it reads and runs, and everything it can send.

- Email and webhook posts are off until you set them up. Then each goes only to the one address you name, through the mail server you name for email, and holds the session's name, what happened, when, and the name of its folder, its app and its agent. [Email](docs/GUIDE.md#email) and [Webhook](docs/GUIDE.md#webhook) say how to set them up and how to turn them off.
- Agent Lookout runs Claude Code's own listing command, which may contact Anthropic the way Claude Code normally does.
- For a Claude Code session that is waiting for you, it reads the last message of the session's transcript to show what it is asking, such as `Run: npm test`, and forgets it when the wait ends. That line stays on this machine: no email, webhook post or answer of `agent-lookout mcp` holds it. `AGENT_LOOKOUT_WAITING_TEXT=off` turns it off.
- Codex's session files hold your conversations. Agent Lookout opens them only to read a few details, such as each session's folder and when each turn started and ended, and keeps none of your prompts, Codex's replies or the commands it ran.
- Jump to a tab of Terminal or iTerm2 needs macOS to let the program you start Agent Lookout from control that app. macOS asks once, and what you allow covers anything else run from that program.
- `agent-lookout mcp` does nothing until you add it to an agent's app. That app usually hands its answers, with your session names, folder names and branches, to its model, which for most agents runs on the vendor's servers. [The MCP server](PRIVACY.md#the-mcp-server) says what an answer holds and how to remove it.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks to run and how to add another agent.

Agent Lookout is [MIT licensed](LICENSE). It is an unofficial project, not affiliated with or endorsed by Anthropic, OpenAI or any other agent maker. See [DISCLAIMER.md](DISCLAIMER.md).
