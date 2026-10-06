import type { ReactNode } from "react";

import { cn } from "@dashboard/lib/utils";

/** A list of label and value pairs, with a hairline under each. */
export function FactList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl data-slot='fact-list' className={cn("flex flex-col", className)}>
      {children}
    </dl>
  );
}

interface FactRowProps {
  label: string;
  /** The value. Set `mono` when it is a literal string: a folder, a file or a command. */
  children: ReactNode;
  mono?: boolean;
  /** Words under the pair, across the whole row: why the value is what it is. */
  note?: ReactNode;
}

export function FactRow({ label, children, mono = false, note }: FactRowProps) {
  return (
    <div
      data-slot='fact-row'
      className={cn(
        "items-baseline border-b border-hairline py-2.5 last:border-b-0",
        // With a note the pair keeps its two sides, and the note takes a line
        // of its own under both.
        note === undefined
          ? "flex justify-between gap-6"
          : "grid grid-cols-[auto_minmax(0,1fr)] gap-x-6",
      )}
    >
      <dt className='shrink-0 text-body text-ink-secondary'>{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right text-pretty text-ink",
          mono ? "font-mono text-fact" : "text-body font-medium",
        )}
      >
        {children}
      </dd>
      {note !== undefined && (
        <dd data-part='note' className='col-span-2 mt-1 text-caption text-ink-secondary'>
          {note}
        </dd>
      )}
    </div>
  );
}
