import { AnimatePresence, domMin, LazyMotion, m, MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import { DashboardView } from "@dashboard/components/dashboard/DashboardView";
import { Header } from "@dashboard/components/dashboard/Header";
import { SearchDialog } from "@dashboard/components/keyboard/SearchDialog";
import { ShortcutsDialog } from "@dashboard/components/keyboard/ShortcutsDialog";
import { Rail } from "@dashboard/components/rail/Rail";
import { SettingsView } from "@dashboard/components/settings/SettingsView";
import { SourcesView } from "@dashboard/components/sources/SourcesView";
import { ErrorBoundary } from "@dashboard/components/ui/feedback/ErrorBoundary";
import { useCollector } from "@dashboard/hooks/data/useCollector";
import { useDocumentHidden } from "@dashboard/hooks/dom/useDocumentHidden";
import { useShowSession } from "@dashboard/hooks/dom/useShowSession";
import { useDocumentTitle } from "@dashboard/hooks/shell/useDocumentTitle";
import { useNewSince } from "@dashboard/hooks/data/useNewSince";
import { useNow } from "@dashboard/hooks/data/useNow";
import { useShortcuts } from "@dashboard/hooks/shell/useShortcuts";
import { useSessionAddress, useView } from "@dashboard/hooks/shell/useView";
import { useWaitNotifications } from "@dashboard/hooks/notifications/useWaitNotifications";
import { workerBeat } from "@dashboard/lib/api/beat";
import { createCollectorStore, type CollectorStore } from "@dashboard/lib/api/collectorStore";
import type { HistoryMetric } from "@dashboard/lib/charts/historyChart";
import { countNeedingYou } from "@dashboard/lib/sessions/sessions";
import { closeSession } from "@dashboard/lib/shell/sessionDetails";
import { viewLabel } from "@dashboard/lib/shell/view";

/*
 * The history dialogs are not part of the first screen, so they are not part of
 * the first file either. They are fetched from this same server as soon as the
 * page has drawn, and are there long before anyone can open one.
 */
const HistoryPanel = lazy(() =>
  import("@dashboard/components/panels/HistoryPanel").then((m) => ({ default: m.HistoryPanel })),
);
/* A session's details are fetched the same way. */
const SessionPanel = lazy(() =>
  import("@dashboard/components/panels/SessionPanel").then((m) => ({ default: m.SessionPanel })),
);

/**
 * Motion as the dashboard uses it. It animates one thing, the Overview fading
 * in and out as it changes, and that takes only Motion's animations and their
 * exit, which `domMin` holds. So the app loads those, and leaves out the
 * gestures, layout animations and dragging the whole of `motion` carries. Use
 * `m`: the lint rules in eslint.config.js refuse `motion`, and any prop on `m`
 * that needs what `domMin` leaves out. To ask for more, load it here and change
 * those rules. LazyMotion's `strict` would not catch it, since it checks only
 * where `process` exists, and a browser has none. `reducedMotion='user'`
 * follows the reduced-motion preference, under which Motion moves nothing and
 * still fades.
 */
function Motion({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMin}>
      <MotionConfig reducedMotion='user'>{children}</MotionConfig>
    </LazyMotion>
  );
}

/** The counts that open a history dialog. */
const HISTORY_METRICS: readonly HistoryMetric[] = ["needsYou", "working", "idle"];

interface AppProps {
  /**
   * Tests pass their own store. The app creates one that polls the local server,
   * on a beat that keeps time while the tab is in the background.
   */
  store?: CollectorStore;
}

/**
 * The ground behind everything: a layered black with soft fields of light in
 * it, fixed to the window, so the glass panels slide over its light as the page
 * scrolls. Its light drifts very slowly, and stops while the page is out of
 * sight, since nobody is there to see it.
 *
 * The header stays 12px below the window's top edge, the inset every panel
 * keeps, and content passes behind its glass as the page scrolls. Above it, in
 * that inset, the same ground is laid again over the content, so the content
 * is seen only behind the glass and never runs on to the window's edge. It is
 * the same layers in the same place, moving together, so it cannot be told
 * from the ground under it. The rail stays above it, as it is above the page.
 */
function Ground() {
  const hidden = useDocumentHidden();
  const layer = (slot: string, className: string) => (
    <div
      aria-hidden
      data-slot={slot}
      data-drift={hidden ? "paused" : undefined}
      className={className}
    >
      <i className='ground-main' />
      <i className='ground-deep' />
      <i className='ground-far' />
    </div>
  );
  return (
    <>
      {layer("ground", "ground")}
      {layer("ground-above", "ground bottom-auto z-10 h-window bg-fixed")}
    </>
  );
}

