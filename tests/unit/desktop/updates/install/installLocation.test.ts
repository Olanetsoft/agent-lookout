import { describe, expect, test } from "vitest";

import { bundleOf, installRefusal } from "@desktop/updates/install/installLocation";

const APP = "/Applications/Agent Lookout.app";

describe("bundleOf", () => {
  test("finds the bundle from the path of its executable", () => {
    expect(bundleOf(`${APP}/Contents/MacOS/Agent Lookout`)).toBe(APP);
    expect(
      bundleOf("/Users/example/Applications/Agent Lookout.app/Contents/MacOS/Agent Lookout"),
    ).toBe("/Users/example/Applications/Agent Lookout.app");
  });

  test.each([
    [
      "a development run's Electron, outside a bundle",
      "/Users/example/code/demo/node_modules/.bin/electron",
    ],
    ["an executable not in Contents/MacOS", `${APP}/Contents/Resources/Agent Lookout`],
    ["a bundle that is not an app", "/Applications/Thing.bundle/Contents/MacOS/Thing"],
    ["a relative path", "Agent Lookout.app/Contents/MacOS/Agent Lookout"],
  ])("finds none for %s", (_what, executable) => {
    expect(bundleOf(executable)).toBeNull();
  });
});

describe("installRefusal", () => {
  const everywhere = () => true;

  test("allows the app in a folder it can change, as in Applications", () => {
    expect(installRefusal(APP, everywhere)).toBeNull();
    expect(installRefusal("/Users/example/Applications/Agent Lookout.app", everywhere)).toBeNull();
  });

  test("refuses a copy macOS runs from App Translocation, which is read-only", () => {
    expect(
      installRefusal(
        "/private/var/folders/xy/abc123/T/AppTranslocation/0A1B2C3D-0000-4000-8000-000000000001/d/Agent Lookout.app",
        everywhere,
      ),
    ).toBe("translocated");
  });

  test("refuses a copy run from its disk image", () => {
    expect(installRefusal("/Volumes/Agent Lookout 0.2.0/Agent Lookout.app", everywhere)).toBe(
      "disk-image",
    );
  });

  test("refuses a folder this user cannot write, and a bundle this user cannot move", () => {
    expect(installRefusal(APP, (target) => target !== "/Applications")).toBe("read-only");
    expect(installRefusal(APP, (target) => target !== APP)).toBe("read-only");
  });

  test("refuses when there is no bundle to replace", () => {
    expect(installRefusal(null, everywhere)).toBe("read-only");
  });
});
