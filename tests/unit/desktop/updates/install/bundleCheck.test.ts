import { describe, expect, test } from "vitest";

import { readInfoPlist } from "@desktop/updates/install/bundleCheck";

/** An `Info.plist` laid out as electron-builder writes one, cut to a few keys. */
function plist(entries: Record<string, string>): string {
  const body = Object.entries(entries)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDisplayName</key>
    <string>Agent Lookout</string>
${body}
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
  </dict>
</plist>
`;
}

describe("readInfoPlist", () => {
  test("reads the bundle's identifier and its version", () => {
    expect(
      readInfoPlist(
        plist({
          CFBundleIdentifier: "dev.agentlookout.app",
          CFBundleShortVersionString: "0.2.1",
          CFBundleVersion: "0.2.1",
        }),
      ),
    ).toEqual({ identifier: "dev.agentlookout.app", version: "0.2.1" });
  });

  test("undoes XML's escapes", () => {
    expect(
      readInfoPlist(
        plist({ CFBundleIdentifier: "dev.example.a&amp;b", CFBundleShortVersionString: "1.0.0" }),
      )?.identifier,
    ).toBe("dev.example.a&b");
  });

  test("gives nothing when either is missing, or the text is not a plist", () => {
    expect(readInfoPlist(plist({ CFBundleIdentifier: "dev.agentlookout.app" }))).toBeNull();
    expect(readInfoPlist(plist({ CFBundleShortVersionString: "0.2.1" }))).toBeNull();
    expect(readInfoPlist("CFBundleIdentifier dev.agentlookout.app")).toBeNull();
    expect(readInfoPlist("")).toBeNull();
  });

  test("does not take a key's name for its value", () => {
    expect(
      readInfoPlist(
        plist({ CFBundleShortVersionString: "0.2.1", OtherKey: "<key>CFBundleIdentifier</key>" }),
      ),
    ).toBeNull();
  });
});
