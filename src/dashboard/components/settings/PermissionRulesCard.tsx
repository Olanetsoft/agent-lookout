import { ArrowDown, ArrowUp } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { RuleAnswer } from "@core/api";
import {
  RULE_DECISIONS,
  ruleText,
  type PermissionRule,
  type RuleDecision,
} from "@core/permission-rules/permissionRules";
import type { AnsweringStatus } from "@core/sessions/session";
import { Button } from "@dashboard/components/ui/controls/Button";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { TextField } from "@dashboard/components/ui/controls/TextField";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { Literal } from "@dashboard/components/ui/facts/Literal";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { Badge } from "@dashboard/components/ui/status/Badge";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { Tooltip, Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useNow } from "@dashboard/hooks/data/useNow";
import {
  usePermissionRules,
  type RulesChangeFrom,
  type RulesChangeTaken,
} from "@dashboard/hooks/settings/usePermissionRules";
import { clockAt, formatClock, formatFullTime, startOfDay } from "@dashboard/lib/format";
import type { RulesChangeAsked } from "@dashboard/lib/permission-rules/permissionRulesApi";
import {
  answerLead,
  DECISION_LABEL,
  decisionSentence,
  EMPTY_FORM,
  formOf,
  forEveryTool,
  readForm,
  ruleName,
  type RuleForm,
} from "@dashboard/lib/permission-rules/ruleWords";

const DECISIONS = RULE_DECISIONS.map((value) => ({ value, label: DECISION_LABEL[value] }));

/** A literal string in a sentence: a command or a rule, in the mono. */
function Code({ children }: { children: string }) {
  return (
    <code data-slot='fact' className='font-mono text-fact'>
      <Literal>{children}</Literal>
    </code>
  );
}

/**
 * A part of the card, headed as a session's details head theirs: its name in
 * `text-body` at 600 over a hairline, with a quiet word at the right.
 */
function Part({
  title,
  aside,
  first = false,
  children,
  ...data
}: {
  title: string;
  aside?: ReactNode;
  /** The first part, which sits right under the head, or 12px under a note. */
  first?: boolean;
  children: ReactNode;
  "data-part": string;
}) {
  return (
    <section {...data} aria-label={title} className={first ? undefined : "mt-6"}>
      <div className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hairline pb-2'>
        <h3 className='text-body font-semibold text-ink'>{title}</h3>
        {aside !== undefined && <p className='text-caption text-ink-muted'>{aside}</p>}
      </div>
      {children}
    </section>
  );
}

/** A rule as it reads: Claude Code's own way of writing one, in the mono, or "Every tool" in words. */
function RuleShown({ rule }: { rule: Pick<PermissionRule, "tool" | "command"> }) {
  const text = ruleText(rule);
  if (text === null) return <span className='text-body text-ink'>Every tool</span>;
  return (
    <code data-part='rule-text' className='min-w-0 font-mono text-fact text-ink'>
      <Literal>{text}</Literal>
    </code>
  );
}

/** A quiet round button with an arrow, its name in a tooltip. */
function MoveButton({
  to,
  rule,
  first,
  last,
  onMove,
}: {
  to: "up" | "down";
  rule: PermissionRule;
  first: boolean;
  last: boolean;
  onMove: (rule: PermissionRule, to: "up" | "down") => void;
}) {
  const word = to === "up" ? "Move up" : "Move down";
  // At the end of the list it cannot move that way, but keeps its place and its focus.
  const stuck = to === "up" ? first : last;
  return (
    <Tooltip content={word}>
      <Button
        size='icon'
        data-action={to}
        aria-label={`${word}: ${ruleName(rule)}`}
        aria-disabled={stuck || undefined}
        onClick={() => {
          if (!stuck) onMove(rule, to);
        }}
        className='aria-disabled:cursor-default aria-disabled:opacity-50'
      >
        {to === "up" ? (
          <ArrowUp aria-hidden className='size-3.5' strokeWidth={1.75} />
        ) : (
          <ArrowDown aria-hidden className='size-3.5' strokeWidth={1.75} />
        )}
      </Button>
    </Tooltip>
  );
}

