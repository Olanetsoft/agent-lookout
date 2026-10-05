import { cn } from "@dashboard/lib/utils";

interface LoadingProps {
  /** What is being waited for, such as "Reading sessions". */
  label: string;
  className?: string;
}

/**
 * Waiting for an answer. A turning ring and a few words, and nothing else, so it
 * reads as "not yet" rather than as "nothing" or "broken". The ring is the open
 * ring of the status marks, in the strong rule, with one quarter in ink. It sits
 * straight on the glass, with no box. Under the reduced-motion
 * preference it holds still and the words carry the state.
 */
export function Loading({ label, className }: LoadingProps) {
  return (
    <div
      data-slot='loading'
      role='status'
      className={cn("flex items-center justify-center gap-2.5 px-6 py-14", className)}
    >
      <span
        aria-hidden
        className='size-mark animate-spin-loader rounded-capsule border-[1.5px] border-rule-strong border-t-ink-secondary'
      />
      <span className='text-body font-medium text-ink-secondary'>{label}</span>
    </div>
  );
}
