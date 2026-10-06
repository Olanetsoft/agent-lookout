// Runs before every unit and integration test file. A collector built from
// `process.env`, as one built without an environment of its own is, keeps its
// history in memory only, so no test writes to the history folder of the person
// running the tests. A test of the history passes a folder of its own.

process.env.AGENT_LOOKOUT_HISTORY = "off";
