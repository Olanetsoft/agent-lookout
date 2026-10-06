import { Fragment, useEffect, useRef, useState } from "react";

import type { HistoryResponse } from "@core/api";
import { historySince } from "@core/history";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import {
  clearFailureWords,
  keptHistoryWords,
  requestClearHistory,
  type ClearOutcome,
} from "@dashboard/lib/api/keptHistory";
import { clockAt } from "@dashboard/lib/format";

interface HistoryCardProps {
  /**
   * The history the page holds, as `/api/history` last answered: where it
   * begins and where it is kept. Null before the app has answered.
   */
  history?: Pick<HistoryResponse, "startedAt" | "since" | "kept"> | null;
  now: number;
  /** Told once the history has been cleared, so the page reads it again at once. */
  onCleared?: () => void;
  /** What clears it. Defaults to asking the app. */
  clear?: () => Promise<ClearOutcome>;
}

/** Where the card is between presses. */
type Step =
  | { kind: "idle" }
  | { kind: "confirming"; busy: boolean }
  | { kind: "cleared"; at: number }
  | { kind: "failed"; words: string };

/** What the person is asked before the history goes. */
export const CLEAR_QUESTION = "Clear the Events log and the charts? This cannot be undone.";

/**
 * Where the history is kept, how much it holds and since when, and the one
 * button that clears it.
 *
 * Kept on disk, the state says for how long, beside Clear history, and the
 * facts under it give the folder, the size against the cap and where the
 * history begins. Clear history asks first, in the state's own line, with
 * Clear history and Cancel beside it, and focus goes to Cancel. Once it is
 * cleared, a line says when, and the Events log starts again from there. In
 * memory only, with `AGENT_LOOKOUT_HISTORY=off`, the card says so and has no
 * button. Before the app has answered, it says nothing.
 *
 * While this copy is not writing the files, because another copy is or they
 * cannot be written, an info note says why, and there is no button: clearing
 * is left to the copy that writes them.
 */
export function HistoryCard({
  history = null,
  now,
  onCleared,
  clear = requestClearHistory,
}: HistoryCardProps) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const clearButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  /** Which button takes focus once the step is drawn. */
  const focusNext = useRef<"clear" | "cancel" | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "cancel") cancelButton.current?.focus();
    else if (target === "clear") clearButton.current?.focus();
  }, [step]);

  const kept = history?.kept ?? null;
  if (history === null || kept === null) {
    return (
      <SectionCard title='History'>
        <div className='px-6 pb-6'>
          <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
            {history === null ? null : "Where the history is kept could not be read."}
          </p>
        </div>
      </SectionCard>
    );
  }

  const words = keptHistoryWords(kept, historySince(history), now);
  const canClear = kept.canClear;
  const confirming = step.kind === "confirming" && canClear;

  const ask = () => {
    focusNext.current = "cancel";
    setStep({ kind: "confirming", busy: false });
  };
  const cancel = () => {
    focusNext.current = "clear";
    setStep({ kind: "idle" });
  };
  const confirm = () => {
    if (step.kind !== "confirming" || step.busy) return;
    setStep({ kind: "confirming", busy: true });
    void clear().then((outcome) => {
      focusNext.current = "clear";
      if (outcome.ok) {
        setStep({ kind: "cleared", at: outcome.at });
        onCleared?.();
      } else {
        setStep({ kind: "failed", words: clearFailureWords(outcome) });
      }
    });
  };

  return (
    <SectionCard title='History'>
      <div className='px-6 pb-6'>
        {/* As tall as its button, so what follows keeps its place when there is none. */}
        <div className='flex min-h-button flex-wrap items-center gap-x-3 gap-y-2'>
          {/* Said again to a screen reader when the question takes its place. */}
          <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
            {confirming ? CLEAR_QUESTION : words.state}
          </p>
          {canClear &&
            (confirming ? (
              <>
                <Button size='sm' onClick={confirm} aria-disabled={step.busy || undefined}>
                  Clear history
                </Button>
                <Button ref={cancelButton} size='sm' onClick={cancel}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button ref={clearButton} size='sm' onClick={ask}>
                Clear history
              </Button>
            ))}
        </div>

        {words.facts && (
          <FactList className='mt-3'>
            <FactRow label='Folder' mono>
              {/* A folder can be any length. It breaks after a slash where it
                  can, and anywhere rather than run past the card. */}
              <span data-part='folder' className='wrap-anywhere select-text'>
                {words.facts.folder.split("/").map((part, index, parts) => (
                  <Fragment key={index}>
                    {part}
                    {index < parts.length - 1 && (
                      <>
                        /<wbr />
                      </>
                    )}
                  </Fragment>
                ))}
              </span>
            </FactRow>
            <FactRow label='Holds'>
              <span className='tabular-nums'>{words.facts.holds}</span>
            </FactRow>
            <FactRow label='Since'>
              <span className='tabular-nums'>{words.facts.since}</span>
            </FactRow>
          </FactList>
        )}

        {words.note && (
          <Callout title={words.note.title} className='mt-3'>
            <p>
              <FactText>{words.note.detail}</FactText>
            </p>
          </Callout>
        )}
        {step.kind === "failed" && (
          <Callout title='The history could not be cleared' className='mt-3'>
            <p>
              <FactText>{step.words}</FactText>
            </p>
          </Callout>
        )}
        {step.kind === "cleared" && (
          <p data-part='outcome' role='status' className='mt-3 text-body text-ink'>
            History cleared at <span className='tabular-nums'>{clockAt(step.at, now)}</span>.
          </p>
        )}

        {words.explanation.map((paragraph, index) => (
          <p
            key={paragraph}
            className={
              index === 0
                ? "mt-3 text-body text-ink-secondary"
                : "mt-2 text-body text-ink-secondary"
            }
          >
            <FactText>{paragraph}</FactText>
          </p>
        ))}
      </div>
    </SectionCard>
  );
}
