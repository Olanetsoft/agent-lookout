import { isWaitKind, type PhoneKind, type PhoneMessage } from "../outbound/phoneMessage.ts";

/**
 * What one push to ntfy is, as the JSON ntfy takes at its server's root: the
 * topic, then the push's title and lines as `phoneMessage.ts` writes them, a
 * priority and a tag. Nothing else: no click address, no actions, no
 * attachment, no icon and no Markdown, so ntfy shows the words as they are.
 *
 * The JSON is written whole by Node's own writer, so nothing in a name can add
 * a field, and written as JSON rather than in headers, so a name in any
 * language arrives as it was written.
 */
export interface NtfyBody {
  topic: string;
  title: string;
  message: string;
  /** 4, high, for a wait and a reminder of one, so it sounds; 3, ntfy's default, for the rest. */
  priority: 3 | 4;
  /** One of ntfy's emoji names, shown before the title. Left out for a summary. */
  tags?: [string];
}

/** The emoji ntfy shows before the title, by its name, for each kind of push. */
const TAG: Record<PhoneKind, string | null> = {
  "needs-you": "hourglass",
  reminder: "hourglass",
  test: "hourglass",
  finished: "white_check_mark",
  failed: "x",
  ended: "stop_sign",
  "quiet-summary": null,
};

/** The push for one message, to the topic. */
export function ntfyBody(topic: string, message: PhoneMessage): NtfyBody {
  const tag = TAG[message.kind];
  return {
    topic,
    title: message.title,
    message: message.message,
    // A test sounds as a wait would, so it shows how one will arrive.
    priority: isWaitKind(message.kind) ? 4 : 3,
    ...(tag !== null && { tags: [tag] as [string] }),
  };
}
