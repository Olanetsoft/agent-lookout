---
title: Jump to a session's window
description: Set up Jump so one press takes you to a Claude Code session in VS Code, in its tmux pane, or in its Terminal or iTerm2 tab on a Mac.
---

Jump takes you to the window a Claude Code session runs in. The button is in the Needs you panel, in the Sessions list or on a session's card on the board, and in a session's details. Only Claude Code sessions have it.

## Where Jump works

| The session runs in                        | How Jump reaches it                                     | macOS | Linux | Windows |
| ------------------------------------------ | ------------------------------------------------------- | ----- | ----- | ------- |
| VS Code, through the Claude Code extension | A `vscode://` link that your browser opens              | Yes   | Yes   | Yes     |
| A tmux pane                                | Agent Lookout runs `tmux` to select the pane            | Yes   | Yes   | No      |
| A tab of Terminal or iTerm2                | Agent Lookout runs `osascript` to bring the tab forward | Yes   | No    | No      |

These sessions get no Jump button:

- a session in the Claude Code desktop app
- a session in another terminal, such as Warp, Ghostty, Alacritty, kitty, WezTerm or the terminal inside VS Code, unless it runs inside tmux
- a session whose process has ended, unless it is in VS Code
- a session on another machine
- a session of any other agent, such as Codex, and a session from a status file

To see what Agent Lookout says on your machine, open Sources. In the card What each agent can report, the Jump column for Claude Code says Partly. Point at it to read why:

```text
In VS Code, in tmux, and in a tab of Terminal or iTerm2 on a Mac. Not in the desktop app or another terminal.
```

On Windows it reads:

```text
Only in VS Code. On Windows there is no tmux pane or Terminal tab to reach, and the desktop app has no link.
```

## How Agent Lookout finds the window

Agent Lookout reads Claude Code's session registry, `~/.claude/sessions`, every 2 seconds. A file there names the app the session was started from, in its `entrypoint`. A session started by the VS Code extension, `claude-vscode`, gets its link from that.

For a session whose process is running, Agent Lookout looks for the window itself:

- **tmux.** It runs `tmux -u list-panes -a -F '#{pane_pid} #{pane_id} #{window_index} #{pane_index} #{session_name}'`. Only when that lists a pane, it also runs `ps -A -o pid=,ppid=`. It follows the session's process up through its parents until it reaches the process tmux started in a pane. It looks when it first finds a Claude Code session, then every 30 seconds. It looks sooner when a new session appears, but never within 5 seconds of the last look.
- **Terminal and iTerm2, on macOS only.** It runs `ps -A -o pid=,ppid=,tty=,comm=`. It follows the session's process up through its parents to Terminal's program or iTerm2's. Every process on the way must have the session's terminal, such as `/dev/ttys004`. It asks once about each new session, and never within 5 seconds of the last look.

A pane comes first. A session inside tmux is reached through tmux, even when tmux runs in a Terminal tab. On the page, a VS Code link comes before both.

So a session that has just started can be a few seconds without its button. After you move a pane, the place named on the button can be up to 30 seconds out of date. The press still selects the right pane, because it goes by the pane's own ID.

