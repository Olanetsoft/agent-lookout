import { isWaitKind, type PhoneMessage } from "../outbound/phoneMessage.ts";

/**
 * What one push to Pushover is, as the JSON its messages API takes: the
 * application's token and the user key, which say who sends and to whom, then
 * the push's title and lines as `phoneMessage.ts` writes them, and a
 * priority. Nothing else: no address to open, no sound, no device, no HTML,
 * so Pushover shows the words as they are.
 *
 * The token and the key go in the body, and never in the address, so no log of
 * an address can keep them. The JSON is written whole by Node's own writer, so
 * nothing in a name can add a field.
 */
export interface PushoverBody {
  token: string;
  user: string;
  title: string;
  message: string;
  /**
   * 0, normal, for a wait, a reminder of one and the test, so it sounds as
   * the device is set to; -1, quiet, for the rest. Never 1, which would sound through
   * the quiet hours set in Pushover, or 2, which repeats until it is
   * acknowledged.
   */
  priority: 0 | -1;
}

/** The push for one message, from the application to the user. */
export function pushoverBody(token: string, user: string, message: PhoneMessage): PushoverBody {
  return {
    token,
    user,
    title: message.title,
    message: message.message,
    // A test sounds as a wait would, so it shows how one will arrive.
    priority: isWaitKind(message.kind) ? 0 : -1,
  };
}
