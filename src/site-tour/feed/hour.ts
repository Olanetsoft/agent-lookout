import type {
  JumpTarget,
  PermissionAsk,
  PullRequest,
  Session,
  SessionStatus,
  SourceId,
  Surface,
  WaitingReason,
} from "@core/sessions/session";

/**
 * The hour the landing page's dashboard shows: nine sessions on this computer
 * across five projects, one more on another machine read over SSH, what each
 * one did and when, and one stop of Agent Lookout in the middle of it. Every time is in milliseconds from `t0`, the moment the page's
 * dashboard was loaded, so the hour always ends now.
 *
 * Nothing here is drawn as it is. `derive.ts` turns it into what the
 * collector's routes answer at any moment, through the same rules the
 * collector uses.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Agent Lookout started watching. */
export const WATCHING_SINCE = -56 * MINUTE;

/** It was stopped for four minutes, and started again. Nothing was measured in between. */
export const STOPPED_AT = -42 * MINUTE;
export const RESUMED_AT = -38 * MINUTE;

/**
 * When checkout-flow stops to ask. It is still waiting when the hour ends: when
 * it is answered is not part of the hour, but of the visit. It is answered when
 * the visitor moves on from the wait, so the log says it waited as long as the
 * visitor saw it wait.
 */
export const WAIT_STARTS = -(4 * MINUTE + 12 * SECOND);

/** The session that waits, and what it goes back to once answered. */
export const WAITING_SESSION = "claude-code:3f6c2a10-8b1e-4d7a-9c55-0e2b7d41a901";
export const ANSWERED_STEP: StatusStep = { at: 0, status: "working" };

/** The background job that finished in the hour, which Resume continues. */
export const FINISHED_JOB = "claude-code:72d9a0e5-c18b-4f3a-96e4-b05f8d2c1a69";

/** The other machine, as `AGENT_LOOKOUT_REMOTES` names it, and how ssh reaches it. */
export const MACHINE = { name: "devbox", target: "sam@devbox", port: 4777 } as const;

/**
 * The moments the tour shows, each as an offset from `t0`. The answered moment
 * is the end of the hour, and later still: from when the wait was answered on.
 */
export const MOMENTS = {
  /** Before checkout-flow asks: nothing needs you. */
  quiet: WAIT_STARTS - 20 * SECOND,
  /** checkout-flow is waiting for permission. */
  waiting: 0,
  /** The wait has been answered. */
  answered: 0,
} as const;

export type MomentName = keyof typeof MOMENTS;

/** What a session says about itself from a moment on. */
export interface StatusStep {
  at: number;
  status: SessionStatus;
  waitingReason?: WaitingReason;
  waitingDetail?: string;
  waitingText?: string;
  /**
   * The permission request Agent Lookout holds while the session waits, as
   * the plugin hands it over. When it lets the request go is worked out from
   * the present.
   */
  ask?: Omit<PermissionAsk, "until">;
}

/** One session of the hour. */
export interface HourSession {
  id: string;
  source: SourceId;
  agent?: string;
  surface: Surface;
  name: string;
  project: string;
  /** The folder it runs in, under the one generic home folder. */
  folder: string;
  branch: string;
  repository: { id: string; name: string };
  /** When it started, from t0. */
  startedAt: number;
  /** When Agent Lookout first lists it. Left out: it was running before watching began. */
  appearsAt?: number;
  /** Its status from when it is listed, and every change after. The first step can be older than the hour. */
  steps: readonly StatusStep[];
  pid?: number;
  links?: Session["links"];
  jump?: JumpTarget;
  /** The other machine it runs on, read over SSH. Left out, it runs on this computer. */
  machine?: string;
  /** Its agent writes its file as it works, so Agent Lookout knows how long it has been quiet. */
  writes?: boolean;
  /** Its branch's pull request on github.com, shown while pull requests are on. */
  pullRequest?: PullRequest;
}

const HOME = "/Users/sam/code";

/** The home folder on the other machine. */
const MACHINE_HOME = "/home/sam/code";

const REPOSITORIES = {
  storefront: { id: "5f0c2a91d4e7b836", name: "storefront" },
  platformApi: { id: "a83e17c0f29b4d65", name: "platform-api" },
  docs: { id: "0d9b6f42e1c873a5", name: "docs" },
  mobileApp: { id: "c4271e9ab0d35f18", name: "mobile-app" },
  infra: { id: "7e6a3d05b8c1f294", name: "infra" },
  /** platform-api as checked out on the other machine, which its Agent Lookout names on its own. */
  platformApiThere: { id: "b51d9e0a7c3f2486", name: "platform-api" },
} as const;

