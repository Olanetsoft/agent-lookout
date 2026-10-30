import { describe, expect, test } from "vitest";

import {
  readSessionRows,
  type HermesRow,
  type LeaseRow,
} from "@collector/adapters/hermes-agent/sessionRows";
import {
  chainsOf,
  COMPRESSION_END,
  hermesAgentSession,
  isListed,
  profilePrefix,
  SOURCE_ID,
  surfaceOf,
  tipOf,
} from "@collector/adapters/hermes-agent/toSession";
import { MAX_NAME_LENGTH, sessionName } from "@core/text";
import {
  answerRow,
  DAY,
  FOLDER,
  HOUR,
  liveLease,
  MINUTE,
  NOW,
  seconds,
  sessionId,
  sqliteJson,
} from "@tests/fixtures/hermes-agent/hermesAgent";

const ROOT_ID = sessionId("a1");
const TIP_ID = sessionId("a2");

/** The rows the reader keeps from an answer of these rows. */
function rows(...fields: Record<string, unknown>[]): HermesRow[] {
  const answer = fields.map((each) => answerRow({ id: ROOT_ID, ...each } as { id: string }));
  const kept = readSessionRows(sqliteJson(answer)) ?? [];
  expect(kept).toHaveLength(fields.length);
  return kept;
}

/** A trust in the lease's expiry alone. */
const trustExpiry = () => null;

function session(chain: HermesRow[], fields: { profile?: string; now?: number } = {}) {
  return hermesAgentSession({
    profile: fields.profile ?? "default",
    chain,
    holderAlive: trustExpiry,
    now: fields.now ?? NOW,
  });
}

/**
 * A compressed conversation: its root, ended with a compression, and the row
 * it went on in. The root's own columns, `root_*`, are the same on both rows,
 * as the query joins them from the one root.
 */
function compressed(
  root: Record<string, unknown> = {},
  tip: Record<string, unknown> = {},
  both: Record<string, unknown> = {},
) {
  return rows(
    {
      root_id: ROOT_ID,
      id: ROOT_ID,
      started_at: seconds(NOW - 2 * HOUR),
      ended_at: seconds(NOW - HOUR),
      end_reason: COMPRESSION_END,
      last_activity_at: seconds(NOW - HOUR),
      last_message_at: seconds(NOW - HOUR),
      n_at: seconds(NOW - HOUR),
      root_started_at: seconds(NOW - 2 * HOUR),
      ...both,
      ...root,
    },
    {
      root_id: ROOT_ID,
      id: TIP_ID,
      title: "Rename the helper, again",
      cwd: `${FOLDER}/app`,
      started_at: seconds(NOW - HOUR),
      root_started_at: seconds(NOW - 2 * HOUR),
      ...both,
      ...tip,
    },
  );
}

