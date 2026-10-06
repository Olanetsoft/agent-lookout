import type { GitHead } from "@core/sessions/session";
import { Tooltip } from "@dashboard/components/ui/surfaces/Tooltip";
import {
  failingChecksWords,
  marksFailingChecks,
} from "@dashboard/lib/pull-requests/pullRequestWords";
import { cn } from "@dashboard/lib/utils";

/**
 * The mark beside a branch whose pull request is open, or a draft, and has a
 * check failing, in the Sessions list and on the board: a small cross in
 * `--status-finished`, the shape and colour of a failed session's mark, and
 * smaller, so it never outranks the session's own status. Failure has no
 * colour of its own, so it is told by its shape, its place after the branch
 * and its words, and nothing about it is warm. A pull request that was merged
 * or closed, or whose checks pass or have not finished, has no mark.
 *
 * It is a Tab stop, and its tooltip, which opens on hover and on focus, says
 * which pull request and how its checks stand: "Pull request #51: 2 checks
 * failing, 4 passing". A screen reader reads the same after the branch. A
 * click on it opens its tooltip, not the session's details.
 */
export function ChecksMark({ git, className }: { git: GitHead; className?: string }) {
  const pullRequest = git.pullRequest;
  if (!marksFailingChecks(pullRequest)) return null;
  const words = `Pull request ${failingChecksWords(pullRequest)}`;
  return (
    <Tooltip content={words}>
      <span
        data-part='checks'
        tabIndex={0}
        className={cn(
          "inline-flex shrink-0 items-center self-center rounded-bar text-status-finished",
          className,
        )}
      >
        <svg
          data-slot='checks-mark'
          viewBox='0 0 12 12'
          fill='none'
          stroke='currentColor'
          aria-hidden
          className='size-3'
        >
          <path d='M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6' strokeWidth='1.6' strokeLinecap='round' />
        </svg>
        {/* Read after the branch: "on branch checkout-flow, pull request #51: 2 checks failing". */}
        <span className='sr-only'>, pull request {failingChecksWords(pullRequest)}</span>
      </span>
    </Tooltip>
  );
}
