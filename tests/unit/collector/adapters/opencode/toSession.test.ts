import { describe, expect, test } from "vitest";

import { readSessionRows, type SessionRow } from "@collector/adapters/opencode/sessionRows";
import { lastActivity, opencodeSession } from "@collector/adapters/opencode/toSession";
import { STEP_GAP_MS } from "@core/mapping/opencode/opencodeMapping";
import {
  answerRow,
  DAY,
  FOLDER,
  HOUR,
  MINUTE,
  NOW,
  sessionId,
  sqliteJson,
} from "@tests/fixtures/opencode/opencode";

const A = sessionId("a1");

/** A row as the reader keeps it, from a row of the answer with these fields. */
function row(fields: Record<string, unknown> = {}): SessionRow {
  const [read] = readSessionRows(sqliteJson([answerRow({ id: A, ...fields })])) ?? [];
  if (read === undefined) throw new Error("The row was dropped.");
  return read;
}

describe("opencodeSession", () => {
  test("an idle session, with its title, folder and times, and nothing it cannot have", () => {
    const session = opencodeSession({ row: row(), open: true, now: NOW });
    expect(session).toEqual({
      id: `opencode:${A}`,
      source: "opencode",
      surface: "unknown",
      name: "Rename the helper",
      cwd: FOLDER,
      project: "demo",
      status: "idle",
      startedAt: NOW - HOUR,
      statusSince: NOW - MINUTE,
      links: {},
      stale: false,
    });
    for (const absent of ["pid", "alive", "jump", "stop", "ask", "tokens", "lastWriteAt"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
  });

  test("a session has the token counts of its newest reply that ended, and none when they could not be right", () => {
    const counted = row({
      r_input: 200,
      r_output: 100,
      r_reasoning: 20,
      r_cache_read: 1800,
      r_cache_write: 400,
      r_total: 2520,
    });
    expect(opencodeSession({ row: counted, open: true, now: NOW })?.tokens).toEqual({
      input: 2400,
      cached: 1800,
      output: 120,
    });
    // Closed, a session keeps them, as every field it was read with.
    expect(opencodeSession({ row: counted, open: false, now: NOW })?.tokens).toEqual({
      input: 2400,
      cached: 1800,
      output: 120,
    });
    const wrong = row({
      r_input: 200,
      r_output: -1,
      r_reasoning: 0,
      r_cache_read: 0,
      r_cache_write: 0,
    });
    expect(opencodeSession({ row: wrong, open: true, now: NOW })).not.toHaveProperty("tokens");
  });

  test("a session OpenCode works on is working since the person last wrote", () => {
    const session = opencodeSession({
      row: row({ m_completed: null, m_finish: null }),
      open: true,
      now: NOW,
    });
    expect(session).toMatchObject({ status: "working", statusSince: NOW - 3 * MINUTE });
  });

  /** A session whose step under way waits for the person. */
  const asking = () =>
    row({ m_completed: null, m_finish: null, m_tools: 1, m_asked_at: NOW - 2 * MINUTE });

  test("a session that asks the person needs them since the call began, with the reason and nothing it asks", () => {
    const session = opencodeSession({ row: asking(), open: true, now: NOW });
    expect(session).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - 2 * MINUTE,
      stale: false,
    });
    expect(session).not.toHaveProperty("waitingText");
  });

  test("a wait whose time could not be right still needs the person, with no time", () => {
    const session = opencodeSession({
      row: row({ m_completed: null, m_finish: null, m_tools: 1, m_asked_at: 12 }),
      open: true,
      now: NOW,
    });
    expect(session).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: null,
    });
  });

  test("a session goes back to working once it is answered, with no reason left", () => {
    const answered = row({ m_completed: null, m_finish: null, m_tools: 1 });
    const session = opencodeSession({ row: answered, open: true, now: NOW });
    expect(session).toMatchObject({ status: "working", statusSince: NOW - 3 * MINUTE });
    expect(session).not.toHaveProperty("waitingReason");
  });

  test("a session that ends while it waits is finished, with no reason", () => {
    const session = opencodeSession({ row: asking(), open: false, now: NOW });
    expect(session).toMatchObject({ status: "finished", statusSince: NOW - MINUTE });
    expect(session).not.toHaveProperty("waitingReason");
  });

  test("a wait that began before ps last showed no OpenCode is no wait: the step is one that was cut off", () => {
    const left = { row: asking(), open: true, now: NOW };
    const session = opencodeSession({ ...left, noOpencodeAt: NOW - MINUTE });
    expect(session).toMatchObject({ status: "working", statusSince: NOW - 3 * MINUTE });
    expect(session).not.toHaveProperty("waitingReason");
    expect(opencodeSession({ ...left, open: false, noOpencodeAt: NOW - MINUTE })?.status).toBe(
      "finished",
    );
  });

  test("a wait that began once ps had shown no OpenCode, or with none shown, stands", () => {
    const asked = { row: asking(), open: true, now: NOW };
    for (const noOpencodeAt of [NOW - 2 * MINUTE, NOW - 3 * MINUTE, null, undefined]) {
      expect(opencodeSession({ ...asked, noOpencodeAt })?.status, `${noOpencodeAt}`).toBe(
        "needs-you",
      );
    }
  });

  test("a step that asked for tools is working for a moment, then idle", () => {
    const ended = row({ m_finish: "tool-calls", m_completed: NOW - 2_000 });
    expect(opencodeSession({ row: ended, open: true, now: NOW })?.status).toBe("working");
    expect(opencodeSession({ row: ended, open: true, now: NOW + STEP_GAP_MS })?.status).toBe(
      "idle",
    );
  });

  test("with the database closed, a session is finished, and one that failed stays failed", () => {
    expect(opencodeSession({ row: row(), open: false, now: NOW })).toMatchObject({
      status: "finished",
      statusSince: NOW - MINUTE,
      stale: false,
    });
    expect(
      opencodeSession({ row: row({ m_error: "APIError" }), open: false, now: NOW })?.status,
    ).toBe("failed");
  });

  test("an unknown session has no status time", () => {
    const session = opencodeSession({ row: row({ m_role: "system" }), open: true, now: NOW });
    expect(session).toMatchObject({ status: "unknown", statusSince: null, stale: false });
  });

  test("a title that is still OpenCode's placeholder gives way to the folder's name, then the id", () => {
    const placeholder = "New session - 2026-10-01T11:00:00.000Z";
    expect(opencodeSession({ row: row({ title: placeholder }), open: true, now: NOW })?.name).toBe(
      "demo",
    );
    expect(opencodeSession({ row: row({ title: "   " }), open: true, now: NOW })?.name).toBe(
      "demo",
    );
    const nowhere = row({ title: placeholder, directory: "" });
    const session = opencodeSession({ row: nowhere, open: true, now: NOW });
    expect(session).toMatchObject({ name: `opencode:${A}`, cwd: null, project: null });
  });

  test("a title is cleaned and cut as every other agent's name is", () => {
    const session = opencodeSession({
      row: row({ title: `Fix\u0007 the ${"long ".repeat(100)}name` }),
      open: true,
      now: NOW,
    });
    expect(session?.name.startsWith("Fix  the long")).toBe(true);
    expect(session?.name.length).toBeLessThanOrEqual(200);
  });

  test("a session nothing of which was written in the last 24 hours is not listed", () => {
    const old = row({
      time_updated: NOW - DAY,
      m_updated: NOW - DAY - HOUR,
      p_updated: NOW - DAY - MINUTE,
    });
    expect(opencodeSession({ row: old, open: true, now: NOW })).toBeNull();
    // A part written a moment ago keeps it.
    const lately = row({ time_updated: NOW - DAY, m_updated: NOW - DAY, p_updated: NOW - MINUTE });
    expect(opencodeSession({ row: lately, open: true, now: NOW })).not.toBeNull();
    // With no time that could be right, it is not listed either.
    const none = row({ time_updated: null, m_updated: null, p_updated: null });
    expect(opencodeSession({ row: none, open: true, now: NOW })).toBeNull();
  });

  test("a question unanswered for a day leaves the list as any session does, though OpenCode still asks, since it writes nothing while it asks", () => {
    const written = {
      m_completed: null,
      m_finish: null,
      m_tools: 1,
      m_asked_at: NOW - DAY,
      time_updated: NOW - DAY,
      m_updated: NOW - DAY,
      p_updated: NOW - DAY,
    };
    expect(opencodeSession({ row: row(written), open: true, now: NOW })).toBeNull();
    expect(opencodeSession({ row: row(written), open: true, now: NOW - MINUTE })?.status).toBe(
      "needs-you",
    );
  });

  test("a clock set back never hides a session, even one whose every time is ahead of it", () => {
    const ahead = NOW + 2 * MINUTE;
    const working = row({
      time_created: ahead,
      time_updated: ahead,
      m_created: ahead,
      m_updated: ahead,
      m_completed: null,
      m_finish: null,
      p_updated: ahead,
      u_created: ahead,
    });
    // Times ahead of the clock are not believed, so it has none to show.
    expect(opencodeSession({ row: working, open: true, now: NOW })).toMatchObject({
      status: "working",
      startedAt: null,
      statusSince: null,
    });
  });

  test("an idle session is stale once its last step ended a day ago", () => {
    const quiet = row({ m_completed: NOW - DAY, time_updated: NOW - 2 * MINUTE });
    expect(opencodeSession({ row: quiet, open: true, now: NOW })).toMatchObject({
      status: "idle",
      statusSince: NOW - DAY,
      stale: true,
    });
  });
});

describe("lastActivity", () => {
  test("is the newest of the session's row, its newest message and that message's parts", () => {
    expect(
      lastActivity(
        row({
          time_updated: NOW - 5 * MINUTE,
          m_updated: NOW - 4 * MINUTE,
          p_updated: NOW - 3 * MINUTE,
        }),
        NOW,
      ),
    ).toBe(NOW - 3 * MINUTE);
    expect(lastActivity(row({ m_id: null, time_updated: NOW - 5 * MINUTE }), NOW)).toBe(
      NOW - 5 * MINUTE,
    );
    // A time further ahead than the clock allows is left out.
    expect(lastActivity(row({ time_updated: NOW - MINUTE, p_updated: NOW + DAY }), NOW)).toBe(
      NOW - MINUTE,
    );
  });
});
