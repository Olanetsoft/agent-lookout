// The MiMo Code adapter, cut off from this machine, for the tests that share
// it: the OpenCode adapter's stand-ins, the files held in memory, a `sqlite3`
// that answers MiMo Code's own probe, sessions query and question of a
// session's last text, and a `ps` that says a MiMo Code program runs, with a
// clock the test moves by hand. Nothing here touches a real file or runs a
// program.

import {
  createMimoCodeAdapter,
  MIMO_EXTRAS,
  MIMO_SESSIONS_QUERY,
  mimoCodeDatabaseFor,
  type MimoCodeAdapterOptions,
} from "@collector/adapters/mimo-code/index";
import { createDatabaseReader } from "@collector/adapters/opencode/database";
import { probeQueryFor } from "@collector/adapters/opencode/sessionRows";
import { HOME, NOW, probeJson } from "@tests/fixtures/mimo-code/mimoCode";
import {
  handClock,
  memoryFiles,
  standInProcesses,
  standInSqlite,
  type MemoryFiles,
  type StandInProcesses,
  type StandInSqlite,
} from "@tests/support/adapters/opencodeAdapter";

export { handClock, memoryFiles, standInProcesses, type MemoryFiles, type StandInProcesses };

/** The probe MiMo Code's database is asked. */
export const MIMO_PROBE_QUERY = probeQueryFor(MIMO_EXTRAS);

/**
 * A stand-in for `sqlite3` that answers MiMo Code's sessions query with these
 * rows, its probe with MiMo Code's tables, and MiMo Code's question of a
 * session's last text with what the test gives it.
 */
export function standInMimoSqlite(initial: Record<string, unknown>[] = []): StandInSqlite {
  const sqlite = standInSqlite(initial, [MIMO_SESSIONS_QUERY], MIMO_PROBE_QUERY, MIMO_EXTRAS);
  sqlite.probe(probeJson());
  return sqlite;
}

/**
 * An adapter that reads only the stand-in files and asks only the stand-in
 * `sqlite3`, opened as the adapter opens MiMo Code's database, and a `ps`
 * that says a MiMo Code program runs unless `options` gives another. With
 * nothing in `env`, it reads `~/.local/share/mimocode/mimocode.db`.
 */
export function mimoCodeAdapterFor(
  files: MemoryFiles,
  sqlite: StandInSqlite = standInMimoSqlite(),
  options: MimoCodeAdapterOptions = {},
) {
  const env = options.env ?? {};
  const platform = options.platform ?? "darwin";
  const file = mimoCodeDatabaseFor(env, options.homeDir ?? HOME);
  return createMimoCodeAdapter({
    env,
    homeDir: HOME,
    now: () => NOW,
    platform,
    io: files.io,
    reader:
      file === null
        ? undefined
        : createDatabaseReader({
            file,
            io: files.io,
            platform,
            run: sqlite.run,
            find: sqlite.find,
            v1Query: MIMO_SESSIONS_QUERY,
            readsV2: false,
            v1Extras: MIMO_EXTRAS,
          }),
    processes: standInProcesses(),
    ...options,
  });
}
