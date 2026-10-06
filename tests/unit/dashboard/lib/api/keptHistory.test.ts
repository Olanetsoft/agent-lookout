import { afterEach, describe, expect, test, vi } from "vitest";

import type { HistoryKept } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import {
  clearFailureWords,
  formatBytes,
  formatDays,
  keptHistoryWords,
  requestClearHistory,
} from "@dashboard/lib/api/keptHistory";

afterEach(() => {
  setApiHost();
});

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

const ON_DISK: HistoryKept = {
  where: "disk",
  folder: "~/.agent-lookout/history",
  bytes: 1.4 * MB,
  maxBytes: 20 * MB,
  maxAgeMs: 8 * DAY,
  canClear: true,
  problem: null,
};

/** Today at this time on the clock. */
function today(hours: number, minutes: number): number {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

/** A host that answers every request with this status and body. */
function answering(status: number, body: unknown) {
  const host = vi.fn<ApiHost>(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  setApiHost(host);
  return host;
}

describe("sizes and days", () => {
  test("a size is said in KB under a megabyte and in MB with one decimal over it", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(1)).toBe("1 KB");
    expect(formatBytes(312 * 1024)).toBe("312 KB");
    expect(formatBytes(1.44 * MB)).toBe("1.4 MB");
    expect(formatBytes(20 * MB)).toBe("20 MB");
  });

  test("an age is said in whole days", () => {
    expect(formatDays(8 * DAY)).toBe("8 days");
    expect(formatDays(DAY)).toBe("1 day");
  });
});

describe("the card's words", () => {
  test("kept on disk, it says for how long, where, how much of the cap and since when", () => {
    const now = today(15, 0);
    const words = keptHistoryWords(ON_DISK, { at: today(9, 5), by: "started" }, now);
    expect(words.state).toBe("History is kept on this computer for 8 days.");
    expect(words.facts).toEqual({
      folder: "~/.agent-lookout/history",
      holds: "1.4 MB of 20 MB",
      since: "09:05",
    });
    expect(words.note).toBeNull();
    expect(words.explanation.join(" ")).toContain("8 days after the day ends");
    expect(words.explanation.join(" ")).toContain("more than 20 MB");
    expect(words.explanation[0]).toBe(
      "The Events log and the counts behind the charts are written to this folder every few seconds, so they are still there when Agent Lookout starts again. It holds no prompt and nothing a waiting session is asking.",
    );
  });

  test("since a day before today, it gives the day", () => {
    const now = today(15, 0);
    const words = keptHistoryWords(ON_DISK, { at: now - 3 * DAY, by: "trimmed" }, now);
    expect(words.facts?.since).toMatch(/^15:00 on \w+ \d+/);
  });

  test("while this copy does not write the files, it keeps history in memory for now, and the note says why", () => {
    const problem =
      "Another copy of Agent Lookout on this computer is writing the history. This one keeps what it sees in memory, and takes over when that one stops.";
    const words = keptHistoryWords(
      { ...ON_DISK, canClear: false, problem },
      { at: today(9, 5), by: "started" },
      today(15, 0),
    );
    expect(words.state).toBe("History is kept in memory for now.");
    expect(words.note).toEqual({ title: "This copy is not writing history", detail: problem });
    // What is written is said of the copy that writes it, not of this one.
    expect(words.explanation[0]).toMatch(
      /^The copy that writes the history writes the Events log and the counts behind the charts to this folder every few seconds/,
    );
  });

  test("in memory only, it says so, names the setting, and gives no facts", () => {
    const words = keptHistoryWords(
      { ...ON_DISK, where: "memory", folder: null, bytes: null, canClear: false },
      { at: today(9, 5), by: "started" },
      today(15, 0),
    );
    expect(words.state).toBe("History is kept in memory only.");
    expect(words.facts).toBeNull();
    expect(words.explanation.join(" ")).toContain("AGENT_LOOKOUT_HISTORY is set to off");
  });

  test("a size that is not known is a dash", () => {
    const words = keptHistoryWords(
      { ...ON_DISK, bytes: null },
      { at: today(9, 5), by: "started" },
      today(15, 0),
    );
    expect(words.facts?.holds).toBe("–");
  });
});

describe("clearing", () => {
  test("a press is one POST through the app's own seam, with its action and an empty body", async () => {
    const host = answering(200, { ok: true, clearedAt: 1_791_204_000_000 });
    expect(await requestClearHistory()).toEqual({ ok: true, at: 1_791_204_000_000 });
    const [path, init] = host.mock.calls[0] ?? [];
    expect(path).toBe("/api/history/clear");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Agent-Lookout-Action")).toBe("clear-history");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a refusal comes back with its reason and the app's sentence", async () => {
    answering(409, { reason: "not-writing", error: "Another copy keeps it." });
    const outcome = await requestClearHistory();
    expect(outcome).toEqual({ ok: false, reason: "not-writing", error: "Another copy keeps it." });
    if (!outcome.ok) expect(clearFailureWords(outcome)).toBe("Another copy keeps it.");
  });

  test("no answer, or one that is not data, says to try again", async () => {
    setApiHost(async () => {
      throw new TypeError("Failed to fetch");
    });
    const silent = await requestClearHistory();
    expect(silent).toEqual({ ok: false, reason: "no-answer", error: null });
    if (!silent.ok) {
      expect(clearFailureWords(silent)).toBe(
        "Agent Lookout did not answer. Try again in a moment.",
      );
    }

    answering(500, "<html>");
    const garbled = await requestClearHistory();
    expect(garbled).toMatchObject({ ok: false, reason: "no-answer" });

    answering(500, { reason: "exploded", error: "x".repeat(400) });
    const strange = await requestClearHistory();
    expect(strange).toEqual({ ok: false, reason: "failed", error: null });
    if (!strange.ok) {
      expect(clearFailureWords(strange)).toBe(
        "Agent Lookout could not clear it. Try again in a moment.",
      );
    }
  });
});
