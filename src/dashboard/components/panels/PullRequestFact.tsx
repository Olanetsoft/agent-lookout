import type { PullRequest } from "@core/sessions/session";
import { FactRow } from "@dashboard/components/ui/facts/FactRow";
import { Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { pullRequestLine } from "@dashboard/lib/pull-requests/pullRequestWords";

/**
 * A branch's pull request, as a fact of a session's details: its number and
 * title, a link that opens it on github.com in the browser, and under them its
 * state and how its checks stand, "Open, 2 checks failing, 4 passing".
 *
 * The title is text someone wrote on GitHub. The collector cleans and cuts it
 * as a session's name, and it is shown as plain text, wrapping anywhere and
 * cut at two lines, as the note of the Status fact is, with the whole of it in
 * the link's tooltip while it is cut. The link's address is the one the
 * collector built from the repository and the number, which the page takes in
 * no other shape. A link that leaves the page opens in a new tab, and in the
 * Mac app in the default browser.
 *
 * Nothing about it is warm: a failing check is not a session waiting on the
 * person, and failure has no colour of its own.
 */
export function PullRequestFact({ pullRequest }: { pullRequest: PullRequest }) {
  return (
    <FactRow label='Pull request'>
      <Truncated
        data-part='pull-request'
        href={pullRequest.url}
        target='_blank'
        rel='noreferrer noopener'
        lines={2}
        tooltip={`#${pullRequest.number} ${pullRequest.title}`}
        className='wrap-anywhere underline decoration-rule-strong underline-offset-2 transition-colors duration-120 hover:decoration-ink'
      >
        <span className='tabular-nums'>#{pullRequest.number}</span> {pullRequest.title}
      </Truncated>
      <span
        data-part='pull-request-state'
        className='block text-caption font-normal text-ink-secondary tabular-nums'
      >
        {pullRequestLine(pullRequest)}
      </span>
    </FactRow>
  );
}
