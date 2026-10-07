import type { PhoneChannel } from "@core/api";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { useTestSend } from "@dashboard/hooks/notifications/useTestSend";
import { clockAt } from "@dashboard/lib/format";
import type { TestSendOutcome } from "@dashboard/lib/phone/testSend";

interface TestSendProps {
  channel: PhoneChannel;
  /** The page's clock, for the time a test went. */
  now: number;
  /** What sends it. Defaults to asking the app. For tests. */
  request?: (channel: PhoneChannel) => Promise<TestSendOutcome>;
}

/**
 * Send a test, on the ntfy and Pushover cards while each is on: one quiet
 * button at `sm` that asks the app for one test push, which says only that it
 * is a test from Agent Lookout, and beside it, in a polite live region that is
 * in the page before there is anything to say, what it came to: "Sending a
 * test…", then "Test sent at 14:02." A test that did not go is the info note
 * "The test was not sent" under the row, with why.
 *
 * The button keeps its words and its focus while a test is under way, and a
 * press then does nothing. The row is as tall as its button.
 */
export function TestSend({ channel, now, request }: TestSendProps) {
  const { step, send } = useTestSend(channel, request);
  const sending = step.kind === "sending";

  return (
    <>
      <div className='mt-3 flex min-h-button flex-wrap items-center gap-x-3 gap-y-2'>
        <Button size='sm' onClick={send} aria-disabled={sending || undefined}>
          Send a test
        </Button>
        <p data-part='test' role='status' className='text-body text-ink'>
          {sending && "Sending a test…"}
          {step.kind === "sent" && (
            <>
              Test sent at <span className='tabular-nums'>{clockAt(step.at, now)}</span>.
            </>
          )}
        </p>
      </div>
      {step.kind === "failed" && (
        <Callout title='The test was not sent' className='mt-3'>
          <p>
            <FactText>{step.words}</FactText>
          </p>
        </Callout>
      )}
    </>
  );
}
