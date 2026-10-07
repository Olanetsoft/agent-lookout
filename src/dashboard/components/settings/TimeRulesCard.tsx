import { useId, useState, type ReactNode } from "react";

import type { SessionsSnapshot } from "@core/sessions/session";
import { WEEKDAYS, type TimeRules } from "@core/time-rules/timeRules";
import { Checkbox } from "@dashboard/components/ui/controls/Checkbox";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { TextField } from "@dashboard/components/ui/controls/TextField";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { useTimeRules } from "@dashboard/hooks/settings/useTimeRules";
import {
  CLOCK_TAKES,
  IDLE_TAKES,
  LEAVE_OUT,
  idleShown,
  MINUTES_TAKE,
  notWholeDays,
  quietNowLine,
  readClock,
  readIdleHours,
  readMinutes,
  readRepeatMinutes,
  REMIND_AGAIN,
  REPEAT_TAKE,
  repeatShown,
  RULE_NAMES,
  SAME_TIMES,
  WEEKDAY_LABEL,
  WEEKDAY_NAME,
  withDay,
  withRepeat,
  type IdleUnit,
} from "@dashboard/lib/time-rules/timeRulesFields";

const SWITCH = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

const UNITS = [
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
] as const satisfies readonly { value: IdleUnit; label: string }[];

/**
 * A field read when the person leaves it or presses Enter. What it shows is
 * what the app holds, until the person types; Escape puts that back. What
 * cannot be read is never sent: the field goes back to what the app holds,
 * and `onWrong` says what it takes.
 */
function CommitField({
  value,
  label,
  onCommit,
  className,
}: {
  value: string;
  label: string;
  /** Takes what was typed, and says whether it could be read. */
  onCommit: (typed: string) => boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() !== value) onCommit(draft);
  };
  return (
    <TextField
      aria-label={label}
      inputMode='numeric'
      enterKeyHint='done'
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        else if (event.key === "Escape" && draft !== null) {
          event.preventDefault();
          setDraft(null);
        }
      }}
      className={className}
    />
  );
}

/**
 * One rule: its name at the left and its switch at the right, and while it is
 * on, what it is set to under them.
 */
function RuleRow({
  name,
  on,
  onSwitch,
  children,
}: {
  name: string;
  on: boolean;
  onSwitch: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <li data-part='rule' className='border-b border-hairline py-2 last:border-b-0'>
      <div className='flex items-center justify-between gap-6'>
        {/* The switch carries the same name, so this is not read twice. */}
        <span aria-hidden className='text-body text-ink'>
          {name}
        </span>
        <SegmentedControl
          label={name}
          value={on ? "on" : "off"}
          onValueChange={(value) => onSwitch(value === "on")}
          options={SWITCH}
          className='shrink-0'
        />
      </div>
      {on && (
        <div
          data-part='set-to'
          className='mt-2 mb-1 flex flex-col gap-2 text-body text-ink-secondary'
        >
          {children}
        </div>
      )}
    </li>
  );
}

/**
 * A line of what a rule is set to: words and fields, wrapping as one, and 4px
 * under it, after something a field could not take, what it takes.
 */
function SetTo({ take, children }: { take: string | null; children: ReactNode }) {
  return (
    <div>
      <div className='flex flex-wrap items-center gap-x-2 gap-y-2'>{children}</div>
      {/* Said again to a screen reader when it changes. */}
      <p data-part='take' role='status' className='mt-1 empty:hidden'>
        {take}
      </p>
    </div>
  );
}

/**
 * A field and the words that follow it, wrapping as one: on a narrow card the
 * words before them go to a line of their own first, so a number is never
 * parted from its unit. Only narrower than the group itself does it wrap within.
 */
function Together({ children }: { children: ReactNode }) {
  return <span className='inline-flex flex-wrap items-center gap-x-2 gap-y-2'>{children}</span>;
}

/**
 * A line of fields: one for each rule, and the long wait rule's repeat, which
 * has a line of its own under the rule's.
 */
type Line = keyof TimeRules | "repeat";

/** The rule a line's fields change. */
const ruleOf = (line: Line): keyof TimeRules => (line === "repeat" ? "longWait" : line);

/** Which line's field last held something that could not be read, and what it takes. */
type Take = { line: Line; words: string } | null;

interface TimeRulesCardProps {
  /** Told once a change was taken, so the page reads the sessions again at once. */
  onChanged?: () => void;
  /**
   * The page's latest snapshot: the rules it was made by, which the card
   * follows, and whether it was made in quiet hours, by the app's own clock.
   */
  snapshot?: Pick<SessionsSnapshot, "generatedAt" | "timeRules" | "quiet"> | null;
}

/**
 * Time rules, in Settings: the long wait reminder, with its own Off and On for
 * reminding again while the wait goes on, how long a session is idle before it
 * is stale, and quiet hours, each with its own Off and On, and while it is on,
 * what it is set to. Agent Lookout keeps them in its own settings
 * file, so they hold with no dashboard open, and every change is sent to it at
 * once and saved there. The card shows what the app says, so a change it did
 * not take does not look taken, and says why in an info note. Before the app
 * has answered, the card says nothing. Nothing here is warm: a rule is not a
 * session needing the person.
 */
