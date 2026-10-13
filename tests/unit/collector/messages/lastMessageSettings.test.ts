import { describe, expect, test } from "vitest";

import {
  LAST_MESSAGE_ENV,
  lastMessageOff,
  lastMessageStoppedBy,
} from "@collector/messages/lastMessageSettings";

describe("AGENT_LOOKOUT_LAST_MESSAGE", () => {
  test("is on unless it is off, in any case and with spaces around it", () => {
    expect(LAST_MESSAGE_ENV).toBe("AGENT_LOOKOUT_LAST_MESSAGE");
    expect(lastMessageOff({})).toBe(false);
    expect(lastMessageOff({ AGENT_LOOKOUT_LAST_MESSAGE: "" })).toBe(false);
    expect(lastMessageOff({ AGENT_LOOKOUT_LAST_MESSAGE: "on" })).toBe(false);
    expect(lastMessageOff({ AGENT_LOOKOUT_LAST_MESSAGE: "no" })).toBe(false);
    expect(lastMessageOff({ AGENT_LOOKOUT_LAST_MESSAGE: "off" })).toBe(true);
    expect(lastMessageOff({ AGENT_LOOKOUT_LAST_MESSAGE: " OFF " })).toBe(true);
  });
});

describe("the setting that stops last messages", () => {
  test("is none by default, and either setting set to off otherwise", () => {
    expect(lastMessageStoppedBy({})).toBeNull();
    expect(lastMessageStoppedBy({ AGENT_LOOKOUT_LAST_MESSAGE: "on" })).toBeNull();
    expect(lastMessageStoppedBy({ AGENT_LOOKOUT_LAST_MESSAGE: " Off " })).toBe(
      "AGENT_LOOKOUT_LAST_MESSAGE",
    );
    expect(lastMessageStoppedBy({ AGENT_LOOKOUT_WAITING_TEXT: "off" })).toBe(
      "AGENT_LOOKOUT_WAITING_TEXT",
    );
  });

  test("is AGENT_LOOKOUT_WAITING_TEXT when both are off, since it stops every transcript being read", () => {
    expect(
      lastMessageStoppedBy({
        AGENT_LOOKOUT_LAST_MESSAGE: "off",
        AGENT_LOOKOUT_WAITING_TEXT: "off",
      }),
    ).toBe("AGENT_LOOKOUT_WAITING_TEXT");
  });
});
