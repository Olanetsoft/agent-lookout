import { expect, test } from "vitest";

import { changeNotice } from "@core/notices/waiting";
import { createFeed } from "@site-tour/feed/derive";
import { FINISHED_JOB, MACHINE, WAITING_SESSION } from "@site-tour/feed/hour";
import { lampLit, momentFor, SCENES } from "@site-tour/feed/scenes";

import install from "../../../../docs/INSTALL.md?raw";
import lost from "../../../../site/404.html?raw";
import page from "../../../../site/index.html?raw";
import frameScript from "../../../../site/tour.js?raw";
import captureScript from "../../../../scripts/site-tour/capture-pictures.mjs?raw";

// The landing page is read here too: the scenes are what its frame and its
// pictures show, and check-layout keeps every test beside a module of src/.

/** Every file in site/, by the address it is served at, such as /assets/app-icon-256.webp. */
const SITE_FILES = new Set(
  Object.keys(import.meta.glob("../../../../site/**/*")).map((file) =>
    file.slice("../../../../site".length),
  ),
);
const LATEST = "https://github.com/Olanetsoft/agent-lookout/releases/latest";

/** HTML's entities, read. */
function decoded(html: string): string {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Text as a reader gets it: tags gone, entities read, spaces as one. */
function plain(html: string): string {
  return decoded(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** An attribute's value among a tag's attributes, or null. */
function attribute(attributes: string, name: string): string | null {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}

test("the lamp's switch overrides the scene's moment, and nothing else", () => {
  const quietScene = SCENES[0];
  const waitingScene = SCENES[1];
  expect(momentFor(quietScene, null)).toBe("quiet");
  expect(momentFor(quietScene, "waiting")).toBe("waiting");
  expect(momentFor(waitingScene, "quiet")).toBe("answered");
  expect(momentFor(waitingScene, null)).toBe("waiting");
});

test("the scenes come in the order the app's parts matter, the wait first and its answer with it", () => {
  expect(SCENES.map((scene) => scene.name)).toEqual([
    "One screen",
    "Needs you",
    "Allow or Deny",
    "Notification",
    "Jump",
    "Stop",
    "Board",
    "Resume",
    "History",
    "Sources",
    "Settings",
    "Mac app",
  ]);
});

test("only the scenes while checkout-flow waits, and the Mac app, light the lamp", () => {
  expect(SCENES.filter(lampLit).map((scene) => scene.name)).toEqual([
    "Needs you",
    "Allow or Deny",
    "Notification",
    "Jump",
    "Stop",
    "Board",
    "Mac app",
  ]);
});

test("Allow or Deny points at the waiting session's request, and presses neither", () => {
  const scene = SCENES.find((one) => one.name === "Allow or Deny")!;
  expect(scene.moment).toBe("waiting");
  expect(scene.steps.map((step) => step.point)).toEqual(["answer"]);
  expect(scene.press).toBeUndefined();
  expect(SCENES.filter((one) => one.steps.some((step) => step.point))).toEqual([scene]);
});

test("the board is shown with a session in its Needs you column", () => {
  const board = SCENES.find((scene) => scene.steps.some((step) => step.layout === "board"));
  expect(board?.moment).toBe("waiting");
});

test("Settings shows notifications and pull requests off", () => {
  const settings = SCENES.find((scene) => scene.view === "settings");
  expect(settings?.notifications).toBe("off");
  expect(settings?.pullRequests).toBe("off");
  expect(settings?.steps.map((step) => step.look)).toEqual(["top", "Time rules"]);
  // Every other scene has them on, as the visitor in the tour has turned them.
  expect(SCENES.filter((scene) => scene.notifications === "off")).toEqual([settings]);
  expect(SCENES.filter((scene) => scene.pullRequests === "off")).toEqual([settings]);
});

test("Jump is pressed in the hero, and then the Sessions list shows each row's own", () => {
  const scene = SCENES.find((one) => one.press === "jump")!;
  expect(scene.name).toBe("Jump");
  expect(scene.moment).toBe("waiting");
  expect(scene.steps.map((step) => step.look)).toEqual(["top", "Sessions"]);
});

test("Stop is pressed in the waiting session's details, and only asks; Resume is a finished job's", () => {
  const withDetails = SCENES.filter((scene) => scene.steps.some((step) => step.details));
  expect(withDetails.map((scene) => scene.name)).toEqual(["Stop", "Resume"]);
  const [stop, resume] = withDetails;
  expect(stop).toMatchObject({ moment: "waiting", press: "stop" });
  expect(stop.steps.map((step) => step.details)).toEqual([WAITING_SESSION]);
  expect(resume.press).toBeUndefined();
  expect(resume.steps.map((step) => step.details)).toEqual([FINISHED_JOB]);
});

test("Sources shows the other machine's card, then what each agent can report", () => {
  const sources = SCENES.find((scene) => scene.view === "sources");
  expect(sources?.steps.map((step) => step.look)).toEqual([
    "top",
    MACHINE.name,
    "What each agent can report",
  ]);
});

test("Waits is shown after the history it is worked out from", () => {
  const history = SCENES.find((scene) => scene.steps.some((step) => step.look === "Waits"));
  expect(history?.name).toBe("History");
  expect(history?.steps.map((step) => step.look)).toEqual(["Last hour", "Events", "Waits"]);
});

test.each([
  ["the front page", page],
  ["the page for an address with nothing", lost],
])("nothing %s says calls the dashboard's sessions anything but sessions", (_name, html) => {
  const words = html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .concat(
      " ",
      [...html.matchAll(/\b(?:alt|content|aria-label|title)="([^"]*)"/g)]
        .map(([, said]) => said)
        .join(" "),
    );
  expect(words).not.toMatch(
    /\b(?:example|sample|demo|fake|dummy|mock|invented|made[- ]up|placeholder|not real)\b/i,
  );
});

test("the frame opens on the scenes its pictures show", () => {
  const tag = (id: string, name: string) =>
    new RegExp(`<${name}\\b[^>]*\\sid="${id}"[^>]*>`).exec(page)?.[0] ?? "";
  expect(tag("lamp-lit", "input")).toMatch(/\schecked\b/);
  expect(tag("lamp-out", "input")).not.toMatch(/\schecked\b/);
  expect(tag("shot-lit", "img")).toMatch(/\sfetchpriority="high"/);
  expect(tag("shot-out", "img")).toMatch(/\sfetchpriority="low"/);
  const index = (name: string) =>
    Number(new RegExp(`const ${name} = (\\d+);`).exec(frameScript)?.[1]);
  const names = SCENES.map((scene) => scene.name);
  expect(index("QUIET")).toBe(names.indexOf("One screen"));
  expect(index("WAITING")).toBe(names.indexOf("Needs you"));
  expect(lampLit(SCENES[index("QUIET")])).toBe(false);
  expect(lampLit(SCENES[index("WAITING")])).toBe(true);
});

/** Whether site/ has the file an address names, as Vercel finds it: `/` is index.html, `/tour` is tour/index.html. */
function inSite(address: string): boolean {
  const clean = decodeURIComponent(address.replace(/[?#].*$/, "")).replace(/\/+$/, "");
  return [clean, `${clean}.html`, `${clean}/index.html`].some((file) => SITE_FILES.has(file));
}

test.each([
  ["the front page", page],
  ["the page for an address with nothing", lost],
])("every file %s names is in site/", (_name, html) => {
  const named = new Set<string>();
  for (const [, name, value] of html.matchAll(/\s(src|srcset|href|data-src)="([^"]*)"/g)) {
    const addresses =
      name === "srcset" ? value.split(",").map((one) => one.trim().split(/\s+/)[0]) : [value];
    for (const address of addresses) {
      if (address.startsWith("/") && !address.startsWith("//")) named.add(address);
    }
  }
  expect(named.size).toBeGreaterThan(5);
  expect([...named].filter((address) => !inSite(address))).toEqual([]);
});

test("each feature picture comes in Night and Day, 1000 and 1600 wide, and for a phone 800 and 1200", () => {
  const features = [...page.matchAll(/<article\s+class="feature\b[\s\S]*?<\/article\s*>/g)].map(
    ([feature]) => feature,
  );
  expect(features).toHaveLength(6);
  const files = (srcset: string | null, kind: string) =>
    (srcset ?? "")
      .split(",")
      .map((one) => one.trim().split(/\s+/))
      .map(([file, width]) => {
        const match = new RegExp(`^/assets/features/([a-z-]+?)-${kind}-(\\d+)\\.webp$`).exec(file);
        return { stem: match?.[1], width: Number(match?.[2]), said: width };
      });
  for (const feature of features) {
    const id = /\sid="(f-[^"]+)"/.exec(feature)?.[1] ?? "";
    const sources = [...feature.matchAll(/<source\b([^>]*)>/g)].map(([, attributes]) => attributes);
    const img = /<img\b([^>]*)>/.exec(feature)?.[1] ?? "";
    expect(sources, id).toHaveLength(3);
    const [phoneDay, phoneNight, day] = sources;

    // A phone's, first, so a narrow screen takes it before the wide one.
    expect(attribute(phoneDay, "data-day"), id).toBe("(width < 761px)");
    expect(attribute(phoneDay, "media"), id).toBe(
      "(width < 761px) and (prefers-color-scheme: light)",
    );
    expect(attribute(phoneNight, "data-day"), id).toBeNull();
    expect(attribute(phoneNight, "media"), id).toBe("(width < 761px)");
    const phone = files(attribute(phoneDay, "srcset"), "phone-day");
    expect(
      phone.map((one) => [one.width, one.said]),
      id,
    ).toEqual([
      [800, "800w"],
      [1200, "1200w"],
    ]);
    expect(files(attribute(phoneNight, "srcset"), "phone-night"), id).toEqual(phone);
    for (const attributes of [phoneDay, phoneNight]) {
      expect(attribute(attributes, "width"), id).toBe("1200");
      expect(attribute(attributes, "height"), id).toBe("1500");
    }

    expect(attribute(day, "data-day"), id).toBe("");
    expect(attribute(day, "media"), id).toBe("(prefers-color-scheme: light)");
    const wide = files(attribute(day, "srcset"), "day");
    const night = files(attribute(img, "srcset"), "night");
    expect(
      wide.map((one) => [one.width, one.said]),
      id,
    ).toEqual([
      [1000, "1000w"],
      [1600, "1600w"],
    ]);
    expect(wide[0].stem, id).toBeDefined();
    expect(wide[1].stem, id).toBe(wide[0].stem);
    expect(phone[0].stem, id).toBe(wide[0].stem);
    expect(night, id).toEqual(wide);
    expect(attribute(img, "src"), id).toBe(`/assets/features/${wide[0].stem}-night-1000.webp`);
    for (const attributes of [day, img]) {
      expect(attribute(attributes, "width"), id).toBe("1600");
      expect(attribute(attributes, "height"), id).toBe("1200");
    }
    expect(attribute(img, "loading"), id).toBe("lazy");
  }
});

/** The capture script's size for each kind of picture, in KB, read from its BUDGET_KB. */
function budgets(): Map<string, number> {
  const block = /const BUDGET_KB = \{([\s\S]*?)\};/.exec(captureScript)?.[1] ?? "";
  return new Map(
    [...block.matchAll(/"([a-z-]+-\d+)": (\d+),/g)].map(([, kind, kb]) => [kind, Number(kb)]),
  );
}

/**
 * Every picture of the dashboard in site/assets/, by its address, as a data
 * address, so its size can be read here, where Node's file system is not.
 */
const PICTURES = import.meta.glob<string>(
  [
    "../../../../site/assets/dashboard-*.webp",
    "../../../../site/assets/phone-*.webp",
    "../../../../site/assets/features/*.webp",
  ],
  { query: "?inline", import: "default", eager: true },
);

/** The bytes a base64 data address holds. */
function bytesIn(data: string): number {
  const base64 = data.slice(data.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

test("every picture of the dashboard in site/assets/ is within the size the capture script keeps it to", () => {
  const sizes = budgets();
  expect(sizes.size).toBe(9);
  const pictures = Object.entries(PICTURES).map(([file, data]) => ({
    file: file.slice("../../../../site".length),
    data,
  }));
  expect(pictures).toHaveLength(68);
  for (const { file, data } of pictures) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const width = /-(\d+)\.webp$/.exec(name)?.[1];
    const kind = file.startsWith("/assets/features/")
      ? name.includes("-phone-")
        ? "feature-phone"
        : "feature"
      : name.slice(0, name.indexOf("-"));
    const kb = sizes.get(`${kind}-${width}`);
    expect(kb, file).toBeDefined();
    expect(data, file).toMatch(/^data:image\/webp;base64,/);
    expect(bytesIn(data), file).toBeLessThanOrEqual(kb! * 1024);
  }
});

test("Download for Mac goes to the latest release", () => {
  const links = [...page.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/g)].filter(
    ([, , text]) => plain(text) === "Download for Mac",
  );
  expect(links.length).toBeGreaterThanOrEqual(2);
  for (const [, attributes] of links) expect(attribute(attributes, "href")).toBe(LATEST);
});

test("the prompt for a coding agent is the install guide's", () => {
  const shown = /<pre id="agent-prompt">\n?([\s\S]*?)<\/pre\s*>/.exec(page)?.[1];
  const section = install.slice(install.indexOf("## With your coding agent"));
  const guide = /```text\n([\s\S]*?)\n```/.exec(section)?.[1];
  expect(shown).toBeDefined();
  expect(guide).toBeDefined();
  expect(decoded(shown!)).toBe(guide);
});

test("the notification over the Notifications picture is the one the dashboard sends", () => {
  // As the tour's src/site-tour/main.tsx works out the words of the notification a wait sends.
  const t0 = Date.UTC(2026, 9, 5, 9, 12, 0);
  const session = createFeed(t0)
    .snapshot({ moment: "waiting" }, t0)
    .sessions.find((one) => one.status === "needs-you");
  expect(session).toBeDefined();
  const notice = changeNotice({ event: "needs-you", session: session! });
  const title = /<strong class="note-banner-title">([\s\S]*?)<\/strong\s*>/.exec(page)?.[1];
  const body = /<span class="note-banner-body">([\s\S]*?)<\/span\s*>/.exec(page)?.[1];
  expect(plain(title ?? "")).toBe(notice.title);
  expect(plain(body ?? "")).toBe(notice.body);
});
