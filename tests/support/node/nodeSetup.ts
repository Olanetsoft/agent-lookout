// Runs before every unit and integration test file. A collector built from
// `process.env`, as one built without an environment of its own is, keeps its
// history in memory only, so no test writes to the history folder of the person
// running the tests. A test of the history passes a folder of its own.
//
// It also never asks gh for pull requests, whatever the shell running the tests
// has set: a test of pull requests passes an environment of its own, with a
// stand-in gh, so no test reaches the real gh or GitHub.

process.env.AGENT_LOOKOUT_HISTORY = "off";
process.env.AGENT_LOOKOUT_PULL_REQUESTS = "off";

// Nor does one open the socket in `~/.agent-lookout` that answers permission
// prompts. A test of answering names a socket of its own.
process.env.AGENT_LOOKOUT_ANSWER = "off";