describe("hermesAgentSession", () => {
  test("an idle conversation in a terminal, with its title, folder and times, and nothing it cannot have", () => {
    const shown = session(rows({}));
    expect(shown).toEqual({
      id: `hermes-agent:default/${ROOT_ID}`,
      source: "hermes-agent",
      surface: "terminal",
      name: "Rename the helper",
      cwd: FOLDER,
      project: "demo",
      status: "idle",
      startedAt: NOW - HOUR,
      statusSince: NOW - MINUTE,
      links: {},
      stale: false,
    });
    for (const absent of [
      "pid",
      "alive",
      "jump",
      "stop",
      "ask",
      "tokens",
      "lastWriteAt",
      "waitingReason",
      "waitingText",
      "machine",
    ]) {
      expect(shown, absent).not.toHaveProperty(absent);
    }
    expect(SOURCE_ID).toBe("hermes-agent");
  });

  test("names the profile in its id, so the same root in two profiles is two sessions", () => {
    expect(profilePrefix("coder")).toBe("hermes-agent:coder/");
    expect(session(rows({}), { profile: "coder" })?.id).toBe(`hermes-agent:coder/${ROOT_ID}`);
    expect(session(rows({}), { profile: "default" })?.id).toBe(`hermes-agent:default/${ROOT_ID}`);
  });

  test("a compressed conversation keeps its root's id and start, and takes its title, folder and status from the row it goes on in", () => {
    const chain = compressed({}, { ...liveLease() });
    const shown = hermesAgentSession({
      profile: "default",
      chain,
      holderAlive: () => true,
      now: NOW,
    });
    expect(shown).toMatchObject({
      id: `hermes-agent:default/${ROOT_ID}`,
      name: "Rename the helper, again",
      cwd: `${FOLDER}/app`,
      project: "app",
      status: "working",
      startedAt: NOW - 2 * HOUR,
      statusSince: NOW - 2 * MINUTE,
    });
    // In either order.
    expect(
      hermesAgentSession({
        profile: "default",
        chain: [...chain].reverse(),
        holderAlive: () => true,
        now: NOW,
      })?.status,
    ).toBe("working");
  });

  test("with no title of its own, the row it goes on in is named by the root's title, then the folder's name, then the id", () => {
    expect(session(compressed({}, { title: null }, { root_title: "Root title" }))?.name).toBe(
      "Root title",
    );
    expect(session(compressed({}, { title: "  " }, { root_title: "   " }))?.name).toBe("app");
    expect(session(compressed({}, { title: null, cwd: null }, { root_title: null }))).toMatchObject(
      { name: "demo", cwd: FOLDER },
    );
    expect(
      session(compressed({}, { title: null, cwd: null }, { root_title: null, root_cwd: null })),
    ).toMatchObject({ name: `hermes-agent:default/${ROOT_ID}`, cwd: null, project: null });
  });

  test("a title is cleaned and cut as every agent's name is", () => {
    const title = `  Rename\n\tthe\u202ehelper ${"x".repeat(300)}`;
    const shown = session(rows({ title }));
    expect(shown?.name).toBe(sessionName(title));
    expect(shown?.name).toMatch(/^Rename {2}the helper x+$/);
    expect(shown?.name).toHaveLength(MAX_NAME_LENGTH);
  });

  test("a wait carries why, and nothing of what is asked", () => {
    const waiting = rows({
      ...liveLease(),
      calls_at: seconds(NOW - MINUTE),
      open_calls: 1,
      last_activity_at: seconds(NOW - 30_000),
      approval_label: 1,
    });
    const shown = hermesAgentSession({
      profile: "default",
      chain: waiting,
      holderAlive: () => true,
      now: NOW,
    });
    expect(shown).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: NOW - MINUTE,
    });
    expect(shown).not.toHaveProperty("waitingText");
  });

  test("a label is the wait of the tip's newest call only while that call is the running turn's, unanswered, and the label is newer", () => {
    const show = (fields: Record<string, unknown>) =>
      hermesAgentSession({
        profile: "default",
        chain: rows({
          ...liveLease(),
          calls_at: seconds(NOW - MINUTE),
          open_calls: 1,
          last_activity_at: seconds(NOW - 30_000),
          approval_label: 1,
          ...fields,
        }),
        holderAlive: () => true,
        now: NOW,
      });
    expect(show({})?.status).toBe("needs-you");
    // The label was saved before the newest call, as when it outlasted an approval.
    expect(show({ last_activity_at: seconds(NOW - 90_000) })?.status).toBe("working");
    // Every call of that row has its result.
    expect(show({ open_calls: 0 })?.status).toBe("working");
    // The call was left by an earlier turn, before this turn took its lease.
    expect(
      show({ calls_at: seconds(NOW - 49 * MINUTE), last_activity_at: seconds(NOW - 48 * MINUTE) })
        ?.status,
    ).toBe("working");
    expect(
      show({ calls_at: seconds(NOW - 49 * MINUTE), approval_label: 0, open_questions: 1 })?.status,
    ).toBe("working");
  });

  test("asks whether the lease's process exists, with the lease, only when there is one, and believes it", () => {
    const asked: LeaseRow[] = [];
    const ask = (alive: boolean | null) => (lease: LeaseRow) => (asked.push(lease), alive);
    const leased = rows({ ...liveLease({ pidns: 4 }) });
    expect(
      hermesAgentSession({ profile: "default", chain: leased, holderAlive: ask(false), now: NOW })
        ?.status,
    ).toBe("idle");
    expect(asked).toEqual([
      { at: NOW - 2 * MINUTE, until: NOW + 5 * MINUTE, pid: 41_001, pidns: 4 },
    ]);
    expect(
      hermesAgentSession({ profile: "default", chain: leased, holderAlive: ask(null), now: NOW })
        ?.status,
    ).toBe("working");
    hermesAgentSession({ profile: "default", chain: rows({}), holderAlive: ask(true), now: NOW });
    expect(asked).toHaveLength(2);
  });

  test("a lease that runs out ends working on the next poll, though nothing was read again", () => {
    const leased = rows({ ...liveLease() });
    expect(session(leased)?.status).toBe("working");
    expect(session(leased, { now: NOW + 5 * MINUTE })).toMatchObject({
      status: "idle",
      statusSince: NOW - MINUTE,
    });
  });

  test("a status that cannot be read is unknown, with no time", () => {
    expect(session(rows({ n_role: "planner" }))).toMatchObject({
      status: "unknown",
      statusSince: null,
      stale: false,
    });
    expect(session(rows({ ended_at: "yesterday" }))?.status).toBe("unknown");
  });

  test("an idle conversation idle for a day is stale while something else of it was written since", () => {
    const shown = session(
      rows({
        n_at: seconds(NOW - DAY - MINUTE),
        last_activity_at: seconds(NOW - HOUR),
      }),
    );
    expect(shown).toMatchObject({ status: "idle", statusSince: NOW - DAY - MINUTE, stale: true });
  });

  test("is listed for 24 hours after anything of it was last written, then left out", () => {
    const at = (written: number) =>
      rows({
        started_at: seconds(written),
        root_started_at: seconds(written),
        last_activity_at: seconds(written),
        last_message_at: seconds(written),
        n_at: seconds(written),
        ended_at: seconds(written),
        end_reason: "cli_close",
      });
    expect(session(at(NOW - DAY + 1))?.status).toBe("finished");
    expect(session(at(NOW - DAY))).toBeNull();
    // A time ahead of a clock set back keeps it.
    expect(session(at(NOW + HOUR))).not.toBeNull();
    // Of a compressed conversation, the newest time of any of its rows counts.
    const chain = compressed(
      {},
      {
        started_at: seconds(NOW - 2 * DAY),
        last_activity_at: null,
        last_message_at: seconds(NOW - HOUR),
      },
    );
    expect(isListed(chain, NOW)).toBe(true);
    expect(session([])).toBeNull();
  });
});

