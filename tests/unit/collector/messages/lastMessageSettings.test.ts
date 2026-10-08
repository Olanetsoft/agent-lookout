import { describe, expect, test } from "vitest";

import { LAST_MESSAGE_ENV, lastMessageOff } from "@collector/messages/lastMessageSettings";

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
