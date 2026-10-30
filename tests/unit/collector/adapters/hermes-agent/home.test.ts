import { describe, expect, test } from "vitest";

import {
  createProfileLister,
  DEFAULT_PROFILE,
  hermesRootFor,
  listProfiles,
  MAX_PROFILES,
  PROFILE_NAME,
  profileDatabase,
  PROFILES_LIST_MS,
} from "@collector/adapters/hermes-agent/home";
import {
  DEFAULT_DATABASE,
  HOME,
  NOW,
  PROFILE,
  PROFILE_DATABASE,
  ROOT,
} from "@tests/fixtures/hermes-agent/hermesAgent";
import { memoryFiles } from "@tests/support/adapters/hermesAgentAdapter";
import { asWritten } from "@tests/support/paths";

/** The root a set of variables gives, as the tests write paths. */
const rootFor = (env: NodeJS.ProcessEnv) => asWritten(hermesRootFor(env, HOME));

describe("hermesRootFor", () => {
  test("is ~/.hermes when nothing names another", () => {
    expect(rootFor({})).toBe(ROOT);
    expect(rootFor({ HERMES_HOME: "" })).toBe(ROOT);
    expect(rootFor({ HERMES_HOME: "   " })).toBe(ROOT);
  });

  test("is the folder AGENT_LOOKOUT_HERMES_HOME names, and then Hermes Agent's own variable is not read", () => {
    expect(rootFor({ AGENT_LOOKOUT_HERMES_HOME: " /srv/hermes-test " })).toBe("/srv/hermes-test");
    expect(
      rootFor({
        AGENT_LOOKOUT_HERMES_HOME: "/srv/hermes-test",
        HERMES_HOME: "/srv/other/profiles/work",
      }),
    ).toBe("/srv/hermes-test");
    // A folder in it named like a profile's is still the folder named.
    expect(rootFor({ AGENT_LOOKOUT_HERMES_HOME: "/srv/x/profiles/work" })).toBe(
      "/srv/x/profiles/work",
    );
    // Set to nothing but spaces, it is not set.
    expect(rootFor({ AGENT_LOOKOUT_HERMES_HOME: "  ", HERMES_HOME: "/srv/hermes" })).toBe(
      "/srv/hermes",
    );
  });

  test("a HERMES_HOME in ~/.hermes, a profile's folder or the folder itself, has ~/.hermes as its root", () => {
    expect(rootFor({ HERMES_HOME: ROOT })).toBe(ROOT);
    expect(rootFor({ HERMES_HOME: `${ROOT}/` })).toBe(ROOT);
    expect(rootFor({ HERMES_HOME: `${ROOT}/profiles/${PROFILE}` })).toBe(ROOT);
    expect(rootFor({ HERMES_HOME: "~/.hermes/profiles/coder" })).toBe(ROOT);
    expect(rootFor({ HERMES_HOME: `${ROOT}/somewhere/deeper` })).toBe(ROOT);
  });

  test("a HERMES_HOME of <root>/profiles/<name> elsewhere has <root> as its root", () => {
    expect(rootFor({ HERMES_HOME: "/srv/hermes/profiles/work" })).toBe("/srv/hermes");
    expect(rootFor({ HERMES_HOME: "~/hermes-data/profiles/work" })).toBe(`${HOME}/hermes-data`);
  });

  test("any other HERMES_HOME is its own root, with a leading ~ made the home folder", () => {
    expect(rootFor({ HERMES_HOME: "/srv/hermes" })).toBe("/srv/hermes");
    expect(rootFor({ HERMES_HOME: "~/hermes-data" })).toBe(`${HOME}/hermes-data`);
    expect(rootFor({ HERMES_HOME: "~" })).toBe(HOME);
    // A folder beside ~/.hermes whose name begins the same is not in it.
    expect(rootFor({ HERMES_HOME: `${HOME}/.hermes-other` })).toBe(`${HOME}/.hermes-other`);
    // A folder named profiles is not a profile.
    expect(rootFor({ HERMES_HOME: "/srv/profiles" })).toBe("/srv/profiles");
  });

  test("a relative HERMES_HOME is not taken, since Hermes Agent would take it from where it was started", () => {
    expect(rootFor({ HERMES_HOME: "hermes-data" })).toBe(ROOT);
    expect(rootFor({ HERMES_HOME: "./profiles/work" })).toBe(ROOT);
    expect(rootFor({ HERMES_HOME: "~user/hermes" })).toBe(ROOT);
  });
});

test("each profile's database: state.db in the root for the default one, else in profiles/<name>", () => {
  expect(DEFAULT_PROFILE).toBe("default");
  expect(asWritten(profileDatabase(ROOT, DEFAULT_PROFILE))).toBe(DEFAULT_DATABASE);
  expect(asWritten(profileDatabase(ROOT, PROFILE))).toBe(PROFILE_DATABASE);
});

