import { Literal } from "@dashboard/components/ui/facts/Literal";

/**
 * A command the person types, into Claude Code or a terminal: a literal
 * block of its own, in the mono, so it is read and copied whole. It breaks
 * only where it must, on a phone: between its words, or after a slash.
 */
export function Command({ children }: { children: string }) {
  return (
    <code
      data-slot='fact'
      data-part='command'
      className='block w-fit max-w-full rounded-row bg-fill-zebra px-3 py-1.5 font-mono text-fact text-ink inset-ring inset-ring-hairline select-all wrap-break-word'
    >
      <Literal>{children}</Literal>
    </code>
  );
}
