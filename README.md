# Agent Lookout

Agent Lookout puts every Claude Code and Codex session running on your Mac on one page in your browser, and shows which Claude Code sessions are waiting for you.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/dashboard-day.png">
  <img alt="The Agent Lookout dashboard. At the top, a panel for the one session waiting for permission, with its timer and a Jump button, bars of how long sessions waited on you, and counts of working, idle and stale sessions. Beside it, a bar chart of the last hour. Below, the other sessions grouped by status, an events log and a timeline of the last hour." src="docs/images/dashboard-night.png">
</picture>

<sub>The dashboard with sample data. None of these sessions are real.</sub>

It reads the list of sessions Claude Code keeps on your computer, so it finds sessions in a terminal, in VS Code or in the Claude Code desktop app with no setup. For Codex it reads the session files Codex saves in `~/.codex`, also with no setup. It only watches. It cannot start, stop or answer a session yet.

Today it watches Claude Code and Codex on macOS. Codex does not record when it is waiting for your approval, so a Codex session shows as working, idle or finished, never as waiting for you. Other coding agents, AI chat tabs in the browser and a Mac app are planned, in the [roadmap](https://github.com/Olanetsoft/agent-lookout/milestones).

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

## Privacy

Agent Lookout itself sends nothing anywhere. It does run Claude Code's own listing command, which may contact Anthropic the way Claude Code normally does. Codex's session files hold your conversations. Agent Lookout opens them only to read a few details, such as each session's folder and when each turn started and ended, and keeps none of your prompts, Codex's replies or the commands it ran. [PRIVACY.md](PRIVACY.md) lists everything it reads and runs.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks to run and how to add another agent.

Agent Lookout is [MIT licensed](LICENSE). It is an unofficial project, not affiliated with or endorsed by Anthropic or any other agent maker. See [DISCLAIMER.md](DISCLAIMER.md).
