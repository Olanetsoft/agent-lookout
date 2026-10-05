import type { GitHead } from "@core/sessions/session";
import { Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { cn } from "@dashboard/lib/utils";

interface BranchProps {
  git: GitHead;
  /**
   * Set where it is part of a sentence, as in the hero: "storefront on
   * checkout-flow". Left out, the word before it is for a screen reader only.
   */
  inSentence?: boolean;
  /** For the branch or the commit itself. */
  className?: string;
}

/**
 * What a session's folder has checked out, as the Sessions table and the hero
 * show it: the branch in the sans, a word like the folder's name, or, with no
 * branch checked out, the short ID of the commit in the mono, a string read
 * character by character. A long branch is cut, and stays a hover or a Tab
 * away, as a long name does.
 *
 * It is read as "on branch checkout-flow" or "at commit 3f9a2c1".
 */
export function Branch({ git, inSentence = false, className }: BranchProps) {
  const branch = git.branch;
  if (branch === undefined && git.commit === undefined) return null;
  const word = branch !== undefined ? "on" : "at";
  const kind = branch !== undefined ? "branch" : "commit";
  return (
    <>
      {inSentence ? (
        <>
          {word} <span className='sr-only'>{kind} </span>
        </>
      ) : (
        <span className='sr-only'>
          {word} {kind}{" "}
        </span>
      )}
      {branch !== undefined ? (
        <Truncated data-part='branch' className={className}>
          {branch}
        </Truncated>
      ) : (
        <span data-part='commit' className={cn("font-mono text-fact", className)}>
          {git.commit}
        </span>
      )}
    </>
  );
}