/** One request a rule answered: the session and the time, then what was done and by which rule. */
function AnswerRow({ answer, now }: { answer: RuleAnswer; now: number }) {
  const text = forEveryTool(answer.rule) ? null : ruleText(answer.rule);
  return (
    <li data-part='rule-answer' className='border-b border-hairline py-2 last:border-b-0'>
      <div className='flex items-baseline justify-between gap-3'>
        <Truncated className='min-w-0 text-body font-semibold text-ink'>
          {answer.sessionName}
        </Truncated>
        <Tooltip content={formatFullTime(answer.at)} mono align='end'>
          <time
            dateTime={new Date(answer.at).toISOString()}
            className='shrink-0 rounded-bar font-mono text-caption text-ink-muted'
          >
            {startOfDay(answer.at) === startOfDay(now)
              ? formatClock(answer.at)
              : clockAt(answer.at, now)}
          </time>
        </Tooltip>
      </div>
      <p className='mt-0.5 text-caption text-ink-secondary'>
        {answerLead(answer)}
        {text !== null && (
          <>
            {" "}
            <Code>{text}</Code>
          </>
        )}
      </p>
    </li>
  );
}

/** Says why no rule is used now, when permission prompts are not answered from here at all. */
function notUsedLine(answering: AnsweringStatus | null): string | null {
  if (answering === null || answering.state === "on") return null;
  if (answering.state === "off") {
    return "AGENT_LOOKOUT_ANSWER is off, so no permission prompt is answered from here, by hand or by a rule.";
  }
  return "Permission prompts cannot be answered from here now, so no rule answers one. Permission prompts, above, says why.";
}

interface PermissionRulesCardProps {
  /** Whether permission prompts can be answered from here, as the sessions' answer says. Null before it. */
  answering?: AnsweringStatus | null;
  now?: number;
}

/**
 * Permission rules, in Settings: an ordered list of rules that answer a
 * Claude Code permission prompt for the person, allow, ask or deny, by tool
 * and for Bash by command, with buttons to move each up and down, edit and
 * remove it, a form that adds or edits one, and the requests the rules
 * answered since Agent Lookout started.
 *
 * Every change is one request to the app, which checks the rule again, saves
 * the list and answers with it, so the card shows what the app holds; a
 * change it did not take does not look taken, and says why where it was
 * asked: an info note above the rules for a rule's own buttons, the line
 * under the form's buttons for the form. The page's own check of a rule is
 * only there to help, with the same sentences.
 * With no rule, nothing is answered on its own. Nothing in it is warm.
 */
