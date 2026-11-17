import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createPiAdapter,
  createPiFamilyAdapter,
  NEWER_FORMAT_NOTE,
  PI_CAPABILITIES,
  PI_HOME_ENV,
  PI_PROFILE,
  piSessionsDirFor,
  STATUS_NOTE,
  UNCHECKED_NOTE,
} from "@collector/adapters/pi/index";
import { PI_PROGRAMS } from "@collector/adapters/pi/processes";
import { agentDirFor, sessionsDirFor, type PiProfile } from "@collector/adapters/pi/profile";
import { HOME, nameLine, NOW, SESSION_ID, sessionPath, sessionText } from "@tests/fixtures/pi/pi";
import { memoryFiles, standInProcesses } from "@tests/support/adapters/pi/piAdapter";
import { asWritten } from "@tests/support/paths";

/**
 * A profile of another agent kept as Pi keeps its sessions, with no variable
 * for its agent folder and no names read. It keeps Pi's source id, so this
 * file needs no other: the Kimchi adapter's tests show a source of its own.
 */
const OTHER: PiProfile = {
  ...PI_PROFILE,
  label: "Other",
  program: "other",
  programs: new Set(["other"]),
  homeEnv: "AGENT_LOOKOUT_OTHER_HOME",
  sessionsEnv: "OTHER_SESSIONS",
  agentDirEnv: undefined,
  agentDir: [".config", "other"],
  readsNames: false,
  hiddenMarkers: [],
  notes: { status: "Status words.", unchecked: "Unchecked words.", newerFormat: "Newer words." },
};

describe("Pi's profile", () => {
  test("is Pi's names, folders, programs and words, as the adapter has always had them", () => {
    expect(PI_PROFILE).toMatchObject({
      sourceId: "pi",
      label: "Pi",
      program: "pi",
      homeEnv: PI_HOME_ENV,
      sessionsEnv: "PI_CODING_AGENT_SESSION_DIR",
      agentDirEnv: "PI_CODING_AGENT_DIR",
      agentDir: [".pi", "agent"],
      readsNames: true,
      hiddenMarkers: [],
    });
    expect(PI_PROFILE.programs).toBe(PI_PROGRAMS);
    expect(PI_PROFILE.capabilities).toBe(PI_CAPABILITIES);
    expect(PI_PROFILE.notes).toEqual({
      status: STATUS_NOTE,
      unchecked: UNCHECKED_NOTE,
      newerFormat: NEWER_FORMAT_NOTE,
    });
  });

  test("gives the folder Pi's own function gives, for every setting", () => {
    const envs = [
      {},
      { PI_CODING_AGENT_DIR: path.resolve("/pi-agent") },
      { PI_CODING_AGENT_SESSION_DIR: "~/pi" },
      { AGENT_LOOKOUT_PI_HOME: "/tmp/pi" },
    ];
    for (const env of envs) {
      expect(sessionsDirFor(PI_PROFILE, env, HOME)).toBe(piSessionsDirFor(env, HOME));
    }
  });

  test("makes the adapter Pi's own function makes", async () => {
    const files = memoryFiles();
    files.write(sessionPath(SESSION_ID), sessionText(SESSION_ID) + nameLine("Release notes"));
    const options = {
      env: {},
      homeDir: HOME,
      now: () => NOW,
      io: files.io,
      platform: "darwin" as const,
    };
    const own = await createPiAdapter({ ...options, processes: standInProcesses() }).poll();
    const family = await createPiFamilyAdapter(PI_PROFILE, {
      ...options,
      processes: standInProcesses(),
    }).poll();
    expect(family).toEqual(own);
    expect(own.sessions[0].name).toBe("Release notes");
  });
});

describe("another profile", () => {
  test("has no agent folder variable to follow, so the folder is its own in the home folder", () => {
    expect(asWritten(sessionsDirFor(OTHER, {}, HOME))).toBe(`${HOME}/.config/other/sessions`);
    expect(asWritten(sessionsDirFor(OTHER, { PI_CODING_AGENT_DIR: "/pi-agent" }, HOME))).toBe(
      `${HOME}/.config/other/sessions`,
    );
    expect(asWritten(sessionsDirFor(OTHER, { OTHER_SESSIONS: "~/elsewhere" }, HOME))).toBe(
      `${HOME}/elsewhere`,
    );
    expect(asWritten(sessionsDirFor(OTHER, { AGENT_LOOKOUT_OTHER_HOME: "/tmp/other" }, HOME))).toBe(
      "/tmp/other/sessions",
    );
  });

  test("is named in each sentence of its card, and takes the folder's name when it reads none", async () => {
    const files = memoryFiles();
    const file = sessionPath(SESSION_ID, `${HOME}/.config/other/sessions/--demo-project--`);
    files.write(file, sessionText(SESSION_ID) + nameLine("Release notes"));
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = createPiFamilyAdapter(OTHER, {
      env: {},
      homeDir: HOME,
      now: () => NOW,
      io: files.io,
      platform: "linux",
      processes,
    });
    expect(adapter.label).toBe("Other");
    const { health, sessions } = await adapter.poll();
    expect(health.detail).toBe(
      "Sessions are read from the files Other keeps in ~/.config/other/sessions. Status words. Unchecked words. No other program runs, so each session shows as finished.",
    );
    expect(sessions.map(({ id, name }) => [id, name])).toEqual([
      [`pi:${SESSION_ID}`, "demo-project"],
    ]);
  });
});

describe("what a profile may add for Prime Agent", () => {
  test("an older name of the sessions variable is read after it, and only when the profile names one", () => {
    const older = { ...OTHER, legacySessionsEnv: "OTHER_OLD_SESSIONS" };
    const at = (profile: PiProfile, env: NodeJS.ProcessEnv) =>
      asWritten(sessionsDirFor(profile, env, HOME));
    expect(at(older, { OTHER_OLD_SESSIONS: "/old" })).toBe("/old");
    expect(at(older, { OTHER_SESSIONS: "/new", OTHER_OLD_SESSIONS: "/old" })).toBe("/new");
    expect(at(older, { OTHER_OLD_SESSIONS: "relative" })).toBe(`${HOME}/.config/other/sessions`);
    expect(at(OTHER, { OTHER_OLD_SESSIONS: "/old" })).toBe(`${HOME}/.config/other/sessions`);
  });

  test("the agent folder is its home variable, else its own variable, else its folder, whatever names the sessions", () => {
    const named = { ...OTHER, agentDirEnv: "OTHER_AGENT_DIR" };
    const agent = (profile: PiProfile, env: NodeJS.ProcessEnv) =>
      asWritten(agentDirFor(profile, env, HOME));
    expect(agent(named, {})).toBe(`${HOME}/.config/other`);
    expect(agent(named, { OTHER_AGENT_DIR: "~/agent", OTHER_SESSIONS: "/sessions" })).toBe(
      `${HOME}/agent`,
    );
    expect(agent(named, { AGENT_LOOKOUT_OTHER_HOME: "/lookout", OTHER_AGENT_DIR: "/agent" })).toBe(
      "/lookout",
    );
    expect(agent(OTHER, { OTHER_AGENT_DIR: "/agent" })).toBe(`${HOME}/.config/other`);
  });
});
