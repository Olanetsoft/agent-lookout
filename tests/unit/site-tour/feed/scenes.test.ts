import { expect, test } from "vitest";

import { FINISHED_JOB, MACHINE, WAITING_SESSION } from "@site-tour/feed/hour";
import { lampLit, momentFor, sceneAt, SCENES } from "@site-tour/feed/scenes";

import page from "../../../../site/index.html?raw";

/** The landing page's steps, as its HTML writes them, less the soft hyphen a long name may break at. */
function stepsOnThePage() {
  const list = /<ol aria-label="What the dashboard shows">([\s\S]*?)<\/ol>/.exec(page)?.[1] ?? "";
  return [...list.matchAll(/<button([\s\S]*?)>([\s\S]*?)<\/button>/g)].map(
    ([, attributes, name]) => ({
      name: name.replace(/&shy;/g, "").replace(/\s+/g, " ").trim(),
      line: /data-line="([^"]*)"/.exec(attributes)?.[1] ?? "",
      parts: Number(/data-parts="(\d+)"/.exec(attributes)?.[1]),
      lit: /\bdata-lit\b/.test(attributes),
      banner: /\bdata-banner\b/.test(attributes),
      jump: /\bdata-press="jump"/.test(attributes),
      app: /\bdata-app\b/.test(attributes),
    }),
  );
}

test("the page names the same scenes, with the same lines, parts and cues, as the dashboard plays", () => {
  expect(stepsOnThePage()).toEqual(
    SCENES.map((scene) => ({
      name: scene.name,
      line: scene.line,
      parts: scene.steps.length,
      lit: lampLit(scene),
      banner: scene.banner === true,
      jump: scene.press === "jump",
      app: scene.app === true,
    })),
  );
});

test("each stretch of the tour is one scene, and a scene of two parts is split in half", () => {
  const n = SCENES.length;
  expect(sceneAt(0)).toEqual({ index: 0, step: 0 });
  expect(sceneAt(0.75 / n)).toEqual({ index: 0, step: 1 });
  expect(sceneAt(1 / n + 0.001)).toEqual({ index: 1, step: 0 });
  const repos = SCENES.findIndex((scene) => scene.name === "Board");
  expect(sceneAt((repos + 0.25) / n)).toEqual({ index: repos, step: 0 });
  expect(sceneAt((repos + 0.75) / n)).toEqual({ index: repos, step: 1 });
  expect(sceneAt(1)).toEqual({ index: SCENES.length - 1, step: 0 });
  expect(sceneAt(-1)).toEqual({ index: 0, step: 0 });
  expect(sceneAt(2)).toEqual({ index: SCENES.length - 1, step: 0 });
});

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

test("Settings shows notifications and pull requests off, as its line says they are until set up", () => {
  const settings = SCENES.find((scene) => scene.view === "settings");
  expect(settings?.notifications).toBe("off");
  expect(settings?.pullRequests).toBe("off");
  expect(settings?.line).toMatch(
    /^Time and permission rules, .*pull requests stay off until you set them up/,
  );
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

test("each line is short: one sentence, or two short ones", () => {
  for (const scene of SCENES) {
    expect(scene.line.length, scene.name).toBeLessThanOrEqual(110);
  }
});

test("nothing the page says calls the dashboard's sessions anything but sessions", () => {
  const words = page
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .concat(
      " ",
      [...page.matchAll(/\b(?:alt|content|data-line|aria-label|title)="([^"]*)"/g)]
        .map(([, said]) => said)
        .join(" "),
    );
  expect(words).not.toMatch(
    /\b(?:example|sample|demo|fake|dummy|mock|invented|made[- ]up|placeholder|not real)\b/i,
  );
});
