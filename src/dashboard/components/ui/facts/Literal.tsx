import { Fragment, type ComponentProps, type ReactNode } from "react";

/**
 * A path's parts, each with the slashes after it: "~/.claude/sessions" is
 * "~/.claude/" and "sessions". A part with no letter or figure in it, such as
 * the "/" at the start of "/tmp" or the "~/" of a home folder, stays with the
 * part after it, so no line ends on a slash alone.
 */
function pathParts(token: string): string[] {
  const parts: string[] = [];
  let held = "";
  for (const part of token.match(/[^/\\]+[/\\]*|[/\\]+/g) ?? []) {
    if (/[\p{L}\p{N}]/u.test(part)) {
      parts.push(held + part);
      held = "";
    } else {
      held += part;
    }
  }
  if (held !== "") parts.push(held);
  return parts;
}

/**
 * A literal string in the mono, a command, a path or a variable, that a line
 * breaks only where the string itself has a break: between its words, and in
 * a path after a slash. A flag is never split at its hyphens, so
 * `claude agents --json --all` never shows "-all" on a line of its own, and a
 * folder never at a hyphen in its name.
 *
 * Each word is a box of its own as wide as it is, and moves to the next line
 * whole. Only a word longer than a whole line breaks inside itself, rather
 * than run past its card. The spaces between the words stay as they were
 * given, so the string reads and copies exactly as it is. Set it inside an
 * element that sets the mono.
 */
export function Literal({
  children,
  ...props
}: Omit<ComponentProps<"span">, "children"> & { children: string }) {
  const pieces: ReactNode[] = [];
  children.split(/(\s+)/).forEach((token, index) => {
    if (token === "") return;
    if (/^\s+$/.test(token)) {
      pieces.push(token);
      return;
    }
    const parts = pathParts(token);
    parts.forEach((part, at) => {
      pieces.push(
        <Fragment key={`${index}-${at}`}>
          <span data-part='word' className='inline-block max-w-full wrap-anywhere'>
            {part}
          </span>
          {at < parts.length - 1 && <wbr />}
        </Fragment>,
      );
    });
  });
  return (
    <span data-slot='literal' {...props}>
      {pieces}
    </span>
  );
}