export const SESSIONS: readonly HourSession[] = [
  {
    id: WAITING_SESSION,
    source: "claude-code",
    surface: "terminal",
    name: "checkout-flow",
    project: "storefront",
    folder: `${HOME}/storefront`,
    branch: "checkout-flow",
    repository: REPOSITORIES.storefront,
    startedAt: -48 * MINUTE,
    appearsAt: -48 * MINUTE,
    steps: [
      { at: -48 * MINUTE, status: "working" },
      {
        at: WAIT_STARTS,
        status: "needs-you",
        waitingReason: "permission",
        waitingDetail: "permission prompt",
        waitingText: "Run: npm test",
        ask: {
          requestId: "a7c41e095b2d4f869e1360d8b2c4f7a5",
          tool: "Bash",
          command: "npm test",
          description: "Run the test suite",
          allow: true,
        },
      },
    ],
    pid: 48213,
    jump: { kind: "terminal", app: "Terminal", place: "Terminal" },
    pullRequest: {
      number: 214,
      title: "Split the checkout form into steps",
      state: "open",
      checks: { state: "failing", passing: 5, failing: 1, pending: 0 },
      url: "https://github.com/sam/storefront/pull/214",
    },
  },
  {
    id: "claude-code:9a41d7e3-2c6b-4f08-b3a1-5d8e0c7f2b14",
    source: "claude-code",
    surface: "desktop",
    name: "billing-webhooks",
    project: "platform-api",
    folder: `${HOME}/platform-api`,
    branch: "webhook-retries",
    repository: REPOSITORIES.platformApi,
    startedAt: -2 * HOUR,
    steps: [
      { at: -70 * MINUTE, status: "idle" },
      { at: -5 * MINUTE, status: "working" },
    ],
    pid: 47120,
  },
  {
    id: "claude-code:c2e85b19-7d40-4a6f-8e23-91f0a6d4c357",
    source: "claude-code",
    surface: "vscode",
    name: "search-indexing",
    project: "storefront-search",
    folder: `${HOME}/storefront-search`,
    branch: "search-indexing",
    repository: REPOSITORIES.storefront,
    startedAt: -90 * MINUTE,
    steps: [
      { at: -61 * MINUTE, status: "idle" },
      { at: -34 * MINUTE, status: "working" },
      {
        at: -33 * MINUTE,
        status: "needs-you",
        waitingReason: "question",
        waitingDetail: "input needed",
      },
      { at: -31 * MINUTE, status: "working" },
    ],
    pid: 46511,
    links: {
      open: "vscode://anthropic.claude-code/open?session=c2e85b19-7d40-4a6f-8e23-91f0a6d4c357",
    },
  },
  {
    id: "codex:019a6c42-3b7e-7d10-9f45-2e8c1a0b6d73",
    source: "codex",
    surface: "desktop",
    name: "api-rate-limits",
    project: "platform-api",
    folder: `${HOME}/platform-api`,
    branch: "rate-limits",
    repository: REPOSITORIES.platformApi,
    startedAt: -95 * MINUTE,
    steps: [
      { at: -66 * MINUTE, status: "working" },
      { at: -20 * MINUTE, status: "idle" },
      { at: -12 * MINUTE, status: "working" },
    ],
    writes: true,
  },
  {
    id: "codex:019a6b8f-91d2-7c34-a0e6-5f3b2d7c8e41",
    source: "codex",
    surface: "desktop",
    name: "mobile-onboarding",
    project: "mobile-app",
    folder: `${HOME}/mobile-app`,
    branch: "onboarding-screens",
    repository: REPOSITORIES.mobileApp,
    startedAt: -3 * HOUR,
    steps: [{ at: -65 * MINUTE, status: "idle" }],
    writes: true,
  },
  {
    id: "claude-code:5b7f03c8-e46a-4d91-a2b0-7c3e9f1d6a28",
    source: "claude-code",
    surface: "terminal",
    name: "docs-site",
    project: "docs",
    folder: `${HOME}/docs`,
    branch: "getting-started",
    repository: REPOSITORIES.docs,
    startedAt: -100 * MINUTE,
    steps: [
      { at: -62 * MINUTE, status: "idle" },
      { at: -47 * MINUTE, status: "working" },
      { at: -18 * MINUTE, status: "idle" },
    ],
    pid: 45902,
    jump: { kind: "tmux", place: "docs:1.0" },
  },
  {
    id: "claude-code:e81c4f6a-0b93-4e27-bd58-3a6f2c9e0d15",
    source: "claude-code",
    surface: "terminal",
    name: "infra-terraform",
    project: "infra",
    folder: `${HOME}/infra`,
    branch: "main",
    repository: REPOSITORIES.infra,
    startedAt: -4 * DAY,
    steps: [{ at: -3 * DAY, status: "idle" }],
    pid: 31877,
  },
  {
    id: FINISHED_JOB,
    source: "claude-code",
    surface: "terminal",
    name: "email-templates",
    project: "storefront-email",
    folder: `${HOME}/storefront-email`,
    branch: "email-templates",
    repository: REPOSITORIES.storefront,
    startedAt: -52 * MINUTE,
    appearsAt: -52 * MINUTE,
    steps: [
      { at: -52 * MINUTE, status: "working" },
      { at: -11 * MINUTE, status: "finished" },
    ],
  },
  {
    id: "status-files:release-notes.json",
    source: "status-files",
    agent: "my-agent",
    surface: "terminal",
    name: "release-notes",
    project: "docs",
    folder: `${HOME}/docs`,
    branch: "getting-started",
    repository: REPOSITORIES.docs,
    startedAt: -25 * MINUTE,
    appearsAt: -25 * MINUTE,
    steps: [{ at: -25 * MINUTE, status: "working" }],
    pid: 49034,
    writes: true,
  },
  {
    id: `remote:${MACHINE.name}:claude-code:4d2e8b61-9f05-4c7a-a3e8-1b6f0d9c5e72`,
    source: `remote:${MACHINE.name}`,
    agent: "Claude Code",
    machine: MACHINE.name,
    surface: "terminal",
    name: "billing-migration",
    project: "platform-api",
    folder: `${MACHINE_HOME}/platform-api`,
    branch: "billing-migration",
    repository: REPOSITORIES.platformApiThere,
    startedAt: -75 * MINUTE,
    steps: [
      { at: -63 * MINUTE, status: "working" },
      { at: -29 * MINUTE, status: "idle" },
      { at: -8 * MINUTE, status: "working" },
    ],
  },
];
