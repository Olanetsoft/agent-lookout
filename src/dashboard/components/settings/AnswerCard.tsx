import type { AnsweringStatus } from "@core/sessions/session";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { durationInWords } from "@dashboard/lib/format";

/**
 * A command the person types into Claude Code: a literal block of its own, in
 * the mono, so it is read and copied whole. It breaks only where it must, on a
 * phone.
 */
function Command({ children }: { children: string }) {
  return (
    <code
      data-slot='fact'
      data-part='install-command'
      className='block w-fit max-w-full rounded-row bg-fill-zebra px-3 py-1.5 font-mono text-fact text-ink inset-ring inset-ring-hairline select-all wrap-break-word'
    >
      {children}
    </code>
  );
}

/** How to install the plugin, in Claude Code's own commands, one to a line. */
function Install() {
  return (
    <div data-part='install' className='mt-3 flex flex-col gap-2'>
      <p className='text-body text-ink-secondary'>In Claude Code, run these two commands:</p>
      <Command>/plugin marketplace add Olanetsoft/agent-lookout</Command>
      <Command>/plugin install agent-lookout@agent-lookout</Command>
    </div>
  );
}

/** The state, in words, as the first line of the card. */
function stateWords(answering: AnsweringStatus): string {
  switch (answering.state) {
    case "on":
      return "Permission prompts of Claude Code sessions with the plugin can be answered from here.";
    case "off":
      return "Permission prompts are not answered from here.";
    case "unavailable":
      return "Permission prompts cannot be answered from here.";
  }
}

/**
 * Whether permission prompts can be answered from the dashboard, a card with
 * no control: it is set in the environment Agent Lookout starts with, and the
 * plugin is installed in Claude Code.
 *
 * Under the state, one plain line: what the plugin needs, how long a request
 * is held, or, once a Claude Code session has waited for permission and its
 * request did not reach Agent Lookout, that the plugin may not be installed
 * for it. Where the plugin is needed, the two commands that install it follow,
 * each a literal block on its own line. This card, and not every waiting row,
 * is where that is said. Before the app has answered, the card says nothing.
 * Nothing in it is warm.
 */
export function AnswerCard({ answering }: { answering: AnsweringStatus | null }) {
  let line = null;
  let install = false;
  if (answering?.state === "on") {
    install = answering.plugin !== "seen";
    line =
      answering.plugin === "missed" ? (
        <>
          A Claude Code session asked for permission, but its request did not reach Agent Lookout.
          The plugin may not be installed for it.
        </>
      ) : answering.plugin === "seen" ? (
        <>
          Requests from the plugin reach Agent Lookout. Each is held for{" "}
          {durationInWords(answering.holdMs)}, and the session&apos;s own prompt can still be
          answered meanwhile. Deny is always offered, and Allow when all of what it allows is shown.
        </>
      ) : (
        <>
          Answering needs the Agent Lookout plugin in Claude Code. Without it, a session&apos;s
          prompts are answered in the session only.
        </>
      );
  } else if (answering?.state === "off") {
    line = <FactText>AGENT_LOOKOUT_ANSWER is off, so no request is held.</FactText>;
  } else if (answering?.state === "unavailable" && answering.problem) {
    line = <FactText>{answering.problem}</FactText>;
  }

  return (
    <SectionCard title='Permission prompts'>
      <div data-slot='answer-card' className='px-6 pb-6'>
        <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
          {answering && stateWords(answering)}
        </p>
        {line && (
          <p
            data-part='plugin'
            data-plugin={answering?.plugin}
            className='mt-3 text-body text-ink-secondary'
          >
            {line}
          </p>
        )}
        {install && <Install />}
      </div>
    </SectionCard>
  );
}
