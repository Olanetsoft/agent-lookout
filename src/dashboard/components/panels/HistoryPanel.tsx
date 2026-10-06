import { useState } from "react";

import { staleAfterInWords } from "@core/sessions/staleness";
import { staleAfterMs } from "@core/time-rules/timeRules";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { DetailsModal } from "@dashboard/components/ui/surfaces/DetailsModal";
import { HistoryChart } from "@dashboard/components/ui/charts/HistoryChart";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { useHistoryWindow } from "@dashboard/hooks/data/useHistoryWindow";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { sentenceStart } from "@dashboard/lib/format";
import {
  HISTORY_WINDOWS,
  samplesOf,
  type HistoryMetric,
  type HistoryWindowId,
} from "@dashboard/lib/charts/historyChart";
import { countNeedingYou } from "@dashboard/lib/sessions/sessions";
import { DEFAULT_GAP_MS } from "@dashboard/lib/charts/sparkline";

interface MetricCopy {
  title: string;
  /** One sentence under the title. */
  about: string;
  /**
   * The line's colour. The needs-you tone is the lamp's, so it is drawn only
   * while a session needs the person now; see `HistoryBody`.
   */
  tone: "needs-you" | "working" | "idle";
  /** What the chart shows, for assistive technology. */
  chart: string;
  /** A count in words, for the reading under the pointer. */
  describe: (count: number) => string;
  /** What the number counts, in plain words, with how long a session is idle before it is stale. */
  explainer: string | ((staleAfter: string) => string);
}

const METRICS: Record<HistoryMetric, MetricCopy> = {
  needsYou: {
    title: "Needs you",
    about: "How many sessions were waiting on you, over time.",
    tone: "needs-you",
    chart: "Sessions that need you",
    describe: (count) => `${count} ${count === 1 ? "needs" : "need"} you`,
    explainer:
      "A session needs you when it has stopped and cannot go on without an answer: a permission to grant, a question, or a plan to approve. The line is how many were waiting at each moment.",
  },
  working: {
    title: "Working",
    about: "How many sessions were in the middle of a task, over time.",
    tone: "working",
    chart: "Sessions working",
    describe: (count) => `${count} working`,
    explainer:
      "A session is working while it is in the middle of a task. The line is how many were busy at each moment.",
  },
  idle: {
    title: "Idle",
    about: "How many sessions were ready for a new prompt, over time.",
    tone: "idle",
    chart: "Idle sessions",
    describe: (count) => `${count} idle`,
    explainer: (staleAfter) =>
      `A session is idle when it has finished what it was asked and is ready for a new prompt. One left idle ${staleAfter} or more is stale, and is counted under Stale instead. The line is how many were idle at each moment.`,
  },
};

/** Shown in place of a number that was not measured. */
const NOT_KNOWN = "–";

function Figure({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div data-slot='figure' className='min-w-0'>
      <p className='text-body font-medium text-ink-secondary'>{label}</p>
      <p className='mt-2 text-stat font-medium tabular-nums'>{value}</p>
      <p className='mt-2 text-caption text-ink-muted'>{caption}</p>
    </div>
  );
}

/** Mounted only while the panel is open, so a long window is asked for only then. */
function HistoryBody({
  metric,
  state,
  now,
}: {
  metric: HistoryMetric;
  state: CollectorState;
  now: number;
}) {
  // The window belongs to the panel. It starts at the shortest one.
  const [windowId, setWindowId] = useState<HistoryWindowId>("15m");
  const range =
    HISTORY_WINDOWS.find((candidate) => candidate.id === windowId) ?? HISTORY_WINDOWS[0];
  const copy = METRICS[metric];
  const { history, status } = useHistoryWindow(range.ms, state.history);

  const start = now - range.ms;
  const samples = history ? samplesOf(history.points, metric) : [];
  let highest: number | null = null;
  for (const sample of samples) {
    if (sample.at < start || sample.at > now) continue;
    if (highest === null || sample.value > highest) highest = sample.value;
  }
  // The newest sample stands for the present only while polls are still arriving.
  const newest = samples[samples.length - 1];
  const current = newest && now - newest.at <= DEFAULT_GAP_MS ? newest.value : null;
  // Amber is for what needs the person now. With nothing waiting, the Needs you
  // line takes the idle tone, past waits and all, so opening the dialog never
  // brings a warm colour onto a calm screen.
  const tone =
    copy.tone === "needs-you" && countNeedingYou(state.snapshot?.sessions) === 0
      ? "idle"
      : copy.tone;

  return (
    <>
      <div className='mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4'>
        <div className='flex gap-6'>
          <Figure
            label='Now'
            value={current === null ? NOT_KNOWN : String(current)}
            caption={current === null ? "Not being measured" : "At the last check"}
          />
          <div className='border-l border-rule pl-6'>
            <Figure
              label='Highest'
              value={highest === null ? NOT_KNOWN : String(highest)}
              caption={highest === null ? "Nothing measured" : `In ${range.words}`}
            />
          </div>
        </div>
        <SegmentedControl
          label='Time window'
          value={windowId}
          onValueChange={setWindowId}
          options={HISTORY_WINDOWS.map(({ id, label }) => ({ value: id, label }))}
        />
      </div>

      <div className='mt-5 h-55'>
        {status === "ready" ? (
          <HistoryChart
            samples={samples}
            start={start}
            end={now}
            tone={tone}
            label={`${copy.chart} over ${range.words}`}
            describe={copy.describe}
          />
        ) : status === "loading" ? (
          <Loading label={`Reading ${range.words}`} className='h-full' />
        ) : (
          <Callout tone='error' title={`${sentenceStart(range.words)} could not be read`}>
            <p>
              Agent Lookout did not answer when asked for it. The page asks again every minute. The
              15 minute window is still there.
            </p>
          </Callout>
        )}
      </div>

      <div
        data-slot='explainer'
        className='mt-5 rounded-inner bg-fill-quiet px-4 py-3 inset-ring inset-ring-hairline'
      >
        <p className='text-row font-semibold text-ink'>What this counts</p>
        <p className='mt-0.5 text-body text-ink-secondary'>
          {typeof copy.explainer === "string"
            ? copy.explainer
            : copy.explainer(staleAfterInWords(staleAfterMs(state.snapshot?.timeRules)))}
        </p>
        <p className='mt-1.5 text-body text-ink-secondary'>
          Hatched time was not measured: Agent Lookout was not running, or could not read its
          source, or the history was cleared then. It is never drawn as zero.{" "}
          {state.history?.kept?.where === "memory"
            ? "History covers the last six hours and starts again when Agent Lookout restarts."
            : "History covers the last six hours, and is kept when Agent Lookout restarts."}
        </p>
      </div>
    </>
  );
}

interface HistoryPanelProps {
  metric: HistoryMetric;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: CollectorState;
  now: number;
}

/**
 * What is behind Needs you, Working or Idle: the same count, over time, on a
 * chart with a scale, over the last 15 minutes, hour or six hours. It floats
 * over the Overview as glass.
 */
export function HistoryPanel({ metric, open, onOpenChange, state, now }: HistoryPanelProps) {
  const copy = METRICS[metric];
  return (
    <DetailsModal
      open={open}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={copy.about}
      size='wide'
    >
      <HistoryBody metric={metric} state={state} now={now} />
    </DetailsModal>
  );
}
