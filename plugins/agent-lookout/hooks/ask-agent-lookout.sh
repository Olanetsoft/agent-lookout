#!/bin/sh
# Agent Lookout's permission hook for Claude Code.
#
# Claude Code runs this as it is about to ask for permission, with the request
# as JSON on stdin, and draws its own prompt at the same time. This hands the
# request to Agent Lookout on this computer, over the Unix socket Agent
# Lookout listens on, and waits. When the person presses Allow or Deny on the
# dashboard, it prints that answer. When Agent Lookout is not running, lets
# the request go, or anything goes wrong, it prints nothing and exits 0, and
# the prompt in the session decides, as it would without this plugin.
#
# It sends nothing anywhere else, and changes nothing on this computer.

sock="${AGENT_LOOKOUT_ANSWER_SOCKET:-$HOME/.agent-lookout/answer.sock}"
[ -S "$sock" ] || exit 0

# curl gives up before Claude Code would end this hook, which it does at 600
# seconds. Agent Lookout lets a request go well before either.
limit="${AGENT_LOOKOUT_HOOK_MAX_TIME:-580}"
case "$limit" in
  '' | *[!0-9]*) limit=580 ;;
esac

curl=/usr/bin/curl
[ -x "$curl" ] || curl=$(command -v curl) || exit 0

# -q first, so no ~/.curlrc changes what curl does or where it writes.
out=$("$curl" -q --silent --fail --unix-socket "$sock" --connect-timeout 2 --max-time "$limit" \
  -H 'Content-Type: application/json' -H 'X-Agent-Lookout-Hook: permission-request' -H 'Expect:' \
  --data-binary @- http://agent-lookout/hooks/permission-request 2>/dev/null) || exit 0

# Only the two answers Agent Lookout gives, exactly as it gives them, are
# printed: nothing that adds a field, such as a rule to save, gets through.
case "$out" in
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' | \
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The person denied this from Agent Lookout. It was their choice, not a problem with a hook or a setting, so do not look for one. Do not try it again unless they ask."}}}')
    printf '%s\n' "$out"
    ;;
esac
exit 0
