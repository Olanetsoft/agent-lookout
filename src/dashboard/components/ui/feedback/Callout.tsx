import { CircleAlert, Info } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@dashboard/lib/utils";

/**
 * Neither tone is warm. The lamp's colour belongs to a session that needs the
 * person, so a failure is told apart by its edge, its icon and its role instead.
 */
const TONES = {
  info: {
    box: "bg-fill-quiet inset-ring inset-ring-hairline",
    icon: "text-ink-muted",
    Icon: Info,
  },
  error: {
    // The 3px ink edge runs down the leading side, inside the stronger rule.
    box: "bg-fill-selected inset-ring inset-ring-rule-strong shadow-edge",
    icon: "text-ink",
    Icon: CircleAlert,
  },
} as const;

interface CalloutProps {
  tone?: keyof typeof TONES;
  title: string;
  /** What happened and what to do about it. */
  children?: ReactNode;
  /** A button on the right. */
  action?: ReactNode;
  className?: string;
}

/**
 * A boxed message, laid on the glass as a fill inside a rule, with 14px corners.
 * The info tone is a quiet note: the quiet fill inside a hairline. The error
 * tone is the error presentation: the selected fill inside the strong rule, with
 * an ink edge down its leading side and the alert icon, announced as an alert,
 * so a failure can never be mistaken for the spinner of `Loading` or the centred
 * words of `EmptyState`.
 */
export function Callout({ tone = "info", title, children, action, className }: CalloutProps) {
  const { box, icon, Icon } = TONES[tone];
  return (
    <div
      data-slot='callout'
      data-tone={tone}
      role={tone === "info" ? "status" : "alert"}
      className={cn("flex items-start gap-3 rounded-inner px-4 py-3", box, className)}
    >
      <Icon aria-hidden className={cn("mt-px size-4.5 shrink-0", icon)} strokeWidth={1.75} />
      <div className='min-w-0 flex-1'>
        <p className='text-row font-semibold text-ink'>{title}</p>
        {children && (
          <div className='mt-0.5 text-body wrap-break-word text-ink-secondary'>{children}</div>
        )}
      </div>
      {action && <div className='shrink-0 self-center'>{action}</div>}
    </div>
  );
}
