import { Literal } from "@dashboard/components/ui/facts/Literal";
import { splitFacts } from "@dashboard/lib/sources/facts";

/**
 * A sentence from the collector, with the machine facts in it set in the mono
 * face: the command it ran, the folder it read, the variable that was set. The
 * words stay in the sans face, and the text itself is not changed. A fact
 * breaks across lines only between its words and after a slash, never at a
 * hyphen inside a flag.
 */
export function FactText({ children }: { children: string }) {
  return (
    <>
      {splitFacts(children).map((run, index) =>
        run.fact ? (
          <code key={index} data-slot='fact' className='font-mono text-fact'>
            <Literal>{run.text}</Literal>
          </code>
        ) : (
          run.text
        ),
      )}
    </>
  );
}
