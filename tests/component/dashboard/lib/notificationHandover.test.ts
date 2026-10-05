import { expect, onTestFinished, test, vi } from "vitest";

import {
  NOTIFICATION_HANDOVER_CHANNEL,
  openNotificationHandover,
  type NotificationHandover,
} from "@dashboard/lib/notificationHandover";

const FIRST = "claude-code:00000000-0000-4000-8000-000000000001";
const SECOND = "claude-code:00000000-0000-4000-8000-000000000002";

/**
 * Another page at this address, as far as the channel can tell: a channel of
 * the same name, which hears what a page says and can say something itself.
 * One made after another hears each message after it, so a message heard here
 * has already been given to every channel that was made before.
 */
function otherPage() {
  const channel = new BroadcastChannel(NOTIFICATION_HANDOVER_CHANNEL);
  const heard: unknown[] = [];
  channel.addEventListener("message", (event) => heard.push(event.data));
  onTestFinished(() => channel.close());
  return { heard, say: (message: unknown) => channel.postMessage(message) };
}

/** A page listening for what is handed over, and what it has been given. */
function listeningPage() {
  const given: string[][] = [];
  const handover = openNotificationHandover((sessionIds) => given.push(sessionIds));
  onTestFinished(() => handover.close());
  return { handover, given };
}

test("the channel is named for the app, so only pages of Agent Lookout at this address share it", () => {
  expect(NOTIFICATION_HANDOVER_CHANNEL).toBe("agent-lookout-notifications");
});

test("a page that hands over tells the other pages the session ids and nothing else, and does not hear itself", async () => {
  const { handover, given } = listeningPage();
  const other = otherPage();

  handover.handOver([FIRST, SECOND]);

  await vi.waitFor(() => expect(other.heard).toHaveLength(1));
  expect(other.heard[0]).toEqual({ handedOver: [FIRST, SECOND] });
  expect(given).toEqual([]);
});

test("what another page hands over is given to this one", async () => {
  const { given } = listeningPage();
  const leaving = otherPage();
  const witness = otherPage();

  leaving.say({ handedOver: [FIRST] });
  leaving.say({ handedOver: [SECOND, FIRST] });

  await vi.waitFor(() => expect(witness.heard).toHaveLength(2));
  expect(given).toEqual([[FIRST], [SECOND, FIRST]]);
});

test("two pages that listen hear each other, and each is told once", async () => {
  const first = listeningPage();
  const second = listeningPage();
  const witness = otherPage();

  first.handover.handOver([FIRST]);
  second.handover.handOver([SECOND]);

  await vi.waitFor(() => expect(witness.heard).toHaveLength(2));
  expect(first.given).toEqual([[SECOND]]);
  expect(second.given).toEqual([[FIRST]]);
});

test("handing over nothing says nothing", async () => {
  const { handover } = listeningPage();
  const other = otherPage();

  handover.handOver([]);
  handover.handOver([FIRST]);

  await vi.waitFor(() => expect(other.heard).toHaveLength(1));
  expect(other.heard).toEqual([{ handedOver: [FIRST] }]);
});

test("a message that is not a handover is passed over, and only the session ids in one are kept", async () => {
  const { given } = listeningPage();
  const other = otherPage();
  const witness = otherPage();

  const messages: unknown[] = [
    "hello",
    null,
    42,
    [FIRST],
    {},
    { handedOver: FIRST },
    { handedOver: [] },
    { handedOver: [7, null, {}] },
    { handedOver: [7, FIRST, null] },
  ];
  for (const message of messages) other.say(message);

  await vi.waitFor(() => expect(witness.heard).toHaveLength(messages.length));
  expect(given).toEqual([[FIRST]]);
});

test("what is handed over just before the channel is let go still arrives, and nothing is said or heard after", async () => {
  const { handover, given } = listeningPage();
  const other = otherPage();
  const witness = otherPage();

  // As a page does when it leaves: it says so, and is gone.
  handover.handOver([FIRST]);
  handover.close();
  await vi.waitFor(() => expect(other.heard).toHaveLength(1));
  expect(other.heard).toEqual([{ handedOver: [FIRST] }]);

  expect(() => handover.handOver([SECOND])).not.toThrow();
  expect(() => handover.close()).not.toThrow();
  other.say({ handedOver: [SECOND] });
  await vi.waitFor(() => expect(witness.heard).toHaveLength(2));
  // Only the other page's own words came after: the second handover was never said.
  expect(witness.heard).toEqual([{ handedOver: [FIRST] }, { handedOver: [SECOND] }]);
  expect(given).toEqual([]);
});

test.each(["missing", "refusing"] as const)(
  "where the browser's BroadcastChannel is %s, nothing is said and nothing throws",
  (kind) => {
    const real = Object.getOwnPropertyDescriptor(window, "BroadcastChannel");
    onTestFinished(() => {
      if (real) Object.defineProperty(window, "BroadcastChannel", real);
    });
    if (kind === "missing") {
      Reflect.deleteProperty(window, "BroadcastChannel");
      expect(typeof BroadcastChannel).toBe("undefined");
    } else {
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        writable: true,
        value: class {
          constructor() {
            throw new DOMException("Refused.", "SecurityError");
          }
        },
      });
    }

    const given: string[][] = [];
    let handover: NotificationHandover | undefined;
    expect(() => {
      handover = openNotificationHandover((sessionIds) => given.push(sessionIds));
    }).not.toThrow();
    expect(() => handover?.handOver([FIRST])).not.toThrow();
    expect(() => handover?.close()).not.toThrow();
    expect(given).toEqual([]);
  },
);
