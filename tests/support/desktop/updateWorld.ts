// A Mac as the app's updater sees it, for its tests: a made-up app bundle in a
// folder of the test's own, releases the test publishes and withdraws, and
// requests that are stand-ins, answered at once or held until the test answers
// them. The folders and the zips are real files. ditto is a stand-in that
// unpacks the few bytes a zip is here, and the helper is a stand-in that does
// what its script does, to the made-up bundle, once the app has quit. So no
// socket is opened, nothing is started and no real app is touched.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DITTO, type RunProgram } from "@desktop/updates/install/bundleCheck";
import type { Fetched, RequestFailure } from "@desktop/updates/release/releaseRequest";
import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from "@desktop/updates/updateSettings";
import { createUpdater, type Updater } from "@desktop/updates/updater";
import { tempDir } from "@tests/support/node/tempFiles";

const APP_ID = "dev.agentlookout.app";

const zipName = (version: string) => `Agent-Lookout-${version}-mac-arm64.zip`;

/** The few bytes a release's zip is here, which the stand-in ditto turns into a bundle. */
const zipBytes = (version: string) => Buffer.from(JSON.stringify({ version }).padEnd(200));

const manifestOf = (version: string) => `version: ${version}
files:
  - url: ${zipName(version)}
    sha512: ${createHash("sha512").update(zipBytes(version)).digest("base64")}
    size: ${zipBytes(version).byteLength}
`;

const plist = (version: string) => `<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${APP_ID}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`;

async function makeBundle(dir: string, version: string): Promise<string> {
  const bundle = path.join(dir, "Agent Lookout.app");
  await mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(bundle, "Contents", "Info.plist"), plist(version));
  await writeFile(path.join(bundle, "Contents", "MacOS", "Agent Lookout"), version, {
    mode: 0o755,
  });
  return bundle;
}

