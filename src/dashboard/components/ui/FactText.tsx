import { splitFacts } from "@dashboard/lib/facts";

/**
 * A sentence from the collector, with the machine facts in it set in the mono
 * face: the command it ran, the folder it read, the variable that was set. The
 * words stay in the sans face, and the text itself is not changed.
 */
export function FactText({ children }: { children: string }) {
  return (
    <>
      {splitFacts(children).map((run, index) =>
        run.fact ? (
          <code key={index} data-slot='fact' className='font-mono text-fact'>
            {run.text}
          </code>
        ) : (
          run.text
        ),
      )}
    </>
  );
}
