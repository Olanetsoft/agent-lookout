import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Command, type LucideIcon } from "lucide-react";
import { Fragment } from "react";

import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { DetailsModal } from "@dashboard/components/ui/surfaces/DetailsModal";
import { onMac, shortcutGroups, type Key } from "@dashboard/lib/shell/shortcuts";

/** Signs drawn as icons: as characters they come out smaller and thinner than the words beside them. */
const SIGNS: Record<string, LucideIcon> = {
  "⌘": Command,
  "↑": ArrowUp,
  "↓": ArrowDown,
  "←": ArrowLeft,
  "→": ArrowRight,
};

/** A key as it is drawn: its signs as icons and the rest as letters. */
function Shown({ shown }: { shown: string }) {
  return shown
    .split(/([⌘↑↓←→])/)
    .filter(Boolean)
    .map((part, index) => {
      const Sign = SIGNS[part];
      return Sign ? (
        <Sign
          key={index}
          aria-hidden
          data-sign={part}
          strokeWidth={1.75}
          className='inline-block size-3.5'
        />
      ) : (
        part
      );
    });
}

/** Keys any one of which does the same thing: "/ or ⌘K", each key in the mono as the literal it is. */
function Keys({ keys }: { keys: readonly Key[] }) {
  return (
    <>
      {keys.map((key, index) => (
        <Fragment key={key.shown}>
          {index > 0 && <span className='font-normal text-ink-secondary'> or </span>}
          {key.said ? (
            <kbd className='font-mono text-fact whitespace-nowrap'>
              <span aria-hidden>
                <Shown shown={key.shown} />
              </span>
              <span className='sr-only'>{key.said}</span>
            </kbd>
          ) : (
            <kbd className='font-mono text-fact whitespace-nowrap'>{key.shown}</kbd>
          )}
        </Fragment>
      ))}
    </>
  );
}

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The sheet of shortcuts, opened by "?": every key the page answers to, in
 * groups, as rows of facts, what it does on the left and its keys on the
 * right. It is the small history dialog, so it holds focus, closes on Escape
 * and gives focus back to what had it. The search's key is named as this
 * computer names it, ⌘K on a Mac and Ctrl+K elsewhere.
 */
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  const groups = shortcutGroups(onMac());
  return (
    <DetailsModal
      open={open}
      onOpenChange={onOpenChange}
      title='Keyboard shortcuts'
      description={
        <>
          <kbd className='font-mono text-fact'>/</kbd> and{" "}
          <kbd className='font-mono text-fact'>?</kbd> work wherever you are not typing.
        </>
      }
      size='sm'
    >
      <div data-slot='shortcuts' className='mt-2'>
        {groups.map((group) => (
          <div key={group.title} data-part='group' className='mt-4'>
            <h3 className='text-caption font-semibold text-ink-secondary'>{group.title}</h3>
            <FactList className='mt-0.5'>
              {group.rows.map((row) => (
                <FactRow key={row.does} label={row.does}>
                  <Keys keys={row.keys} />
                </FactRow>
              ))}
            </FactList>
          </div>
        ))}
      </div>
    </DetailsModal>
  );
}
