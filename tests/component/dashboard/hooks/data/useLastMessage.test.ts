import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { LAST_MESSAGE_PATH, type LastMessageResponse } from "@core/api";
import {
  useLastMessage,
  type LastMessageAsking,
  type LastMessageReading,
} from "@dashboard/hooks/data/useLastMessage";
import { setApiHost } from "@dashboard/lib/api/apiHost";

// Runs in the component project because it is a hook that asks the API.

const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const OTHER = "claude-code:00000000-0000-4000-8000-000000000002";
const T = 1_700_000_000_000;

const SAID: LastMessageResponse = { message: { text: "Done.\n\nTwo files changed.", cut: false } };

/** A stand-in for the API whose answers come only when the test gives them. */
function server() {
  const asked: string[] = [];
  const waiting: ((response: Response) => void)[] = [];
  setApiHost(
    (path) =>
      new Promise<Response>((resolve) => {
        asked.push(path);
        waiting.push(resolve);
      }),
  );
  return {
    asked,
    /** How many requests have no answer yet. */
    open: () => waiting.length,
    /** Answers the oldest request still open. */
    answer(body: unknown, status = 200) {
      const resolve = waiting.shift();
      if (!resolve) throw new Error("Nothing was asked.");
      resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

const path = (id: string) => `${LAST_MESSAGE_PATH}?id=${encodeURIComponent(id)}`;

const open = (overrides: Partial<LastMessageAsking> = {}): LastMessageAsking => ({
  active: true,
  hidden: false,
  beat: T,
  ...overrides,
});

/** Mounts the hook, in StrictMode when `strict`, as the dashboard runs in development. */
async function mount(asking: LastMessageAsking, id = ID, strict = false) {
  return renderHook<{ id: string; asking: LastMessageAsking }, LastMessageReading>(
    (props) => useLastMessage(props!.id, props!.asking),
    { initialProps: { id, asking }, wrapper: strict ? StrictMode : undefined },
  );
}

afterEach(() => {
  setApiHost();
  vi.unstubAllGlobals();
  delete (document as { hidden?: boolean }).hidden;
});

test.each([false, true])(
  "it asks once when it opens, once for each new beat, and never while a request is still out (StrictMode: %s)",
  async (strict) => {
    const api = server();
    const hook = await mount(open(), ID, strict);
    expect(hook.result.current).toEqual({ status: "loading", answer: null });
    await expect.poll(() => api.asked).toEqual([path(ID)]);

    // A beat while the first is out asks nothing more.
    await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
    expect(api.asked).toHaveLength(1);
    await hook.act(() => api.answer(SAID));
    await expect.poll(() => hook.result.current).toEqual({ status: "ready", answer: SAID });

    // The same beat again asks nothing, a new one asks once.
    await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
    expect(api.asked).toHaveLength(1);
    await hook.rerender({ id: ID, asking: open({ beat: T + 4_000 }) });
    await expect.poll(() => api.asked).toHaveLength(2);
    expect(api.open()).toBe(1);
    await hook.unmount();
  },
);

test("nothing is asked while it is not active, and nothing is held", async () => {
  const api = server();
  const hook = await mount(open({ active: false }));
  await hook.rerender({ id: ID, asking: open({ active: false, beat: T + 2_000 }) });
  expect(api.asked).toEqual([]);
  expect(hook.result.current).toEqual({ status: "idle", answer: null });
  await hook.unmount();
});

test("once it stops being active, the text is gone at once, and an answer still to come is dropped", async () => {
  const api = server();
  const hook = await mount(open());
  await hook.act(() => api.answer(SAID));
  await expect.poll(() => hook.result.current.status).toBe("ready");

  await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
  await expect.poll(() => api.open()).toBe(1);
  await hook.rerender({ id: ID, asking: open({ active: false, beat: T + 2_000 }) });
  expect(hook.result.current).toEqual({ status: "idle", answer: null });

  // The answer to the request it made before arrives after: it is not shown.
  await hook.act(() => api.answer({ message: { text: "Later.", cut: false } }));
  expect(hook.result.current).toEqual({ status: "idle", answer: null });

  // Active again, it starts over: nothing of the old answer, and it asks again.
  await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
  expect(hook.result.current).toEqual({ status: "loading", answer: null });
  await expect.poll(() => api.asked).toHaveLength(3);
  await hook.unmount();
});

test("while the page is hidden nothing is asked, and back in sight it asks", async () => {
  const api = server();
  const hook = await mount(open({ hidden: true }));
  await hook.rerender({ id: ID, asking: open({ hidden: true, beat: T + 2_000 }) });
  expect(api.asked).toEqual([]);
  expect(hook.result.current.status).toBe("loading");

  await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
  await expect.poll(() => api.asked).toEqual([path(ID)]);
  await hook.act(() => api.answer(SAID));
  await expect.poll(() => hook.result.current.status).toBe("ready");

  // Hidden again, what it holds stays and nothing more is asked.
  await hook.rerender({ id: ID, asking: open({ hidden: true, beat: T + 4_000 }) });
  expect(hook.result.current).toEqual({ status: "ready", answer: SAID });
  expect(api.asked).toHaveLength(1);
  await hook.unmount();
});

test.each([
  [{ message: null, reason: "off", setting: "AGENT_LOOKOUT_LAST_MESSAGE" }],
  [{ message: null, reason: "not-read" }],
] as const)("after %j it does not ask again", async (said) => {
  const api = server();
  const hook = await mount(open());
  await hook.act(() => api.answer(said));
  await expect.poll(() => hook.result.current).toEqual({ status: "ready", answer: said });

  await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
  await hook.rerender({ id: ID, asking: open({ beat: T + 4_000 }) });
  expect(api.asked).toHaveLength(1);
  await hook.unmount();
});

test("any other reason is asked again on the next beat, as the session may yet say something", async () => {
  const api = server();
  const hook = await mount(open());
  await hook.act(() => api.answer({ message: null, reason: "nothing-yet" }));
  await expect
    .poll(() => hook.result.current.answer)
    .toEqual({
      message: null,
      reason: "nothing-yet",
    });
  await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
  await expect.poll(() => api.asked).toHaveLength(2);
  await hook.act(() => api.answer(SAID));
  await expect.poll(() => hook.result.current.answer).toEqual(SAID);
  await hook.unmount();
});

test("a failure keeps the last answer, and with none before it says it failed", async () => {
  const api = server();
  const hook = await mount(open());
  await hook.act(() => api.answer({ error: "Something went wrong." }, 500));
  await expect.poll(() => hook.result.current).toEqual({ status: "failed", answer: null });

  await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
  await hook.act(() => api.answer(SAID));
  await expect.poll(() => hook.result.current).toEqual({ status: "ready", answer: SAID });

  await hook.rerender({ id: ID, asking: open({ beat: T + 4_000 }) });
  await hook.act(() => api.answer({ error: "Something went wrong." }, 500));
  await hook.rerender({ id: ID, asking: open({ beat: T + 6_000 }) });
  await expect.poll(() => api.asked).toHaveLength(4);
  await hook.act(() => api.answer({ message: "not an answer" }));
  // Each failure has been taken in once the next beat asks again.
  await hook.rerender({ id: ID, asking: open({ beat: T + 8_000 }) });
  await expect.poll(() => api.asked).toHaveLength(5);
  expect(hook.result.current).toEqual({ status: "ready", answer: SAID });
  await hook.unmount();
});

test("a busy server keeps what is shown, the wait for the first answer included", async () => {
  const api = server();
  const hook = await mount(open());
  await hook.act(() => api.answer({ error: "Too many." }, 429));
  // Taken in once the next beat asks again.
  await hook.rerender({ id: ID, asking: open({ beat: T + 2_000 }) });
  await expect.poll(() => api.asked).toHaveLength(2);
  expect(hook.result.current).toEqual({ status: "loading", answer: null });
  await hook.act(() => api.answer(SAID));
  await expect.poll(() => hook.result.current.status).toBe("ready");
  await hook.rerender({ id: ID, asking: open({ beat: T + 4_000 }) });
  await hook.act(() => api.answer({ error: "Too many." }, 429));
  await hook.rerender({ id: ID, asking: open({ beat: T + 6_000 }) });
  await expect.poll(() => api.asked).toHaveLength(4);
  expect(hook.result.current).toEqual({ status: "ready", answer: SAID });
  await hook.unmount();
});

test("another session starts over, and is asked for by its own id", async () => {
  const api = server();
  const hook = await mount(open());
  await hook.act(() => api.answer(SAID));
  await expect.poll(() => hook.result.current.status).toBe("ready");

  await hook.rerender({ id: OTHER, asking: open() });
  expect(hook.result.current).toEqual({ status: "loading", answer: null });
  await expect.poll(() => api.asked).toEqual([path(ID), path(OTHER)]);
  await hook.unmount();
});

test("nothing of it goes to storage, to another tab or to the address", async () => {
  const channels = vi.fn();
  vi.stubGlobal("BroadcastChannel", channels);
  const address = location.href;
  const kept = () => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]);
  const before = kept();
  const api = server();
  const hook = await mount(open());
  await hook.act(() => api.answer(SAID));
  await expect.poll(() => hook.result.current.status).toBe("ready");

  expect(kept()).toBe(before);
  expect(kept()).not.toContain("Two files changed");
  expect(channels).not.toHaveBeenCalled();
  expect(location.href).toBe(address);
  await hook.unmount();
});