export function TimeRulesCard({ onChanged, snapshot = null }: TimeRulesCardProps) {
  const inForce = snapshot?.timeRules
    ? { timeRules: snapshot.timeRules, generatedAt: snapshot.generatedAt }
    : null;
  const { reading, refused, change } = useTimeRules(onChanged, inForce);
  const [take, setTake] = useState<Take>(null);
  // The unit the idle rule is shown in, once the person has chosen one.
  const [unit, setUnit] = useState<IdleUnit | null>(null);
  const daysLabel = useId();

  if (reading === null || reading === "unknown") {
    return (
      <SectionCard title='Time rules'>
        <div className='px-6 pb-6'>
          <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
            {reading === null ? null : "The time rules could not be read."}
          </p>
        </div>
      </SectionCard>
    );
  }

  const { longWait, idle, quietHours } = reading.timeRules;
  const repeat = repeatShown(longWait);
  // Days only while the hours are whole days, so the field always shows what is in force.
  const idleUnit =
    unit === "days" && idle.hours % 24 !== 0 ? "hours" : (unit ?? idleShown(idle.hours).unit);
  const idleValue = idleUnit === "hours" ? idle.hours : idle.hours / 24;
  const quietNow = quietHours.on && snapshot?.quiet === true;

  /** Any change to a rule puts away what its fields last could not take. */
  const changeRule = (rule: keyof TimeRules, update: (rules: TimeRules) => TimeRules) => {
    setTake((was) => (was !== null && ruleOf(was.line) === rule ? null : was));
    change(update);
  };

  /** Reads a field: sends what it makes, or says what it takes. */
  const field =
    (
      line: Line,
      words: string,
      apply: (typed: string, rules: TimeRules) => TimeRules | string | null,
    ) =>
    (typed: string): boolean => {
      const made = apply(typed, reading.timeRules);
      if (made === null || typeof made === "string") {
        setTake({ line, words: made ?? words });
        return false;
      }
      changeRule(ruleOf(line), (rules) => {
        const again = apply(typed, rules);
        return again === null || typeof again === "string" ? rules : again;
      });
      return true;
    };
  const takeFor = (line: Line) => (take?.line === line ? take.words : null);

  const quietTime = (end: "from" | "to") =>
    field("quietHours", CLOCK_TAKES, (typed, rules) => {
      const clock = readClock(typed);
      if (clock === null) return null;
      const other = end === "from" ? rules.quietHours.to : rules.quietHours.from;
      if (clock === other) return SAME_TIMES;
      return { ...rules, quietHours: { ...rules.quietHours, [end]: clock } };
    });

  return (
    <SectionCard title='Time rules'>
      <div className='px-6 pb-6'>
        <ul data-part='rules' aria-label='Time rules' className='flex flex-col'>
          <RuleRow
            name={RULE_NAMES.longWait}
            on={longWait.on}
            onSwitch={(on) =>
              changeRule("longWait", (rules) => ({ ...rules, longWait: { ...rules.longWait, on } }))
            }
          >
            <SetTo take={takeFor("longWait")}>
              <span>After</span>
              <CommitField
                label='Minutes of waiting before the reminder'
                value={String(longWait.minutes)}
                onCommit={field("longWait", MINUTES_TAKE, (typed, rules) => {
                  const minutes = readMinutes(typed);
                  return minutes === null
                    ? null
                    : { ...rules, longWait: { ...rules.longWait, minutes } };
                })}
                className='w-16'
              />
              <span>{longWait.minutes === 1 ? "minute" : "minutes"} of waiting</span>
            </SetTo>
            <div className='flex items-center justify-between gap-6'>
              <span aria-hidden>{REMIND_AGAIN}</span>
              <SegmentedControl
                label={REMIND_AGAIN}
                value={repeat.on ? "on" : "off"}
                onValueChange={(value) =>
                  changeRule("longWait", (rules) => ({
                    ...rules,
                    longWait: withRepeat(rules.longWait, { on: value === "on" }),
                  }))
                }
                options={SWITCH}
                className='shrink-0'
              />
            </div>
            {repeat.on && (
              <SetTo take={takeFor("repeat")}>
                <span>Every</span>
                <Together>
                  <CommitField
                    label='Minutes between reminders'
                    value={String(repeat.minutes)}
                    onCommit={field("repeat", REPEAT_TAKE, (typed, rules) => {
                      const minutes = readRepeatMinutes(typed);
                      return minutes === null
                        ? null
                        : { ...rules, longWait: withRepeat(rules.longWait, { minutes }) };
                    })}
                    className='w-16'
                  />
                  <span>minutes</span>
                </Together>
              </SetTo>
            )}
          </RuleRow>

          <RuleRow
            name={RULE_NAMES.idle}
            on={idle.on}
            onSwitch={(on) =>
              changeRule("idle", (rules) => ({ ...rules, idle: { ...rules.idle, on } }))
            }
          >
            <SetTo take={takeFor("idle")}>
              <span>After</span>
              <Together>
                {/* Three digits at most, so the unit and "idle" stay beside it at 375. */}
                <CommitField
                  label={idleUnit === "days" ? "Days idle before stale" : "Hours idle before stale"}
                  value={String(idleValue)}
                  onCommit={field("idle", IDLE_TAKES, (typed, rules) => {
                    const hours = readIdleHours(typed, idleUnit);
                    return hours === null ? null : { ...rules, idle: { ...rules.idle, hours } };
                  })}
                  className='w-14'
                />
                <SegmentedControl
                  label='Idle for'
                  value={idleUnit}
                  onValueChange={(next) => {
                    // Only how it is shown: the hours in force stay as they are.
                    if (next === "days" && idle.hours % 24 !== 0) {
                      setUnit("hours");
                      setTake({ line: "idle", words: notWholeDays(idle.hours) });
                      return;
                    }
                    setUnit(next);
                    setTake((was) => (was?.line === "idle" ? null : was));
                  }}
                  options={UNITS}
                  className='shrink-0'
                />
                <span>idle</span>
              </Together>
            </SetTo>
          </RuleRow>

          <RuleRow
            name={RULE_NAMES.quietHours}
            on={quietHours.on}
            onSwitch={(on) =>
              changeRule("quietHours", (rules) => ({
                ...rules,
                quietHours: { ...rules.quietHours, on },
              }))
            }
          >
            <SetTo take={takeFor("quietHours")}>
              <span>From</span>
              <CommitField
                label='Quiet from'
                value={quietHours.from}
                onCommit={quietTime("from")}
                className='w-20'
              />
              <span>to</span>
              <CommitField
                label='Quiet until'
                value={quietHours.to}
                onCommit={quietTime("to")}
                className='w-20'
              />
            </SetTo>
            {/* Said to a screen reader when quiet hours begin or end. */}
            <p data-part='quiet-now' role='status' className='empty:hidden'>
              {quietNow ? quietNowLine(quietHours.to) : null}
            </p>
            <div
              role='group'
              aria-labelledby={daysLabel}
              className='flex flex-wrap items-center gap-x-3 gap-y-2'
            >
              <span id={daysLabel} className='max-mid:basis-full'>
                Beginning on
              </span>
              {WEEKDAYS.map((day) => (
                <label
                  key={day}
                  className='inline-flex cursor-pointer items-center gap-1.5 text-ink'
                >
                  <Checkbox
                    checked={quietHours.days.includes(day)}
                    onCheckedChange={(ticked) =>
                      changeRule("quietHours", (rules) => ({
                        ...rules,
                        quietHours: {
                          ...rules.quietHours,
                          days: withDay(rules.quietHours.days, day, ticked),
                        },
                      }))
                    }
                    aria-label={WEEKDAY_NAME[day]}
                  />
                  <span aria-hidden>{WEEKDAY_LABEL[day]}</span>
                </label>
              ))}
            </div>
            {quietHours.days.length === 0 && <p>No day is ticked, so quiet hours never begin.</p>}
            <div className='flex items-center justify-between gap-6'>
              <span aria-hidden>{LEAVE_OUT}</span>
              <SegmentedControl
                label={LEAVE_OUT}
                value={quietHours.leaveOutAnswered ? "on" : "off"}
                onValueChange={(value) =>
                  changeRule("quietHours", (rules) => ({
                    ...rules,
                    quietHours: { ...rules.quietHours, leaveOutAnswered: value === "on" },
                  }))
                }
                options={SWITCH}
                className='shrink-0'
              />
            </div>
          </RuleRow>
        </ul>

        {refused !== null && (
          <Callout title='The time rules could not be changed' className='mt-3'>
            <p>
              <FactText>{refused}</FactText>
            </p>
          </Callout>
        )}
        {refused === null && reading.problem !== null && (
          <Callout title='The settings file could not be read' className='mt-3'>
            <p>
              <FactText>{reading.problem}</FactText>
            </p>
          </Callout>
        )}

        <p className='mt-3 text-body text-ink-secondary'>
          A reminder goes by each channel that is on for waits: a notification, an email, a webhook
          post or a push to your phone. It says how long the session has waited, as in
          “checkout-flow has waited 10 minutes for permission”. It goes once per wait, and with
          Remind again on, again every so many minutes while the session still waits. None goes once
          the wait is answered or the session ends.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          A session idle longer than the idle rule says is stale, and a Claude Code session among
          them whose process still runs is listed under Left running. With the rule off, that is a
          day.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          During quiet hours no notification, email, post or push goes. When they end, a session
          still waiting is notified as usual, and everything else comes as one summary on each
          channel. Hours that run past midnight belong to the day they begin.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          <FactText>
            {`Agent Lookout keeps these in ${reading.file}, so they hold with no dashboard open. The switches under Notifications, and the email, webhook, ntfy and Pushover settings, still choose what is sent.`}
          </FactText>
        </p>
      </div>
    </SectionCard>
  );
}
