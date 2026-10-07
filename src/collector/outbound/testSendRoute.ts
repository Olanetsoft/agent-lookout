import type { IncomingMessage } from "node:http";

import {
  PHONE_CHANNELS,
  PHONE_TEST_ACTION,
  SENDS_PER_HOUR,
  type PhoneChannel,
  type PhoneTestFailure,
  type PhoneTestRefusal,
  type PhoneTestResponse,
} from "../../core/api.ts";
import type { ActionLimiter } from "../actions/stopSession.ts";
import { actionRefusalFor, readRequestBody, refusal, type ApiAnswer } from "../handler.ts";
import type { TestResult } from "./outboundChannel.ts";

/** The most a request's body may hold. It holds `{"channel":"pushover"}`. */
export const MAX_TEST_BODY_BYTES = 64;

/** A channel that can send its test push: ntfy's or Pushover's notifications. */
export interface PhoneTester {
  test(): Promise<TestResult>;
}

export interface TestSendRouteOptions {
  /** Each channel's notifications, or null while it is not set up. */
  channels: Readonly<Record<PhoneChannel, PhoneTester | null>>;
  /** One test at a time, and a second between the start of one and the next. */
  limiter: ActionLimiter;
  now?: () => number;
}

/** What each channel is called in a sentence, and the setting that turns it on. */
const NAMED: Record<PhoneChannel, { name: string; setting: string }> = {
  ntfy: { name: "ntfy", setting: "AGENT_LOOKOUT_NTFY_URL" },
  pushover: {
    name: "Pushover",
    setting: "AGENT_LOOKOUT_PUSHOVER_TOKEN and AGENT_LOOKOUT_PUSHOVER_USER",
  },
};

/** The channel a body names, when it is exactly `{"channel": "ntfy"}` or `{"channel": "pushover"}`. */
export function channelIn(body: string): PhoneChannel | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "channel") return null;
  const { channel } = value as { channel: unknown };
  return PHONE_CHANNELS.find((known) => known === channel) ?? null;
}

/** "the ntfy server did not answer in time" as a sentence. */
function asSentence(reason: string): string {
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

const failed = (
  status: number,
  reason: PhoneTestFailure,
  error: string,
  more: { limitedUntil?: number; retryAfter?: number } = {},
): ApiAnswer => ({
  status,
  body: {
    error,
    reason,
    ...(more.limitedUntil !== undefined && { limitedUntil: more.limitedUntil }),
  } satisfies PhoneTestRefusal,
  ...(more.retryAfter !== undefined && {
    headers: { "Retry-After": String(more.retryAfter) },
  }),
});

/**
 * Answers `POST /api/phone/test`: sends one test push through ntfy or
 * Pushover, when the person presses Send a test on its card in Settings. The
 * push says only that it is a test from Agent Lookout, and nothing of any
 * session.
 *
 * It is one of the collector's routes that act, so it makes the checks every
 * one makes, `actionRefusalFor` in `handler.ts`, with `phone-test` as the
 * action, and its body must be exactly `{"channel": "ntfy"}` or
 * `{"channel": "pushover"}`. Nothing in a request reaches the push or names
 * where it goes: that is the channel's own setting. A test goes during quiet
 * hours too, since the person asked, counts against the channel's 20 an hour,
 * and is not tried while those are spent. One goes at a time, a second apart.
 */
export function createTestSendRoute(options: TestSendRouteOptions) {
  const { channels, limiter } = options;
  const now = options.now ?? Date.now;

  return async function answerTest(req: IncomingMessage): Promise<ApiAnswer> {
    const refused = actionRefusalFor(req, PHONE_TEST_ACTION, MAX_TEST_BODY_BYTES);
    if (refused) {
      req.resume();
      return refused;
    }

    const body = await readRequestBody(req, MAX_TEST_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refusal(413, `The body must be no more than ${MAX_TEST_BODY_BYTES} bytes.`)
        : refusal(400, "The body could not be read.");
    }
    const channel = channelIn(body.text);
    if (channel === null) {
      return refusal(400, 'The body must be {"channel": "ntfy"} or {"channel": "pushover"}.');
    }

    const { name, setting } = NAMED[channel];
    const tester = channels[channel];
    if (tester === null) {
      return failed(
        409,
        "off",
        `${name} is not set up. Set ${setting} and start Agent Lookout again.`,
      );
    }
    if (!limiter.begin()) {
      return failed(429, "too-soon", "One test is sent a second. Try again in a moment.", {
        retryAfter: 1,
      });
    }
    try {
      const result = await tester.test();
      if (!result.tried) {
        return failed(
          429,
          "limited",
          `${SENDS_PER_HOUR} ${name} pushes were tried in the last hour, the most it tries.`,
          {
            limitedUntil: result.limitedUntil,
            retryAfter: Math.max(1, Math.ceil((result.limitedUntil - now()) / 1_000)),
          },
        );
      }
      if (!result.outcome.sent) {
        // The outcome's reason is one of the channel's own, chosen from a
        // status or an error's code, and never holds a secret.
        return failed(502, "not-sent", asSentence(result.outcome.reason));
      }
      return {
        status: 200,
        body: { ok: true, channel, sentAt: result.at } satisfies PhoneTestResponse,
      };
    } finally {
      limiter.end();
    }
  };
}
