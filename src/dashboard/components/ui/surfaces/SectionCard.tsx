import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@dashboard/lib/utils";

interface SectionCardProps extends Omit<ComponentProps<"section">, "title"> {
  title: string;
  /** A count straight after the title, such as the number of sessions. */
  count?: ReactNode;
  /** A quiet word or two after the title, such as "last hour". */
  sub?: ReactNode;
  /** What sits at the right of the head: a hint, a clock time, a legend. */
  aside?: ReactNode;
}

/**
 * The card every part of the dashboard sits in: smoked glass at card height,
 * with a rim of light along its edge, a sheen under its top and a deep shadow,
 * on 24px corners. It has no border and no blur of its own.
 *
 * Only the head is inset. The body runs to the card's edges, so a table, a log
 * or a timeline owns its own 24px inset and can lay a row of fill from edge to
 * edge. Anything the body draws is clipped to the card's corners.
 *
 * The hero is not one of these: it draws the highest glass, `glass-raised`,
 * itself.
 */
export function SectionCard({
  title,
  count,
  sub,
  aside,
  className,
  children,
  ...props
}: SectionCardProps) {
  const titleId = useId();
  return (
    <section
      data-slot='section-card'
      aria-labelledby={titleId}
      className={cn("glass-card flex min-w-0 flex-col overflow-hidden", className)}
      {...props}
    >
      <header
        data-part='head'
        className='flex items-baseline justify-between gap-x-4 gap-y-2 px-6 pt-5 pb-3 max-wide:flex-wrap'
      >
        <div className='flex min-w-0 items-baseline gap-2'>
          <h2 id={titleId} className='text-title font-semibold'>
            {title}
          </h2>
          {/* Beside the title, not in it, so the card's name stays the same as the count changes. */}
          {count !== undefined && (
            <span
              data-part='count'
              className='-ml-0.5 text-title font-medium text-ink-muted tabular-nums'
            >
              {count}
            </span>
          )}
          {sub !== undefined && (
            <span data-part='sub' className='text-caption text-ink-muted'>
              {sub}
            </span>
          )}
        </div>
        {aside !== undefined && (
          <div data-part='aside' className='min-w-0 text-caption text-ink-muted'>
            {aside}
          </div>
        )}
      </header>
      {children}
    </section>
  );
}
