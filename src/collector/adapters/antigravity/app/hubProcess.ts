import type { AntigravityLiveness } from "../../../../core/mapping/antigravityMapping.ts";
import { runPs, type PsAnswer } from "../../../processes/ps.ts";

/**
 * Whether Antigravity 2.0 is open, from `ps`, so its chats can be shown as
 * finished once it is closed.
 *
 * Antigravity 2.0 runs the agent of every chat in one program, its hub, on
 * macOS `Contents/Resources/bin/language_server` inside `Antigravity.app`,
 * seen in `/Applications`. The app can be anywhere else too: in
 * `~/Applications`, another folder or another disk, or where macOS moves an
 * app opened from Downloads (App Translocation). So any full path that ends in
 * the hub's place inside `Antigravity.app` is taken for it. The Antigravity
 * IDE runs a language server too, from inside `Antigravity IDE.app`, at
 * another place in its bundle, which is not this one.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale: `ps -A -o comm=`, the name each process gives its program and
 * nothing else. On macOS that is a process's first argument, which for the
 * hub is its full path. Each line is compared with the hub's place and
 * dropped. The rest of a process's arguments are never asked for: the hub's
 * hold a secret.
 *
 * It is run only on macOS. Where the hub is on Linux and Windows is not known
 * yet, so there whether Antigravity is open is not known either.
 */

/** The name each process gives its program, and nothing else about any of them. */
export const HUB_TABLE_ARGS = ["-A", "-o", "comm="] as const;

/** Where the hub is inside the app, which ends the full path `ps` prints for it, wherever the app is. */
export const HUB_IN_APP = "/Antigravity.app/Contents/Resources/bin/language_server";

/** Whether one line of what `ps -A -o comm=` printed is the hub: a full path ending in its place inside the app. */
export function hubInTable(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    const program = line.trim();
    return program.startsWith("/") && program.endsWith(HUB_IN_APP);
  });
}

/** Whether the hub runs, or `ok: false` when that could not be told. */
export type HubAnswer = { ok: true; running: boolean } | { ok: false };

/** Runs `ps` with these arguments. Tests pass their own. */
export type RunPs = (args: readonly string[]) => Promise<PsAnswer>;

export interface HubProcessReader {
  /** Asks `ps` now, on macOS. Elsewhere answers `ok: false` and runs nothing. Never throws. */
  read(): Promise<HubAnswer>;
}

export function createHubProcessReader(
  options: { platform?: NodeJS.Platform; run?: RunPs } = {},
): HubProcessReader {
  const run = options.run ?? runPs;
  const platform = options.platform ?? process.platform;
  return {
    async read() {
      if (platform !== "darwin") return { ok: false };
      try {
        const table = await run(HUB_TABLE_ARGS);
        return table.ok ? { ok: true, running: hubInTable(table.stdout) } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  };
}

/**
 * Whether Antigravity 2.0 has a chat open: every chat while the hub runs, none
 * once it does not, and "unknown" when `ps` could not say. A chat written
 * after `ps` was last asked, at `askedAt`, counts as open, since the app may
 * have been opened since, as the CLI's adapter does for an agy program
 * started since.
 */
export function hubLiveness(
  answer: HubAnswer | null,
  askedAt: number | null,
  writtenAt: number | null,
): AntigravityLiveness {
  if (answer === null || !answer.ok) return "unknown";
  if (answer.running) return true;
  return askedAt !== null && writtenAt !== null && writtenAt > askedAt;
}
