// Runs before every unit and integration test file. A collector built from
// `process.env`, as one built without an environment of its own is, keeps its
// history in memory only, so no test writes to the history folder of the person
// running the tests. A test of the history passes a folder of its own.
//
// It also never asks gh for pull requests, whatever the shell running the tests
// has set: a test of pull requests passes an environment of its own, with a
// stand-in gh, so no test reaches the real gh or GitHub.
//
// And it reads its time rules from a settings file that is not there, so they
// are all off and the settings of the person running the tests change nothing.
// A test that builds its own environment names `NO_SETTINGS_FILE` there too,
// or a file of its own.

import { NO_SETTINGS_FILE } from "@tests/support/node/tempFiles";

process.env.AGENT_LOOKOUT_HISTORY = "off";
process.env.AGENT_LOOKOUT_PULL_REQUESTS = "off";
process.env.AGENT_LOOKOUT_SETTINGS_FILE = NO_SETTINGS_FILE;

// Nor does one open the socket in `~/.agent-lookout` that answers permission
// prompts. A test of answering names a socket of its own.
process.env.AGENT_LOOKOUT_ANSWER = "off";

// Nor does one built from `process.env` push to a phone, whatever the shell
// running the tests has set: a test of ntfy or Pushover passes an environment
// of its own, aimed at a stand-in on 127.0.0.1.
delete process.env.AGENT_LOOKOUT_NTFY_URL;
delete process.env.AGENT_LOOKOUT_NTFY_TOKEN;
delete process.env.AGENT_LOOKOUT_PUSHOVER_TOKEN;
delete process.env.AGENT_LOOKOUT_PUSHOVER_USER;