/**
 * The frame: the ground behind, the rail down the left edge, and beside it the
 * header over the view the rail has chosen, each inset from the window's edges.
 * Choosing a view puts it in the main area in place of the last one and moves
 * focus there; the rail and the header stay where they were. The header stays
 * at the top as the page scrolls, and is the one panel content passes behind.
 * Working, Idle and the hero's title open a history dialog over the Overview.
 * A session's row or card opens its details there, at an address of their
 * own, so a link, Back and a reload land on them; closing them goes back to
 * the Overview.
 *
 * A session that starts waiting sends a notification from here, whichever view
 * is showing, once the person has turned that on in Settings.
 *
 * Coming back to the page after it was out of sight, the events log draws a
 * line under what arrived meanwhile. Where it goes is worked out here, on every
 * view, because the time the log was last on screen has to outlast the
 * Overview while another view shows.
 *
 * On every view, "/", Cmd+K or Ctrl+K, and the header's button open the search,
 * and "?" the sheet of shortcuts. While another dialog is open those keys are
 * left to it. Choosing a session in the search presses its Jump, on its row
 * on the Overview, or opens its details when it has none.
 */
export default function App({ store: providedStore }: AppProps) {
  const [store] = useState(() => providedStore ?? createCollectorStore({ beat: workerBeat }));
  const state = useCollector(store);
  // On every view, and with nothing drawn for it.
  useWaitNotifications(store);
  const now = useNow();
  const view = useView();
  const details = useSessionAddress();
  const [history, setHistory] = useState<HistoryMetric | null>(null);
  const [search, setSearch] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const main = useRef<HTMLElement>(null);
  const shownView = useRef(view);
  const newSince = useNewSince(state.events, view === "overview", state.snapshot !== null);

  const needsYou = countNeedingYou(state.snapshot?.sessions);
  useDocumentTitle(needsYou);

  // The lamp in the mark agrees with the hero and the list under it. Before the
  // first answer there is nothing to agree with, and it is out.
  const lamp = state.snapshot ? needsYou : null;

  // A new view takes focus, so the keyboard and a screen reader are where the
  // eye is. The first view is not a change, and the page's focus is left alone.
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    main.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [view]);

  // After the effect above, so a session's Jump takes focus from the new view.
  const showSession = useShowSession(main, view);

  useShortcuts((shortcut) => {
    if (history !== null || shortcuts || details !== null) return false;
    // Cmd+K in the open search closes it. "?" in it is the search's own to answer.
    if (shortcut === "search") setSearch((open) => !open);
    else if (search) return false;
    else setShortcuts(true);
    return true;
  });

  // The three things the Overview can be. Moving between them is a cross-fade.
  const overview = state.snapshot
    ? "dashboard"
    : state.phase === "unreachable"
      ? "problem"
      : "loading";

  return (
    <Motion>
      <Ground />
      <div data-slot='frame' className='flex min-h-screen gap-window p-window'>
        <Rail current={view} needsYou={lamp} />

        <div className='flex min-w-0 flex-1 flex-col gap-4 pb-7'>
          <Header
            phase={state.phase}
            snapshot={state.snapshot}
            lastOkAt={state.lastOkAt}
            now={now}
            onSearch={() => setSearch(true)}
          />

          <main
            ref={main}
            tabIndex={-1}
            aria-label={viewLabel(view)}
            data-view={view}
            className='flex-1 outline-none'
          >
            {/* A fault in a view leaves the rail and the header standing. */}
            <ErrorBoundary key={view}>
              {view === "sources" ? (
                <SourcesView state={state} now={now} />
              ) : view === "settings" ? (
                <SettingsView
                  history={state.history}
                  now={now}
                  onHistoryCleared={store.refresh}
                  onTimeRulesChanged={store.refresh}
                  snapshot={state.snapshot}
                  answering={state.snapshot?.answering ?? null}
                />
              ) : (
                <AnimatePresence mode='wait' initial={false}>
                  <m.div
                    key={overview}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                  >
                    <DashboardView
                      state={state}
                      now={now}
                      onRetry={store.refresh}
                      onEnded={store.refresh}
                      onAnswered={store.refresh}
                      onOpenHistory={setHistory}
                      newSince={newSince.since}
                      onNewLineInView={newSince.onLineInView}
                    />
                  </m.div>
                </AnimatePresence>
              )}
            </ErrorBoundary>
          </main>
        </div>
      </div>

      <Suspense fallback={null}>
        {HISTORY_METRICS.map((metric) => (
          <HistoryPanel
            key={metric}
            metric={metric}
            open={history === metric}
            onOpenChange={(open) => setHistory(open ? metric : null)}
            state={state}
            now={now}
          />
        ))}
        <SessionPanel
          sessionId={details}
          onClose={closeSession}
          state={state}
          now={now}
          onStopped={store.refresh}
          onAnswered={store.refresh}
        />
      </Suspense>

      <SearchDialog
        open={search}
        onOpenChange={setSearch}
        state={state}
        now={now}
        onChoose={showSession}
        onShortcuts={() => setShortcuts(true)}
      />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
    </Motion>
  );
}
