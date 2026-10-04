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
  /** The value. Set `mono` when it is a machine fact: a time, a count, a path. */
  children: ReactNode;
  mono?: boolean;
}

export function FactRow({ label, children, mono = false }: FactRowProps) {
  return (
    <div
      data-slot='fact-row'
      className='flex items-baseline justify-between gap-6 border-b border-hairline py-2.5 last:border-b-0'
    >
      <dt className='shrink-0 text-body text-ink-secondary'>{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right text-ink",
          mono ? "font-mono text-fact" : "text-body font-medium",
        )}
      >
        {children}
      </dd>
    </div>
  );
}
