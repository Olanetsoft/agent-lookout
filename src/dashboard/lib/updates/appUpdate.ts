import { ACTION_HEADER } from "@core/api";
import {
  APP_UPDATE_ACTIONS,
  APP_UPDATE_CHECK_PATH,
  APP_UPDATE_INSTALL_PATH,
  APP_UPDATE_PATH,
  APP_UPDATE_SETTING_PATH,
  type AppUpdateSettingRequest,
  type AppUpdateStatus,
  type InstallRefusal,
  type UpdatePhase,
} from "@core/appUpdate";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/**
 * The page's side of the Mac app's updates. Only the app answers these
 * addresses, so only a page in the app's window asks them: Settings draws the
 * Updates card there and nowhere else. Like every other request, each goes
 * through `apiRequest`, on the page's own origin.
 */

/** A read is not left waiting on an app that has stopped answering. */
export const UPDATE_STATUS_TIMEOUT_MS = 4_000;

/**
 * How long a press of Check for Updates… waits. The app waits up to 20
 * seconds for GitHub, so the page waits a little longer than it does.
 */
export const UPDATE_CHECK_TIMEOUT_MS = 30_000;

const REFUSALS: readonly InstallRefusal[] = [
  "translocated",
  "disk-image",
  "read-only",
  "development",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
/** A link the page may draw: one the app's window hands to the browser, an `https:` address. */
const isLink = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("https://");
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The phase in an answer, or null when it is not one the page knows. */
function readPhase(value: unknown): UpdatePhase | null {
  if (!isObject(value)) return null;
  switch (value.phase) {
    case "idle":
    case "checking":
    case "up-to-date":
    case "no-release":
      return { phase: value.phase };
    case "downloading":
      return isText(value.version) &&
        isLink(value.notesUrl) &&
        isCount(value.received) &&
        isCount(value.total)
        ? {
            phase: "downloading",
            version: value.version,
            notesUrl: value.notesUrl,
            received: value.received,
            total: value.total,
          }
        : null;
    case "ready":
    case "installing":
      return isText(value.version) && isLink(value.notesUrl)
        ? { phase: value.phase, version: value.version, notesUrl: value.notesUrl }
        : null;
    case "cannot-install": {
      const refusal = REFUSALS.find((known) => known === value.refusal);
      return isText(value.version) && isLink(value.notesUrl) && refusal !== undefined
        ? { phase: "cannot-install", version: value.version, notesUrl: value.notesUrl, refusal }
        : null;
    }
    case "failed": {
      const step =
        value.step === "check" || value.step === "download" || value.step === "install"
          ? value.step
          : null;
      if (step === null || !isText(value.reason)) return null;
      return {
        phase: "failed",
        step,
        reason: value.reason,
        version: isText(value.version) ? value.version : null,
        notesUrl: isLink(value.notesUrl) ? value.notesUrl : null,
      };
    }
    default:
      return null;
  }
}

/** Reads the app's answer into the status the card draws, or null when it is not one. */
export function readUpdateStatus(value: unknown): AppUpdateStatus | null {
  if (!isObject(value)) return null;
  const update = readPhase(value.update);
  if (
    update === null ||
    !isText(value.version) ||
    typeof value.automatic !== "boolean" ||
    !isLink(value.releasesUrl)
  ) {
    return null;
  }
  const checked = value.lastCheckedAt;
  return {
    version: value.version,
    automatic: value.automatic,
    lastCheckedAt: isCount(checked) && checked > 0 ? checked : null,
    releasesUrl: value.releasesUrl,
    update,
  };
}

/** The status in an answer of the app, a 200 or the 409 of an install it refused. */
async function statusIn(response: Response): Promise<AppUpdateStatus | null> {
  const data: unknown = await response.json();
  if (response.ok) return readUpdateStatus(data);
  return isObject(data) ? readUpdateStatus(data.status) : null;
}

/** Asks the app where its updates stand. Null when it did not answer, or answered with something else. */
export async function fetchUpdateStatus(): Promise<AppUpdateStatus | null> {
  try {
    const response = await apiRequest(APP_UPDATE_PATH, {
      signal: AbortSignal.timeout(UPDATE_STATUS_TIMEOUT_MS),
    });
    return response.ok ? readUpdateStatus(await response.json()) : null;
  } catch {
    return null;
  }
}

/** One of the three POSTs, each with its own action and a JSON body. */
async function post(
  path: string,
  action: string,
  body: object,
  timeoutMs: number,
): Promise<AppUpdateStatus | null> {
  try {
    const response = await apiRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: action },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await statusIn(response);
  } catch {
    return null;
  }
}

/** Asks the app to check GitHub now. Resolves with its status once it has an answer. */
export function requestUpdateCheck(): Promise<AppUpdateStatus | null> {
  return post(APP_UPDATE_CHECK_PATH, APP_UPDATE_ACTIONS.check, {}, UPDATE_CHECK_TIMEOUT_MS);
}

/** Asks the app to install the version that is ready, and restart. */
export function requestUpdateInstall(): Promise<AppUpdateStatus | null> {
  return post(APP_UPDATE_INSTALL_PATH, APP_UPDATE_ACTIONS.install, {}, UPDATE_STATUS_TIMEOUT_MS);
}

/** Turns the automatic check on or off. */
export function requestAutomaticUpdates(automatic: boolean): Promise<AppUpdateStatus | null> {
  return post(
    APP_UPDATE_SETTING_PATH,
    APP_UPDATE_ACTIONS.setting,
    { automatic } satisfies AppUpdateSettingRequest,
    UPDATE_STATUS_TIMEOUT_MS,
  );
}
