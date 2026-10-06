import { expect, test } from "vitest";

import { VIEWS, viewFromHash, viewLabel } from "@dashboard/lib/shell/view";

test("#sources and #settings are their views", () => {
  expect(viewFromHash("#sources")).toBe("sources");
  expect(viewFromHash("#settings")).toBe("settings");
  expect(viewFromHash("#overview")).toBe("overview");
});

test("#settings/updates, which the Mac app opens, is Settings", () => {
  expect(viewFromHash("#settings/updates")).toBe("settings");
  expect(viewFromHash("#settings/other")).toBe("overview");
});

test.each(["", "#", "#unknown", "#Sources", "#sources/", "sources", "#settings?x=1", "##sources"])(
  "%j is the Overview",
  (hash) => {
    expect(viewFromHash(hash)).toBe("overview");
  },
);

test("the rail lists Overview, Sources and Settings, each linking to its own address", () => {
  expect(VIEWS.map((view) => [view.label, view.href])).toEqual([
    ["Overview", "#overview"],
    ["Sources", "#sources"],
    ["Settings", "#settings"],
  ]);
  for (const view of VIEWS) expect(viewFromHash(view.href)).toBe(view.id);
});

test("each view has a name", () => {
  expect(viewLabel("overview")).toBe("Overview");
  expect(viewLabel("sources")).toBe("Sources");
  expect(viewLabel("settings")).toBe("Settings");
});
