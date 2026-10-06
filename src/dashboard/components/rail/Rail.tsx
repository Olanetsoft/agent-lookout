import type { ComponentType } from "react";

import { OverviewIcon, SettingsIcon, SourcesIcon } from "@dashboard/assets/Icons";
import { LookoutMark } from "@dashboard/assets/LookoutMark";
import { cn } from "@dashboard/lib/utils";
import { VIEWS, type ViewId } from "@dashboard/lib/shell/view";

const ICON: Record<ViewId, ComponentType<{ className?: string }>> = {
  overview: OverviewIcon,
  sources: SourcesIcon,
  settings: SettingsIcon,
};

interface RailProps {
  /** The view in the main area. */
  current: ViewId;
  /**
   * How many sessions need the person, as of the last answer, or null before the
   * first one. The lamp in the mark is lit only while it is above zero. Once
   * answers stop it keeps the last count, as the counts and the list do, while
   * the page says above them that the data is no longer current.
   */
  needsYou: number | null;
}

/** What the mark says to assistive technology: the product, and the one thing it watches for. */
function markName(needsYou: number | null): string {
  if (needsYou === null) return "Agent Lookout";
  if (needsYou === 0) return "Agent Lookout, no session needs you";
  return `Agent Lookout, ${needsYou} ${needsYou === 1 ? "session needs" : "sessions need"} you`;
}

/**
 * The rail down the left edge: the mark at its head, then a link to each view.
 * It is chrome glass, the thinnest of the three heights, inset from the window's
 * edges, with no blur: nothing passes behind it.
 *
 * It is navigation, so each view is a link to its own address, and the current
 * one says so with `aria-current="page"` as well as on screen: a lit rounded
 * selection, full-strength words and a fine rim. Nothing in it moves or changes
 * size. Its contents stay in view on a long page.
 *
 * In a narrow window it narrows to its icons, and each view keeps its name for
 * assistive technology, so navigation never goes. In the Mac app's window it
 * keeps its full width, because the window's three buttons sit on a cell of its
 * own at its top, above the mark, level with the header.
 *
 * The lamp in the mark is lit while a session needs the person, so that can be
 * read from every view.
 */
export function Rail({ current, needsYou }: RailProps) {
  const lit = needsYou !== null && needsYou > 0;

  return (
    <nav
      data-slot='rail'
      aria-label='Views'
      className='glass-chrome z-20 w-rail shrink-0 max-mid:w-14 in-app:w-rail'
    >
      <div className='sticky top-window flex flex-col items-center'>
        {/*
          In the Mac app's window, its three buttons sit here, and a drag here
          moves the window. In full screen macOS hides them, and the cell goes.
        */}
        <div
          data-slot='rail-buttons'
          aria-hidden
          className='hidden h-header w-full in-app-windowed:block'
        />
        <a
          href={VIEWS[0]?.href}
          data-slot='rail-mark'
          data-lit={lit}
          aria-label={markName(needsYou)}
          className='grid h-header w-full place-items-center rounded-t-chrome text-ink focus-visible:-outline-offset-2 in-app-windowed:rounded-inner'
        >
          <LookoutMark lit={lit} />
        </a>

        <ul className='flex w-full flex-col items-center gap-1 py-3'>
          {VIEWS.map((view) => {
            const Icon = ICON[view.id];
            const here = view.id === current;
            return (
              <li key={view.id}>
                <a
                  href={view.href}
                  data-slot='rail-link'
                  data-view={view.id}
                  aria-current={here ? "page" : undefined}
                  className={cn(
                    "flex w-15.5 flex-col items-center gap-1.25 rounded-inner pt-2.5 pb-2.25",
                    "text-micro leading-none font-medium transition-colors duration-120",
                    "max-mid:w-11 max-mid:py-2.5",
                    here
                      ? "bg-fill-selected text-ink inset-ring inset-ring-control-rim inset-shadow-top"
                      : "text-ink-secondary hover:bg-fill-hover hover:text-ink",
                  )}
                >
                  <Icon />
                  <span className='max-mid:sr-only'>{view.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
