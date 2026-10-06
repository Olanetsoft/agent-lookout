import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { Button } from "@dashboard/components/ui/controls/Button";
import { Tooltip } from "@dashboard/components/ui/surfaces/Tooltip";
import { copyText, type CopyOutcome } from "@dashboard/lib/shell/clipboard";
import { cn } from "@dashboard/lib/utils";

/** How long the button's word says "Copied" after a copy. */
export const COPIED_MS = 2_000;

type CopyButtonProps = Omit<ComponentProps<typeof Button>, "onClick" | "children" | "asChild"> & {
  /** What a press puts on the clipboard. */
  text: string;
  /** The button's word, such as "Resume". */
  children: string;
  /** What a screen reader is told once the text is on the clipboard. */
  copiedSaid: string;
  /** What it is told when the copy was refused. */
  refusedSaid: string;
  /** Told what each press came to, so what draws the button can show the text when it was refused. */
  onCopied?: (outcome: CopyOutcome) => void;
  /** What copies. Defaults to the clipboard. */
  copy?: (text: string) => Promise<CopyOutcome>;
  /** What the button says when pointed at or reached with Tab, such as the text it copies. */
  tooltip?: ReactNode;
  /** Set when the tooltip is a literal string, such as a command. */
  tooltipMono?: boolean;
};

/**
 * A quiet `Button` that puts a text on the clipboard when pressed. For two
 * seconds after, its word reads "Copied", at the width it already had, so
 * nothing beside it moves. A status that only a screen reader meets says
 * what the press came to, and is in the page before there is anything to
 * say, so the change is heard. A second press while one is under way does
 * nothing.
 *
 * It never reads the clipboard. When the copy is refused, its word does not
 * change: it tells what draws it, which leaves the text on the page for the
 * person to select.
 */
export function CopyButton({
  text,
  children,
  copiedSaid,
  refusedSaid,
  onCopied,
  copy = copyText,
  tooltip,
  tooltipMono = false,
  className,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [said, setSaid] = useState("");
  const underWay = useRef(false);
  const drawn = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    drawn.current = true;
    return () => {
      drawn.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const press = () => {
    if (underWay.current) return;
    underWay.current = true;
    clearTimeout(timer.current);
    // Said again from nothing, so the same words after a second press are heard again.
    setSaid("");
    setCopied(false);
    void copy(text).then((outcome) => {
      underWay.current = false;
      if (!drawn.current) return;
      setSaid(outcome === "copied" ? copiedSaid : refusedSaid);
      if (outcome === "copied") {
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      }
      onCopied?.(outcome);
    });
  };

  const button = (
    <Button
      data-copied={copied || undefined}
      className={cn("inline-grid", className)}
      onClick={press}
      {...props}
    >
      {/* Both words hold the one place, so the button is as wide as the wider. */}
      <span
        aria-hidden={copied || undefined}
        className={cn("col-start-1 row-start-1", copied && "invisible")}
      >
        {children}
      </span>
      <span aria-hidden className={cn("col-start-1 row-start-1", !copied && "invisible")}>
        Copied
      </span>
    </Button>
  );

  return (
    <>
      {tooltip ? (
        <Tooltip content={tooltip} mono={tooltipMono} align='end'>
          {button}
        </Tooltip>
      ) : (
        button
      )}
      {/* A polite live region, as a status is, without a status's role: a list holds many. */}
      <span aria-live='polite' aria-atomic='true' data-part='copy-said' className='sr-only'>
        {said}
      </span>
    </>
  );
}
