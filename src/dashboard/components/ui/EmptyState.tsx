import type { ReactNode } from "react";

import { cn } from "@dashboard/lib/utils";

interface EmptyStateProps {
  title: string;
  /** One or two sentences: what this means, and what will change it. */
  children?: ReactNode;
  /** A quiet drawing above the title. */
  visual?: ReactNode;
  /** Less padding, for a small card. */
  compact?: boolean;
  className?: string;
}

/**
 * Nothing to show, and nothing wrong. Centred words with no box and no icon, so
 * it cannot be read as an error, and nothing turning, so it cannot be read as
 * still loading.
 */
export function EmptyState({
  title,
  children,
  visual,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-slot='empty-state'
      className={cn(
        "flex flex-col items-center text-center",
        compact ? "px-5 py-8" : "px-5 py-14",
        className,
      )}
    >
      {visual && <div className='mb-4'>{visual}</div>}
      <p className='text-title font-semibold text-ink'>{title}</p>
      {children && (
        <div className='mt-1.5 max-w-[52ch] text-body text-ink-secondary'>{children}</div>
      )}
    </div>
  );
}