describe("tipOf", () => {
  const each = (...fields: Record<string, unknown>[]) =>
    rows(...fields.map((field, index) => ({ id: sessionId(`b${index}`), ...field })));

  test("is a row that did not end with a compression, over one that did, however new", () => {
    const chain = each(
      { end_reason: COMPRESSION_END, ended_at: seconds(NOW), last_activity_at: seconds(NOW) },
      { last_activity_at: seconds(NOW - DAY / 2), last_message_at: null },
    );
    expect(tipOf(chain).id).toBe(sessionId("b1"));
  });

  test("an open row over an ended one, then the one written most recently, then the greater id", () => {
    expect(
      tipOf(
        each(
          { ended_at: seconds(NOW), end_reason: "cli_close", last_activity_at: seconds(NOW) },
          { last_activity_at: seconds(NOW - HOUR), last_message_at: seconds(NOW - HOUR) },
        ),
      ).id,
    ).toBe(sessionId("b1"));
    expect(
      tipOf(
        each(
          { last_activity_at: seconds(NOW - HOUR), last_message_at: seconds(NOW - HOUR) },
          { last_activity_at: seconds(NOW - MINUTE / 2), last_message_at: null },
        ),
      ).id,
    ).toBe(sessionId("b1"));
    expect(tipOf(each({}, {})).id).toBe(sessionId("b1"));
  });

  test("when every row ended with a compression, the one written most recently", () => {
    const ended = (at: number) => ({
      end_reason: COMPRESSION_END,
      ended_at: seconds(at),
      last_activity_at: seconds(at),
      last_message_at: seconds(at),
      started_at: seconds(at - HOUR),
    });
    expect(tipOf(each(ended(NOW - 2 * HOUR), ended(NOW - HOUR), ended(NOW - 3 * HOUR))).id).toBe(
      sessionId("b1"),
    );
  });
});

test("chainsOf folds the rows by their root, in the order they came", () => {
  const folded = chainsOf(
    rows(
      { root_id: ROOT_ID, id: TIP_ID },
      { root_id: sessionId("c1"), id: sessionId("c1") },
      { root_id: ROOT_ID, id: ROOT_ID },
    ),
  );
  expect([...folded.keys()]).toEqual([ROOT_ID, sessionId("c1")]);
  expect(folded.get(ROOT_ID)?.map((row) => row.id)).toEqual([TIP_ID, ROOT_ID]);
});

test("surfaceOf: the terminal, the desktop app, or not known, from the root's source", () => {
  const cases: [unknown, unknown, string][] = [
    ["cli", null, "terminal"],
    ["tui", null, "terminal"],
    ["local", "cli", "terminal"],
    ["local", "tui", "terminal"],
    ["desktop", null, "desktop"],
    ["local", "desktop", "desktop"],
    ["local", null, "unknown"],
    ["local", "acp", "unknown"],
    ["local", "gui", "unknown"],
    ["acp", null, "unknown"],
    ["telegram", null, "unknown"],
    ["api_server", null, "unknown"],
    ["webhook", null, "unknown"],
    ["cron", null, "unknown"],
    // What made a row that is not local is not asked.
    ["telegram", "cli", "unknown"],
    [undefined, undefined, "unknown"],
  ];
  for (const [source, created, surface] of cases) {
    expect(surfaceOf(source, created), `${String(source)} ${String(created)}`).toBe(surface);
  }
});