Jump never sends keys or text to a session. [PRIVACY.md](../PRIVACY.md#tmux) lists every command it runs and what it reads.

## VS Code

Here Jump is a link:

```text
vscode://anthropic.claude-code/open?session=<session ID>
```

Your browser opens it, and VS Code opens the session. Agent Lookout's server takes no part, so the row shows no outcome after the press. In the [Mac app](GUIDE.md#desktop-app), the link is handed to macOS only when it has exactly this shape.

For the jump to succeed:

- The session was started by Claude Code's VS Code extension. A `claude` you run in VS Code's own terminal is a terminal session, and has a button only inside tmux.
- Agent Lookout can read the session registry at `~/.claude/sessions`. Without it, Agent Lookout cannot tell which app a session runs in, and there is no link.
- `vscode://` links open VS Code. On Linux and Windows, that works where VS Code has registered itself to open those links.
- The session's folder is open in the VS Code window that has focus. Otherwise VS Code starts a new conversation.

## tmux

Point at the button, or move to it with Tab, to read where it goes, such as `tmux, checkout-flow:0.0`: the tmux session's name, then the window's number and the pane's.

Press it, and Agent Lookout runs these, with the pane's ID that it found itself:

```text
tmux select-window -t <pane ID>
tmux select-pane -t <pane ID>
tmux -u display-message -p -t <pane ID> '#{session_id} #{window_index} #{pane_index} #{session_name}'
tmux list-clients -F '#{session_id} #{client_name}'
tmux switch-client -c <client> -t <pane ID>
```

The last one runs once for each terminal attached to tmux that shows another tmux session. That terminal switches to the pane's session. A terminal already on that session is not switched: it shows the window and pane just selected. With no terminal attached, you see the pane when you next attach to that tmux session.

The row then says "Selected in tmux" for a few seconds. Jump does not bring your terminal app to the front: you switch to it yourself. If another pane of the window was zoomed, tmux ends the zoom.

For the jump to succeed:

- You are on macOS or Linux. Agent Lookout never runs tmux on Windows.
- `tmux` is on your `PATH`, or at `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`, `/opt/local/bin/tmux` or `/usr/bin/tmux`. The Mac app, opened from the Finder or the Dock, does not get your shell's `PATH`, which is why those places are there.
- The session's process runs in a pane of the tmux server Agent Lookout reaches. That is the server the `tmux` command reaches from where you started Agent Lookout: the default server, or the one you started Agent Lookout inside. Agent Lookout passes no `-L` or `-S`. It gives tmux the environment it was started with, less its own `AGENT_LOOKOUT_*` settings, so `TMUX` and `TMUX_TMPDIR` reach tmux. A session in another server, such as one started with `tmux -L`, gets no button.
- `ps` is at `/usr/bin` or `/bin`. Where it is not, as on NixOS, no session in tmux has a button.
- `AGENT_LOOKOUT_TMUX` is not set to `off`.

## Terminal and iTerm2 on a Mac

Point at the button to read which app it goes to: `Terminal` or `iTerm2`. Press it, and Agent Lookout runs `/usr/bin/osascript` with a fixed script for that app, then `--` and the session's terminal.

- In Terminal, the tab becomes the selected tab of its window. The window comes back from the Dock if it was minimised and moves in front of Terminal's other windows, and Terminal comes to the front.
- In iTerm2, the window, the tab and the pane are selected, and iTerm2 comes to the front.

The row then says "Switched to Terminal" or "Switched to iTerm2". When the app is not running, it is not started.

For the jump to succeed:

- You are on macOS.
- The session runs directly in a tab: not inside tmux, and not inside another program that makes its own terminal, such as `script`. Every process between the session and the app must have the session's terminal.
- Terminal is at `/System/Applications/Utilities/Terminal.app`. iTerm2 is at `/Applications/iTerm.app`, or runs its shells under its server in `~/Library/Application Support/iTerm2`.
- `AGENT_LOOKOUT_TERMINAL_JUMP` is not set to `off`.
- macOS allows the program Agent Lookout runs in to control the app.

### The Automation permission

The first time you press Jump on a tab, macOS asks whether the program Agent Lookout runs in may control Terminal, or iTerm2. With `npx agent-lookout`, that is the program you started it from, such as Terminal, iTerm2 or your editor. So the question names that program, not Agent Lookout. In the Mac app, it names Agent Lookout.

On that first press, once it has waited a second, the row says:

```text
macOS will ask once whether the app you started Agent Lookout from may control Terminal. Allow it to let Jump switch tabs.
```

For a tab of iTerm2 it names iTerm2. In the Mac app it says "whether Agent Lookout may control" instead. The page says this once on each browser, for each app.

- Choose Allow, and the tab comes forward. macOS remembers the answer and does not ask again.
- Choose Don't Allow, and the row says "macOS did not allow it", with the line "To let Jump switch tabs, allow it in System Settings, Privacy & Security, Automation."

To change the answer, open System Settings, then Privacy & Security, then Automation. Under the program you start Agent Lookout from, turn Terminal or iTerm2 on or off. macOS gives this permission to that program as a whole, so anything else you run from it can then control Terminal too. If you start Agent Lookout from another program, macOS asks again, for that program.

Jump does not need the Accessibility permission. The scripts use only Terminal's and iTerm2's own scripting, and nothing in Agent Lookout drives the user interface.

## Worked example: tmux

Here Claude Code runs in a tmux session called `checkout-flow`, and your terminal shows another tmux session, `docs-site`. One press of Jump brings that terminal over to the agent.

1. Open a terminal, and start a tmux session in your project folder:

   ```bash
   cd ~/code/storefront
   tmux new-session -s checkout-flow
   ```

2. In that tmux session, start Claude Code:

   ```bash
   claude
   ```

3. Detach with your tmux prefix and `d`, which is Ctrl+B, then d, unless you changed the prefix. Then start a second tmux session, so this terminal shows another one:

   ```bash
   tmux new-session -s docs-site
   ```

4. Open a second terminal window, outside tmux, and start Agent Lookout there. Started outside tmux, it reaches the default tmux server, which holds both sessions.

   ```bash
   npx agent-lookout
   ```

   ```text
   Agent Lookout is running at http://127.0.0.1:4777
   It listens on this machine only. Press Ctrl+C to stop.
   ```

5. Open `http://127.0.0.1:4777`. Within a few seconds, the Claude Code session has a Jump button in the Sessions list. Point at it to read where it goes:

   ```text
   tmux, checkout-flow:0.0
   ```

   The numbers are the window's and the pane's, as your tmux counts them.

6. Press Jump. The row says "Selected in tmux". The first terminal switches from `docs-site` to `checkout-flow`, with Claude Code's pane selected. Switch to that terminal yourself.

To see what Agent Lookout sees, run the command it runs, from a terminal outside tmux:

```bash
tmux -u list-panes -a -F '#{pane_pid} #{pane_id} #{window_index} #{pane_index} #{session_name}'
```

Each line holds the process tmux started in a pane, the pane's ID, the window's and the pane's numbers, and the tmux session's name. A pane of `checkout-flow` should be listed. If it is not, Agent Lookout reaches another tmux server than the one the session runs in.

## What the row says

| It says                                  | What happened                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Selected in tmux                         | The pane is selected.                                                                                                      |
| Switched to Terminal, Switched to iTerm2 | The tab is in front.                                                                                                       |
| No tmux pane found, No tab found         | Agent Lookout knows no pane or tab for the session now, as when it has ended or left tmux since the page last heard of it. |
| That pane has closed                     | tmux no longer has that pane. Nothing was changed.                                                                         |
| tmux has stopped                         | No tmux server answered. Nothing was changed.                                                                              |
| That tab has closed                      | No tab of the app shows the session's terminal, or the app is not running. Nothing was changed.                            |
| macOS did not allow it                   | macOS has not allowed the program Agent Lookout runs in to control the app.                                                |
| Try again in a moment                    | Another Jump was pressed less than a second before, or one still waits for your answer to macOS.                           |
| Jump did not work                        | Agent Lookout did not answer in time, tmux could not be run, or the app gave no answer within a minute.                    |

The words stay about 4 seconds, and 12 seconds for "macOS did not allow it". Agent Lookout makes one jump a second, so a second press of the same button within a second of its answer is not sent. The [Jump section of the guide](GUIDE.md#jump) has more, and [API.md](API.md#post-apijump) describes the request a press sends.

## Turn Jump off

```bash
AGENT_LOOKOUT_TMUX=off AGENT_LOOKOUT_TERMINAL_JUMP=off npx agent-lookout
```

`AGENT_LOOKOUT_TMUX=off` stops Agent Lookout running tmux, and the `ps` it runs for tmux. `AGENT_LOOKOUT_TERMINAL_JUMP=off` stops it looking for tabs and running `osascript` for Jump. Nothing turns off the VS Code link. The Jump column in What each agent can report does not change with either switch.

## Troubleshooting

### No Jump button on a session in tmux

**Symptom:** A Claude Code session runs in tmux, but its row has no Jump button. The Jump column for Claude Code in What each agent can report still says Partly, with "In VS Code, in tmux, and in a tab of Terminal or iTerm2 on a Mac. Not in the desktop app or another terminal."

**Cause:** Agent Lookout found no pane for the session's process. Most often the session runs in a tmux server Agent Lookout does not reach: one started with `tmux -L`, or the default server while Agent Lookout runs inside another one. It is the same when `tmux` is not on `PATH` or in the four fixed places, when `ps` is not at `/usr/bin` or `/bin`, when `AGENT_LOOKOUT_TMUX` is `off`, and for the first few seconds after a session starts.

**Fix:** Run the `list-panes` command from the worked example in a shell like the one you start Agent Lookout from: outside tmux if you start it outside tmux. If the session's pane is not listed, start Agent Lookout where `tmux` reaches the session's server: outside tmux for the default server, or in a pane of the server the session runs in. The button comes within a few seconds.

### No Jump button on a session in VS Code

**Symptom:** A session of the Claude Code extension in VS Code has no Jump button. Sources says "There is no session registry at ~/.claude/sessions, so sessions are listed with the claude command every 5 seconds instead. Their apps and status times are unknown."

**Cause:** Agent Lookout learns which app a session runs in from the session registry. Without it, sessions come from the `claude agents` command alone. Their app is unknown, so there is no `vscode://` link. This happens when Claude Code has not written `~/.claude/sessions`, or when Agent Lookout runs with another `HOME`.

**Fix:** Start Agent Lookout with your own `HOME`, on the computer where VS Code runs, and check that `~/.claude/sessions` exists while a session runs. If you set `AGENT_LOOKOUT_CLAUDE_HOME`, point it at the Claude Code folder that holds `sessions`.

### "macOS did not allow it"

**Symptom:** Pressing Jump on a session in Terminal or iTerm2 shows "macOS did not allow it", with "To let Jump switch tabs, allow it in System Settings, Privacy & Security, Automation."

**Cause:** macOS refused to let the program Agent Lookout runs in control the app (error -1743). You chose Don't Allow, or the switch for that app is off.

**Fix:** Open System Settings, then Privacy & Security, then Automation. Under the program you start Agent Lookout from, or under Agent Lookout in the Mac app, turn on Terminal or iTerm2. Then press Jump again.

### "Jump did not work" after about a minute

**Symptom:** The first press on a session in Terminal or iTerm2 waits, then the row says "Jump did not work". A press of another Jump meanwhile says "Try again in a moment".

**Cause:** Agent Lookout waits up to a minute for `osascript`, and the page a few seconds more. macOS's question was not answered in that time, so the run timed out. A timeout counts as a failure, not as a refusal.

**Fix:** Press Jump again and answer macOS's question. Once you choose Allow, macOS does not ask again.
