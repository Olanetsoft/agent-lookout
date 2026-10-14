import { expect, test } from "vitest";

import {
  APP_PLUGIN_INSTALL_PATH,
  APP_PLUGIN_INSTALL_TOLD_ACTION,
  APP_PLUGIN_INSTALL_TOLD_PATH,
  commandLine,
  isPluginInstallPath,
  isPluginInstallStep,
  MARKETPLACE_ADD_ARGS,
  PLUGIN_ID,
  PLUGIN_INSTALL_ARGS,
  PLUGIN_LIST_ARGS,
  PLUGIN_MARKETPLACE,
  PLUGIN_UNINSTALL_ARGS,
} from "@core/answers/pluginInstall";

test("the plugin is the one in this repository's marketplace", () => {
  expect(PLUGIN_ID).toBe("agent-lookout@agent-lookout");
  expect(PLUGIN_MARKETPLACE).toBe("Olanetsoft/agent-lookout");
});

test("the commands are Claude Code's own, with fixed arguments and nothing else", () => {
  expect(PLUGIN_LIST_ARGS).toEqual(["plugin", "list"]);
  expect(MARKETPLACE_ADD_ARGS).toEqual([
    "plugin",
    "marketplace",
    "add",
    "Olanetsoft/agent-lookout",
  ]);
  expect(PLUGIN_INSTALL_ARGS).toEqual(["plugin", "install", "agent-lookout@agent-lookout"]);
  expect(PLUGIN_UNINSTALL_ARGS).toEqual(["plugin", "uninstall", "agent-lookout@agent-lookout"]);
});

test("each command is shown as a person types it in a terminal", () => {
  expect(commandLine(MARKETPLACE_ADD_ARGS)).toBe(
    "claude plugin marketplace add Olanetsoft/agent-lookout",
  );
  expect(commandLine(PLUGIN_INSTALL_ARGS)).toBe(
    "claude plugin install agent-lookout@agent-lookout",
  );
  expect(commandLine(PLUGIN_UNINSTALL_ARGS)).toBe(
    "claude plugin uninstall agent-lookout@agent-lookout",
  );
});

test("the routes are under the app's own addresses", () => {
  expect(APP_PLUGIN_INSTALL_PATH).toBe("/api/app/claude-plugin");
  expect(APP_PLUGIN_INSTALL_TOLD_PATH).toBe("/api/app/claude-plugin/told");
  expect(APP_PLUGIN_INSTALL_TOLD_ACTION).toBe("plugin-install-told");
});

test.each([
  ["/api/app/claude-plugin", true],
  ["/api/app/claude-plugin/told", true],
  ["/api/app/claude-plugin/other", true],
  ["/api/app/claude-pluginx", false],
  ["/api/app", false],
  ["/api/app/update", false],
  ["", false],
])("%s belongs to the plugin install's routes: %s", (pathname, belongs) => {
  expect(isPluginInstallPath(pathname)).toBe(belongs);
});

test("a step is one of the five, and nothing else", () => {
  for (const step of ["check", "marketplace", "install", "confirm", "unfinished"]) {
    expect(isPluginInstallStep(step)).toBe(true);
  }
  for (const value of ["", "Check", "list", null, undefined, 1, {}]) {
    expect(isPluginInstallStep(value)).toBe(false);
  }
});