describe("listProfiles", () => {
  test("lists each folder in profiles/ with a name Hermes Agent allows, in order, and looks at nothing in them", async () => {
    const files = memoryFiles();
    for (const name of ["work", "coder", "a", "0-team_two"])
      files.mkdir(`${ROOT}/profiles/${name}`);
    files.forget();
    expect(await listProfiles(files.io, ROOT)).toEqual(["0-team_two", "a", "coder", "work"]);
    // The listing, and a look at each name with lstat, and nothing more.
    expect(files.calls.map((call) => call.method)).toEqual([
      "readdir",
      "lstat",
      "lstat",
      "lstat",
      "lstat",
    ]);
    expect(files.opened()).toEqual([]);
  });

  test("leaves out a name Hermes Agent does not allow, the tombstones of deleted profiles, and the name the default one is shown by", async () => {
    const files = memoryFiles();
    for (const name of [
      "coder",
      ".deleted",
      "Coder",
      "-dash",
      "_under",
      "has space",
      "dotted.name",
      "a".repeat(65),
      DEFAULT_PROFILE,
    ]) {
      files.mkdir(`${ROOT}/profiles/${name}`);
    }
    files.forget();
    expect(await listProfiles(files.io, ROOT)).toEqual(["coder"]);
    // A name not allowed is not even looked at.
    expect(files.count("lstat")).toBe(1);
    expect(PROFILE_NAME.test("a".repeat(64))).toBe(true);
    expect(PROFILE_NAME.test("a".repeat(65))).toBe(false);
  });

  test("leaves out a file, a link, a pipe, and a name that went between the listing and the look", async () => {
    const files = memoryFiles();
    files.mkdir(`${ROOT}/profiles/coder`);
    files.write(`${ROOT}/profiles/notes`, "a file");
    files.special(`${ROOT}/profiles/linked`);
    files.mkdir(`${ROOT}/profiles/gone`);
    files.fail(`${ROOT}/profiles/gone`, "ENOENT");
    expect(await listProfiles(files.io, ROOT)).toEqual(["coder"]);
  });

  test(`takes at most ${MAX_PROFILES}, the first by name`, async () => {
    const files = memoryFiles();
    const names = Array.from({ length: 20 }, (_, index) => `p${String(index).padStart(2, "0")}`);
    // Two that are not folders come first, so the limit counts folders alone.
    files.write(`${ROOT}/profiles/a-file`, "x");
    files.special(`${ROOT}/profiles/a-link`);
    for (const name of [...names].reverse()) files.mkdir(`${ROOT}/profiles/${name}`);
    const listed = await listProfiles(files.io, ROOT);
    expect(MAX_PROFILES).toBe(16);
    expect(listed).toEqual(names.slice(0, 16));
  });

  test("is none when profiles/ is not there or cannot be listed", async () => {
    const files = memoryFiles();
    files.mkdir(ROOT);
    expect(await listProfiles(files.io, ROOT)).toEqual([]);
    files.mkdir(`${ROOT}/profiles/coder`);
    files.fail(`${ROOT}/profiles`);
    expect(await listProfiles(files.io, ROOT)).toEqual([]);
  });
});

describe("createProfileLister", () => {
  test("lists profiles/ at most once a minute, and again at once after forget", async () => {
    const files = memoryFiles();
    files.mkdir(`${ROOT}/profiles/coder`);
    const lister = createProfileLister({ io: files.io, root: ROOT });
    expect(PROFILES_LIST_MS).toBe(60_000);
    expect(await lister.list(NOW)).toEqual(["coder"]);
    files.mkdir(`${ROOT}/profiles/work`);
    expect(await lister.list(NOW + PROFILES_LIST_MS - 1)).toEqual(["coder"]);
    expect(files.count("readdir")).toBe(1);
    expect(await lister.list(NOW + PROFILES_LIST_MS)).toEqual(["coder", "work"]);
    expect(files.count("readdir")).toBe(2);

    files.remove(`${ROOT}/profiles/work`);
    lister.forget();
    expect(await lister.list(NOW + PROFILES_LIST_MS + 1)).toEqual(["coder"]);
    expect(files.count("readdir")).toBe(3);
  });

  test("a clock set back counts as time enough", async () => {
    const files = memoryFiles();
    files.mkdir(`${ROOT}/profiles/coder`);
    const lister = createProfileLister({ io: files.io, root: ROOT });
    await lister.list(NOW);
    await lister.list(NOW - 1);
    expect(files.count("readdir")).toBe(2);
  });

  test("a listing that failed is kept for the minute too, so a folder that cannot be read is not asked on every poll", async () => {
    const files = memoryFiles();
    files.mkdir(`${ROOT}/profiles/coder`);
    files.fail(`${ROOT}/profiles`);
    const lister = createProfileLister({ io: files.io, root: ROOT, everyMs: 1_000 });
    expect(await lister.list(NOW)).toEqual([]);
    files.heal(`${ROOT}/profiles`);
    expect(await lister.list(NOW + 999)).toEqual([]);
    expect(await lister.list(NOW + 1_000)).toEqual(["coder"]);
  });
});
