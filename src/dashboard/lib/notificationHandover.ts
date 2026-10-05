/**
 * How a page that is leaving hands its notifications on to the pages that stay.
 *
 * With the dashboard open in two tabs at one address, both notify of the same
 * wait, and the browser keeps one notification for the two: the later takes
 * the place of the earlier. Only the page that made it can take it down, and
 * that page does so when it is closed or reloaded, while the session may still
 * be waiting. So as it leaves it names the sessions whose notifications it
 * took down, and a page that stays shows them again for those it still sees
 * waiting.
 *
 * The word goes over a BroadcastChannel, which reaches the pages open at this
 * same address in this same browser and nothing else. It never leaves the
 * browser, and it holds session ids only. Where there is no BroadcastChannel,
 * nothing is said, and each page looks after its own notifications.
 */

/** The channel's name. A page hears only the other pages at its own address. */
export const NOTIFICATION_HANDOVER_CHANNEL = "agent-lookout-notifications";

/** What a leaving page says: the ids of the sessions whose notifications it took down. */
export interface NotificationHandoverMessage {
  handedOver: string[];
}

export interface NotificationHandover {
  /** Tells the other pages at this address which sessions' notifications this page took down. */
  handOver(sessionIds: readonly string[]): void;
  /** Stops listening and lets go of the channel. Nothing can be handed over after it. */
  close(): void;
}

/** The session ids in a message, or none when it is not one of these. */
function readHandedOver(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const { handedOver } = data as Partial<NotificationHandoverMessage>;
  if (!Array.isArray(handedOver)) return [];
  return handedOver.filter((id): id is string => typeof id === "string");
}

/**
 * Starts listening for the notifications other pages hand over as they leave.
 * `onHandedOver` gets the session ids, and is never called with none.
 */
export function openNotificationHandover(
  onHandedOver: (sessionIds: string[]) => void,
): NotificationHandover {
  let channel: BroadcastChannel | null;
  try {
    channel = new BroadcastChannel(NOTIFICATION_HANDOVER_CHANNEL);
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const sessionIds = readHandedOver(event.data);
      if (sessionIds.length > 0) onHandedOver(sessionIds);
    });
  } catch {
    // No way to reach the other pages here.
    channel = null;
  }

  return {
    handOver(sessionIds) {
      if (!channel || sessionIds.length === 0) return;
      const message: NotificationHandoverMessage = { handedOver: [...sessionIds] };
      try {
        channel.postMessage(message);
      } catch {
        // The channel has gone. The page is leaving and there is nobody to tell.
      }
    },

    close() {
      channel?.close();
      channel = null;
    },
  };
}
