---
title: Quickstart
description: Start Agent Lookout with npx, find a Claude Code session that waits for your permission, jump to it, and stop Agent Lookout again.
---

In about five minutes you start Agent Lookout, find a Claude Code session that waits for your approval, read what it asks, and jump to it.

## Prerequisites

**Node.js 22.12 or later.** Check your version:

```bash
node --version
```

It prints `v22.12.0` or a later version. On an older Node.js, Agent Lookout stops at once with one line, such as:

```text
Agent Lookout needs Node.js 22.12 or newer, and this is Node.js 20.19.4.
```

**macOS, Linux or Windows.** Agent Lookout is built and used on macOS. Linux and Windows are tested in CI, but nobody uses them day to day yet. Some parts depend on your system:

- Jump to a tab of Terminal or iTerm2 works on macOS only.
- Jump to a tmux pane works on macOS and Linux.
- Jump to VS Code works on all three.
- Allow and Deny do not work on Windows.

**At least one Claude Code or Codex session.** If none is running, start Claude Code in a project folder, such as `~/code/storefront`:

```bash
cd ~/code/storefront
claude
```

For Codex, run `codex` and send a prompt. A Codex session appears once its first prompt is sent.

The steps below need a Claude Code session, because a Codex session never shows as needing you. For Jump to reach the session, run `claude` in a tab of Terminal or iTerm2 on a Mac, or inside tmux, or use the Claude Code extension in VS Code. [INSTALL.md](INSTALL.md#requirements) lists the versions each agent needs, such as a Claude Code that has the `claude agents` command, and Codex 0.155 or later.

## Run it

Open a second terminal and run:

```bash
npx agent-lookout
```

Run it from any folder that is not a clone of the agent-lookout repository.

The first time, npm names the package and asks `Ok to proceed? (y)`. Press Enter. The download and start take about 4 seconds. After that npm keeps the package in its cache, and it starts in about a second. Then it prints:

```text
Agent Lookout is running at http://127.0.0.1:4777
It listens on this machine only. Press Ctrl+C to stop.
```

Open http://127.0.0.1:4777 in your browser. Your sessions appear within a few seconds. Leave the terminal open: Agent Lookout runs until you press Ctrl+C there.

To have it open the address in your default browser, add `--open`:

```bash
npx agent-lookout --open
```

It uses `open` on macOS, `xdg-open` on Linux and `rundll32.exe` on Windows. If the browser cannot be opened, it prints one line and keeps running:

```text
The browser could not be opened. Open http://127.0.0.1:4777 in it.
```

If it stops at the start instead:

| It prints                                                                                            | What to do                                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Port 4777 is already in use. Stop the other program, or choose another port with --port.`           | Run `npx agent-lookout --port 4778`, and open http://127.0.0.1:4778.           |
| `agent-lookout could not run: Cannot find package 'tsx' imported from <clone>/bin/agent-lookout.mjs` | You ran it inside a clone of the repository. Run it from another folder.       |
| `sh: agent-lookout: command not found`                                                               | You ran `npx agent-lookout@0.2.13` inside a clone. Run it from another folder. |

If the page shows no session, [No sessions appear](GUIDE.md#no-sessions-appear) walks you through the checks.

## Find a session that needs you, and jump to it

1. In your Claude Code session, ask for something that needs a shell command, such as:

   ```text
   Run npm test and tell me what fails.
   ```

   Claude Code stops and asks your permission before it runs the command, unless your settings already allow it.

2. Look at the Needs you panel, at the top of the Overview. Within a few seconds its heading reads Needs you, followed by the count, 1. The session shows:

   - its name, in large type
   - the reason: Waiting for permission
   - what it asks, read from the end of its transcript, such as `Run: npm test`
   - where it runs: the folder, the git branch and the app, such as `storefront on main in Terminal`
   - a timer of how long it has waited, with `waiting since` and the time the wait began
   - a Jump button beside the timer

   A question shows as Asked you a question, and any other wait as Waiting for you. With more than one session waiting, the longest wait comes first, and the others are listed under it, each with its own Jump.

3. Read what it asks. Besides `Run:` for a command, the line can be `Edit:`, `Write:` or `Read:` with a file's path, `Fetch:` with an address, `Search:` with a search, `Approve the plan`, or the question it put to you. A line too long for two lines is cut: point at it, or move to it with Tab, to read all of it. Click the session's name to open its details, with the full path of its folder. Press Esc to close them.

4. Click Jump. For a tmux pane or a tab, point at the button first to read where it goes, such as `tmux, work:2.1` or `Terminal`. What happens depends on where the session runs:

   | Where it runs                         | What Jump does                                                                                                                                                                                    | What the row says                           |
   | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
   | VS Code, in the Claude Code extension | Your browser opens a `vscode://` link, and VS Code opens the session. VS Code finds it only when its folder is open in the VS Code window that has focus. Otherwise it starts a new conversation. | Nothing                                     |
   | A tmux pane, on macOS or Linux        | Agent Lookout selects the pane's window and the pane, and switches each attached terminal that shows another tmux session over to it. It does not bring your terminal app to the front.           | Selected in tmux                            |
   | A tab of Terminal or iTerm2, on macOS | Agent Lookout selects the tab and brings the app to the front.                                                                                                                                    | Switched to Terminal, or Switched to iTerm2 |

   The words show beside the session's name for a few seconds. Jump sends nothing to the session: no keys and no text.

   The first time you jump to a Terminal tab, macOS asks whether the app you started Agent Lookout from may control Terminal. While it asks, the row says:

   ```text
   macOS will ask once whether the app you started Agent Lookout from may control Terminal. Allow it to let Jump switch tabs.
   ```

   Choose Allow, and the tab comes forward. macOS asks the same once for iTerm2. If you choose Don't Allow, the row says macOS did not allow it, and you can change your answer in System Settings, Privacy & Security, Automation.

5. Answer the prompt in the session. Within a few seconds the session leaves Needs you. Once no session waits, the panel says Nothing needs you.

**No Jump button?** Only Claude Code sessions have one, and only in VS Code, inside tmux, or in a tab of Terminal or iTerm2 on a Mac. A session in another terminal outside tmux, such as Warp or the terminal of VS Code, or in the Claude Code desktop app, has none. On Windows, only sessions in VS Code have one. [Jump to a session's window](guide-jump-to-window.md) covers every case.

**Codex sessions never show as needing you.** Codex does not write approval waits to its files, so a Codex session that waits for your approval shows as working in the Sessions list. After 5 minutes with no writes, its row says how long it has been quiet, such as `quiet for 12m`. When you see that, check the Codex window.

**Allow and Deny need the Claude Code plugin.** Without it, the panel shows what the session asks but no buttons, and you answer in the session. To answer from the page, run these two commands in Claude Code:

```text
/plugin marketplace add Olanetsoft/agent-lookout
/plugin install agent-lookout@agent-lookout
```

A new Claude Code session picks it up. A prompt to run a shell command then shows in the panel under `Asks to run`, with the whole command and its description, then Deny and Allow. Neither button takes a press in the first second. Press Allow, and the session leaves Needs you at once, and the Events log says it `had a request allowed from Agent Lookout`. The prompt in the session still works too, and whichever you answer first wins. In Settings, the Permission prompts card says whether the plugin's requests reach Agent Lookout. [Answer a permission prompt](GUIDE.md#answer-a-permission-prompt) has the details.

While notifications are off, the Overview may also ask `Get a notification when a session needs you?`. Press Turn on and allow notifications when your browser asks. It then shows one each time a session starts waiting for you, while a dashboard tab is open.

## Stop it

Press Ctrl+C in the terminal where it runs. It prints nothing more, and your prompt comes back. Agent Lookout itself exits with 0. Under `npx`, the shell reports the interrupt instead, as exit code 130:

```bash
echo $?
```

```text
130
```

Nothing of Agent Lookout's keeps running. The port stops answering, a `claude` command it started to list sessions is stopped with it if one is still running, and on macOS and Linux the socket for Allow and Deny is removed. To check that it has stopped:

```bash
curl -s http://127.0.0.1:4777/api/health || echo "stopped"
```

```text
stopped
```

While Agent Lookout runs, the same command prints `{"ok":true,"version":"0.2.13"}`, with the version you run.

What stays on disk:

- The history behind the Events log and the charts, in `~/.agent-lookout/history`. There is one file for each day by the UTC clock, such as `v1-2026-10-27.jsonl`. It is written every 5 seconds, and once more as Agent Lookout stops. A day's file is deleted once that day ended more than 8 days ago, and the files hold 20 MB at most. They hold events and counts, and no folder path, prompt or anything a waiting session asks.
- `~/.agent-lookout/settings.json`, but only once you change a time rule or a permission rule in Settings.
- npm's copy of the package, in `~/.npm/_npx/`, and npm's logs, in `~/.npm/_logs/`.

Agent Lookout's own code writes nothing under `~/.claude`. To list sessions it runs Claude Code's own `claude agents --json --all`, and that program keeps its own files, such as `~/.claude.json`.

To clear the history, open Settings, press Clear history on the History card, then Clear history again to confirm. To keep no history on disk at all, start it with `AGENT_LOOKOUT_HISTORY=off`:

```bash
AGENT_LOOKOUT_HISTORY=off npx agent-lookout
```

The Events log and the charts then start empty each time. On macOS and Linux, while answering is on, it still makes the folder `~/.agent-lookout` for the socket of Allow and Deny. The socket holds nothing and is removed as Agent Lookout stops, and the empty folder stays. Add `AGENT_LOOKOUT_ANSWER=off` to make no folder at all, which also turns Allow and Deny off. [The history](../PRIVACY.md#the-history) in PRIVACY.md says what the files hold.

## Next steps

- [Jump to a session's window](guide-jump-to-window.md): every way Jump reaches a session, and what to do when it fails.
- [Introduction](introduction.md): what Agent Lookout does, and what it leaves alone.
- [The guide](GUIDE.md): every part of the screen, Stop, permission rules and notifications. [In the terminal](GUIDE.md#in-the-terminal) shows `npx agent-lookout status`, which prints who needs you in a shell prompt or a tmux status line.
