// The Kilo Code adapter, cut off from this machine, for the tests that share
// it: the OpenCode adapter's stand-ins, the files held in memory, a `sqlite3`
// that answers Kilo Code's own sessions query, a probe of Kilo Code's tables
// and OpenCode's question of a session's last text, and a `ps` that says a
// Kilo Code program runs, with a clock the test moves by hand. Nothing here
// touches a real file or runs a program.

import {
  createKiloCodeAdapter,
  KILO_SESSIONS_QUERY,
  kiloDatabaseFor,
  type KiloCodeAdapterOptions,
} from "@collector/adapters/kilo-code/index";
import { createDatabaseReader } from "@collector/adapters/opencode/database";
import { HOME, NOW, probeJson } from "@tests/fixtures/kilo-code/kiloCode";
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

/** A stand-in for `sqlite3` that answers Kilo Code's sessions query with these rows, and the probe with Kilo Code's tables. */
export function standInKiloSqlite(initial: Record<string, unknown>[] = []): StandInSqlite {
  const sqlite = standInSqlite(initial, [KILO_SESSIONS_QUERY]);
  sqlite.probe(probeJson());
  return sqlite;
}

/**
 * An adapter that reads only the stand-in files and asks only the stand-in
 * `sqlite3`, opened as the adapter opens Kilo Code's database, and a `ps` that
 * says a Kilo Code program runs unless `options` gives another. With nothing
 * in `env`, it reads `~/.local/share/kilo/kilo.db`.
 */
export function kiloCodeAdapterFor(
  files: MemoryFiles,
  sqlite: StandInSqlite = standInKiloSqlite(),
  options: KiloCodeAdapterOptions = {},
) {
  const env = options.env ?? {};
  const platform = options.platform ?? "darwin";
  const file = kiloDatabaseFor(env, options.homeDir ?? HOME);
  return createKiloCodeAdapter({
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
            v1Query: KILO_SESSIONS_QUERY,
            readsV2: false,
          }),
    processes: standInProcesses(),
    ...options,
  });
}