export function PermissionRulesCard({ answering = null, now: given }: PermissionRulesCardProps) {
  const ticking = useNow();
  const now = given ?? ticking;
  const { reading, refused, change } = usePermissionRules();
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  /** The rule the form edits, or null while it adds one. */
  const [editing, setEditing] = useState<string | null>(null);
  /** What the page's check found, or what came of the form's last change. */
  const [take, setTake] = useState<string | null>(null);
  /** What a move or a removal came to, for assistive technology. */
  const [said, setSaid] = useState("");
  const busy = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const toolRef = useRef<HTMLInputElement>(null);
  const ids = { tool: useId(), command: useId(), decision: useId() };

  if (reading === null || reading === "unknown") {
    return (
      <SectionCard title='Permission rules'>
        <div data-slot='permission-rules-card' className='px-6 pb-6'>
          <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
            {reading === null ? null : "The permission rules could not be read."}
          </p>
        </div>
      </SectionCard>
    );
  }

  const rules = reading.permissionRules;
  const answers = reading.ruleAnswers;
  const notUsed = notUsedLine(answering);

  /** Puts focus on one button of a rule's row, once the list has been drawn again. */
  const focusOn = (id: string, action: string) => {
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector(`[data-rule-id="${CSS.escape(id)}"]`);
      row?.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus();
    });
  };

  /**
   * Sends one change, one at a time: a press while one is on its way is not
   * taken, and comes to null.
   */
  const send = async (
    asked: RulesChangeAsked,
    from: RulesChangeFrom = "list",
  ): Promise<RulesChangeTaken | null> => {
    if (busy.current) return null;
    busy.current = true;
    try {
      return await change(asked, from);
    } finally {
      busy.current = false;
    }
  };

  const move = async (rule: PermissionRule, to: "up" | "down") => {
    if ((await send({ move: { id: rule.id, to } }))?.taken) {
      setSaid(`${ruleName(rule)} moved ${to}.`);
      focusOn(rule.id, to);
    }
  };

  const remove = async (rule: PermissionRule) => {
    const at = rules.findIndex((listed) => listed.id === rule.id);
    const next = rules[at + 1] ?? rules[at - 1];
    if ((await send({ remove: { id: rule.id } }))?.taken) {
      setSaid(`${ruleName(rule)} removed.`);
      if (editing === rule.id) {
        setEditing(null);
        setForm(EMPTY_FORM);
      }
      if (next) focusOn(next.id, "remove");
      else requestAnimationFrame(() => titleRef.current?.focus());
    }
  };

  const edit = (rule: PermissionRule) => {
    setEditing(rule.id);
    setForm(formOf(rule));
    setTake(null);
    requestAnimationFrame(() => toolRef.current?.focus());
  };

  const stopEditing = () => {
    const id = editing;
    setEditing(null);
    setForm(EMPTY_FORM);
    setTake(null);
    if (id !== null) focusOn(id, "edit");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readForm(form);
    if (!read.ok) {
      setTake(read.problem);
      return;
    }
    const id = editing;
    const sent = await send(
      id === null ? { add: read.words } : { edit: { id, ...read.words } },
      "form",
    );
    if (sent === null) return;
    // Said here, under the buttons, where the person is looking, and the form keeps what they typed.
    if (!sent.taken) {
      setTake(sent.problem);
      return;
    }
    setForm({ ...EMPTY_FORM, decision: read.words.decision });
    setEditing(null);
    setTake(id === null ? `Added ${ruleName(read.words)}.` : `Saved ${ruleName(read.words)}.`);
    if (id !== null) focusOn(id, "edit");
  };

  /** Any typing puts away what the check last said. */
  const typed = (next: Partial<RuleForm>) => {
    setForm((was) => ({ ...was, ...next }));
    setTake(null);
  };

  return (
    <SectionCard title='Permission rules' count={rules.length} titleRef={titleRef}>
      <div data-slot='permission-rules-card' className='px-6 pb-6'>
        {notUsed !== null && (
          <Callout title='No rule is used now' className='mb-3'>
            <p>
              <FactText>{notUsed}</FactText>
            </p>
          </Callout>
        )}
        {refused !== null && (
          <Callout title='The permission rules could not be changed' className='mb-3'>
            <p>
              <FactText>{refused}</FactText>
            </p>
          </Callout>
        )}
        {refused === null && reading.permissionRulesProblem !== null && (
          <Callout title='The settings file could not be used' className='mb-3'>
            <p>
              <FactText>{reading.permissionRulesProblem}</FactText>
            </p>
          </Callout>
        )}

        <Part data-part='rules' title='Rules' aside='deny, then ask, then allow' first>
          {rules.length === 0 ? (
            <p className='mt-3 text-body text-ink-secondary'>
              No rule yet, so every permission prompt waits for you.
            </p>
          ) : (
            <ol ref={listRef} aria-label='Permission rules, in order' className='flex flex-col'>
              {rules.map((rule, index) => (
                <li
                  key={rule.id}
                  data-part='rule'
                  data-rule-id={rule.id}
                  className='border-b border-hairline py-2.5 last:border-b-0'
                >
                  <p className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
                    <Badge data-part='decision' className='self-center'>
                      {DECISION_LABEL[rule.decision]}
                    </Badge>
                    <RuleShown rule={rule} />
                  </p>
                  <div className='mt-2 flex flex-wrap items-center gap-2'>
                    <MoveButton
                      to='up'
                      rule={rule}
                      first={index === 0}
                      last={index === rules.length - 1}
                      onMove={(moved, to) => void move(moved, to)}
                    />
                    <MoveButton
                      to='down'
                      rule={rule}
                      first={index === 0}
                      last={index === rules.length - 1}
                      onMove={(moved, to) => void move(moved, to)}
                    />
                    <Button
                      size='sm'
                      data-action='edit'
                      aria-label={`Edit: ${ruleName(rule)}`}
                      onClick={() => edit(rule)}
                    >
                      Edit
                    </Button>
                    <Button
                      size='sm'
                      data-action='remove'
                      aria-label={`Remove: ${ruleName(rule)}`}
                      onClick={() => void remove(rule)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {/* Said to a screen reader when a rule moves or goes. */}
          <p data-part='rules-said' role='status' className='sr-only'>
            {said}
          </p>
        </Part>

        <Part data-part='rule-form' title={editing === null ? "Add a rule" : "Edit the rule"}>
          <form onSubmit={(event) => void submit(event)} className='mt-3 flex flex-col gap-3'>
            <div className='flex flex-col gap-2'>
              <SegmentedControl
                label='Decision'
                value={form.decision}
                onValueChange={(decision: RuleDecision) => typed({ decision })}
                options={DECISIONS}
                className='self-start'
              />
              <p
                id={ids.decision}
                data-part='decision-sentence'
                className='text-body text-ink-secondary'
              >
                {decisionSentence(form)}
              </p>
            </div>
            <div className='flex flex-col gap-1.5'>
              <label htmlFor={ids.tool} className='text-body text-ink-secondary'>
                Tool, as Claude Code names it, or * for every tool
              </label>
              <TextField
                ref={toolRef}
                id={ids.tool}
                value={form.tool}
                placeholder='Bash'
                enterKeyHint='done'
                onChange={(event) => typed({ tool: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && editing !== null) stopEditing();
                }}
                className='w-full max-w-60 text-left'
              />
            </div>
            <div className='flex flex-col gap-1.5'>
              <label htmlFor={ids.command} className='text-body text-ink-secondary'>
                Command, for Bash only: one, or a prefix ending in :*
              </label>
              <TextField
                id={ids.command}
                value={form.command}
                placeholder='npm test:*'
                enterKeyHint='done'
                onChange={(event) => typed({ command: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && editing !== null) stopEditing();
                }}
                className='w-full text-left font-mono text-fact'
              />
            </div>
            <div className='flex flex-wrap items-center gap-3'>
              <Button type='submit' size='sm' data-action='save'>
                {editing === null ? "Add rule" : "Save rule"}
              </Button>
              {editing !== null && (
                <Button size='sm' data-action='cancel' onClick={stopEditing}>
                  Cancel
                </Button>
              )}
            </div>
            {/* Said again to a screen reader when it changes. */}
            <p data-part='take' role='status' className='text-body text-ink-secondary empty:hidden'>
              {take}
            </p>
          </form>
        </Part>

        <Part
          data-part='rule-answers'
          title='Recent automatic answers'
          aside={
            reading.ruleAnswersSince === null
              ? undefined
              : `since ${clockAt(reading.ruleAnswersSince, now)}`
          }
        >
          {answers.length === 0 ? (
            <p className='mt-3 text-body text-ink-secondary'>
              No request was answered by a rule yet.
            </p>
          ) : (
            <ol
              aria-label='Recent automatic answers, newest first'
              tabIndex={0}
              className='thin-scroll flex max-h-60 flex-col overflow-y-auto rounded-bar pr-1'
            >
              {answers.map((answer) => (
                <AnswerRow key={`${answer.sessionId}@${answer.at}`} answer={answer} now={now} />
              ))}
            </ol>
          )}
        </Part>

        <p className='mt-6 text-body text-ink-secondary'>
          A rule answers a permission prompt for you in a Claude Code session with the Agent Lookout
          plugin, the one agent Agent Lookout can answer for. The session can still be seen waiting
          for a moment first, so a notification of that wait may still come.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          Deny goes first, then ask, then allow, as in Claude Code&apos;s own rules.{" "}
          <Code>npm test:*</Code> matches <Code>npm test</Code> and <Code>npm test --watch</Code>,
          not <Code>npm testing</Code>. An allow rule never answers a command with <Code>;</Code>,{" "}
          <Code>&&</Code>, <Code>|</Code>, <Code>$( )</Code>, quotes or a redirection in it. A deny
          or an ask rule finds its words in any command of the line, with options between them, so{" "}
          <Code>git push:*</Code> also holds back <Code>git -C . push</Code>.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          An allow rule trusts what it names. Claude can reach Agent Lookout on this computer, so a
          rule for a program that sends requests, such as <Code>curl</Code>, or that runs a file
          Claude can edit, such as <Code>npm test</Code>, lets Claude change these rules and answer
          its own prompts.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          Claude Code&apos;s own deny and allow rules decide first: Claude Code does not ask Agent
          Lookout about a request they settle. An ask rule there does not hold back an allow rule
          here, since it is what brings the request here.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          <FactText>
            {`Agent Lookout keeps the rules in ${reading.file}. The Events log says what each rule answered, never the command.`}
          </FactText>
        </p>
      </div>
    </SectionCard>
  );
}