/** The version of a bundle that could be opened: it has its Info.plist and its program. */
export function versionIn(bundle: string): string | null {
  if (!existsSync(path.join(bundle, "Contents", "MacOS", "Agent Lookout"))) return null;
  try {
    const text = readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
    return /String<\/key><string>([^<]*)/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

type DownloadAnswer = "whole" | RequestFailure;

/** A request the test has not answered yet. */
interface Held<Answer> {
  answer(with_: Answer): void;
}

export interface UpdateWorld {
  /** The running app's updater, or null while the app is not open. */
  updater: Updater;
  readonly open: boolean;
  /** The app's folder of user data, the system's temporary folder and the app's bundle. */
  readonly data: string;
  readonly temp: string;
  readonly bundle: string;
  /** The latest release, or null when it has no Mac app. */
  latest: string | null;
  /** What a check is answered with: the latest release, no answer, or whatever the test says later. */
  checks: "answer" | "fail" | "hold";
  /** What a download is answered with. */
  downloads: DownloadAnswer | "hold";
  /** Those held. */
  readonly heldChecks: Held<"answer" | "fail">[];
  readonly heldDownloads: Held<DownloadAnswer>[];
  /** How many checks were made, and how many downloads asked for. */
  looked: number;
  asked: number;
  /** Called once a zip has been read to be unpacked, before what is in it is written, with what stops that. */
  unpacking: (stop: AbortSignal | undefined) => void | Promise<void>;
  /** Whether the app can change its own bundle. */
  writable: boolean;
  /** Whether the helper starts, and whether what it opens can be opened. */
  helperStarts: boolean;
  newOpens: boolean;
  /** What the helper was started with, until the app quits. */
  helper: { bundle: string; replacement: string; aside: string } | null;
  readonly log: string[];
  now: number;
  settings: UpdateSettings;
  /** The updater's folders, in the folder of user data. */
  folders(): Promise<string[]>;
  /** The zip that waits or is being written, or null. */
  zip(): Promise<string | null>;
  /** Opens the app as the version in its place. */
  launch(): Updater;
  /** Quits the app, after which the helper does its work if it was started, and opens the app. */
  quit(): void;
}

/** A Mac with a version of the app in its place, open. */
export async function makeUpdateWorld(version = "0.2.0"): Promise<UpdateWorld> {
  const work = await tempDir();
  const data = path.join(work, "data");
  const temp = path.join(work, "tmp");
  await mkdir(data);
  await mkdir(temp);
  const bundle = await makeBundle(path.join(work, "Applications"), version);
  let open = false;

  const world: UpdateWorld = {
    updater: undefined as unknown as Updater,
    get open() {
      return open;
    },
    data,
    temp,
    bundle,
    latest: version,
    checks: "answer",
    downloads: "whole",
    heldChecks: [],
    heldDownloads: [],
    looked: 0,
    asked: 0,
    unpacking: () => {},
    writable: true,
    helperStarts: true,
    newOpens: true,
    helper: null,
    log: [],
    now: Date.UTC(2026, 9, 6, 9),
    settings: DEFAULT_UPDATE_SETTINGS,
    folders: async () =>
      (await readdir(data)).filter((name) => name.startsWith("agent-lookout-update-")),
    async zip() {
      for (const folder of await world.folders()) {
        const names = await readdir(path.join(data, folder)).catch(() => []);
        const zip = names.find((name) => name.endsWith(".zip"));
        if (zip !== undefined) return path.join(data, folder, zip);
      }
      return null;
    },
    launch() {
      const running = versionIn(bundle);
      if (running === null) throw new Error("There is no app to open.");
      open = true;
      world.updater = createUpdater({
        version: running,
        arch: "arm64",
        packaged: true,
        bundle,
        settings: { read: () => world.settings, write: (next) => (world.settings = next) },
        dataDir: data,
        tempDir: temp,
        removal: { rm, rmSync },
        endpoints: {
          manifest: "https://releases.invalid/latest-mac.yml",
          download: (_version, name) => `https://releases.invalid/${name}`,
          notes: (of) => `https://releases.invalid/notes/${of}`,
          releases: "https://releases.invalid/",
          allow: () => true,
        },
        requests: { fetchText, downloadFile },
        canWrite: () => world.writable,
        run: unpack,
        startDetached: async (_file, args) => {
          if (!world.helperStarts) return false;
          const [, , , , app, replacement, aside] = args;
          world.helper = { bundle: app!, replacement: replacement!, aside: aside! };
          return true;
        },
        quit: () => {},
        warn: (line) => world.log.push(line),
        now: () => world.now,
      });
      return world.updater;
    },
    quit() {
      world.updater.stop();
      open = false;
      // An answer that comes as it quits.
      for (const held of [...world.heldChecks]) held.answer("answer");
      const plan = world.helper;
      world.helper = null;
      if (plan === null) return;
      // What the script in `installHelper.ts` does, which its own test runs.
      if (versionIn(plan.replacement) !== null) {
        renameSync(plan.bundle, plan.aside);
        renameSync(plan.replacement, plan.bundle);
        if (!world.newOpens) {
          renameSync(plan.bundle, plan.replacement);
          renameSync(plan.aside, plan.bundle);
        }
      }
      world.launch();
    },
  };

  const unpack: RunProgram = async (file, args, stop) => {
    const [, , zip, into] = args;
    if (file !== DITTO) return { ok: false };
    try {
      const { version } = JSON.parse(await readFile(zip!, "utf8")) as { version: string };
      await world.unpacking(stop);
      await makeBundle(into!, version);
      return { ok: true, stdout: "" };
    } catch {
      return { ok: false };
    }
  };

  const checked = (how: "answer" | "fail"): Fetched<string> => {
    if (how === "fail") return { ok: false, failure: "network" };
    return world.latest === null
      ? { ok: false, failure: "not-found", status: 404 }
      : { ok: true, value: manifestOf(world.latest) };
  };
  const fetchText = (): Promise<Fetched<string>> => {
    world.looked += 1;
    if (world.checks !== "hold") return Promise.resolve(checked(world.checks));
    return new Promise((resolve) => {
      const held = {
        answer(how: "answer" | "fail") {
          world.heldChecks.splice(world.heldChecks.indexOf(held), 1);
          resolve(checked(how));
        },
      };
      world.heldChecks.push(held);
    });
  };
  const downloadFile = async (
    url: string,
    file: string,
    _expected: unknown,
    options: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void },
  ): Promise<Fetched<void>> => {
    world.asked += 1;
    const asked = /Lookout-(.*)-mac/.exec(url)?.[1] ?? "";
    const bytes = zipBytes(asked);
    let how = world.downloads;
    if (how === "hold") {
      how = await new Promise<DownloadAnswer>((resolve) => {
        const held = {
          answer(with_: DownloadAnswer) {
            const index = world.heldDownloads.indexOf(held);
            if (index >= 0) world.heldDownloads.splice(index, 1);
            resolve(with_);
          },
        };
        world.heldDownloads.push(held);
        options.signal?.addEventListener("abort", () => held.answer("too-slow"));
      });
    }
    const whole = how === "whole";
    options.onProgress?.(whole ? bytes.byteLength : 50, bytes.byteLength);
    try {
      await writeFile(file, whole ? bytes : bytes.subarray(0, 50), { flag: "wx" });
    } catch {
      return { ok: false, failure: "not-saved" };
    }
    return how === "whole" ? { ok: true, value: undefined } : { ok: false, failure: how };
  };

  world.launch();
  return world;
}
