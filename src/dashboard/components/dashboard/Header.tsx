import type { SessionsSnapshot } from "@core/session";
import { ThemeToggle } from "@dashboard/components/dashboard/ThemeToggle";
import { useNarrow } from "@dashboard/hooks/useMediaQuery";
import type { CollectorPhase } from "@dashboard/lib/collectorStore";
import { statusSentence } from "@dashboard/lib/connection";
import { cn } from "@dashboard/lib/utils";

interface HeaderProps {
  phase: CollectorPhase;
  snapshot: SessionsSnapshot | null;
  /** When the last answer arrived, for the line once answers stop. */
  lastOkAt: number | null;
  now: number;
}

/**
 * The header over every view: the wordmark, then a line that says what is being
 * watched and when it was last checked, then the switch between Night and Day.
 *
 * It is chrome glass that stays at the top as the page scrolls, so the cards
 * pass behind it. That makes it the one panel with real blur.
 *
 * The status line is a link to the Sources view, which says the same in full.
 * Its age ticks every second, so it is shown but kept out of what assistive
 * technology reads, and the sentence before it carries the state. Below the
 * `wide` breakpoint the age gives way, so the sentence keeps its room; the
 * fixed time of the last answer, once answers stop, stays.
 *
 * In a narrow window the line moves under the wordmark and keeps its short form,
 * the count or the state in a few words, so it is never left out.
 */
export function Header({ phase, snapshot, lastOkAt, now }: HeaderProps) {
  const status = statusSentence(phase, snapshot, now, lastOkAt);
  const narrow = useNarrow();

  return (
    <header
      data-slot='header'
      className='glass-chrome glass-blur sticky top-window z-30 flex h-header shrink-0 items-center gap-5 pr-2.5 pl-6 max-mid:gap-3 max-mid:pl-4'
    >
      <div className='flex min-w-0 items-center gap-5 max-mid:flex-col max-mid:items-start max-mid:gap-0.5'>
        <h1 className='shrink-0 text-wordmark font-semibold'>Agent Lookout</h1>

        <p
          data-slot='status-line'
          data-status={status.key}
          className='flex max-w-full min-w-0 items-baseline gap-3 border-l border-rule pl-5 text-body text-ink-secondary max-mid:border-l-0 max-mid:pl-0'
        >
          <a
            href='#sources'
            className='truncate rounded-bar transition-colors duration-120 hover:text-ink'
          >
            {narrow ? status.short : status.text}
          </a>
          {status.fact && (
            <span
              data-part='checked'
              aria-hidden={status.fact.ticking || undefined}
              className={cn(
                "shrink-0 text-caption whitespace-nowrap text-ink-muted tabular-nums",
                status.fact.ticking && "max-wide:hidden",
              )}
            >
              {status.fact.text}
            </span>
          )}
        </p>
      </div>

      <ThemeToggle className='ml-auto shrink-0' />
    </header>
  );
}
