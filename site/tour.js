/*
 * The tour. As the page scrolls through it, the dashboard in the frame plays
 * through what the app does, one scene for each stretch of scroll, with a
 * line saying what it shows. Scrolling back plays it back. The dashboard is the
 * real one, from /tour, in a frame of this page: nothing in it acts, and
 * nothing in it leaves this page.
 *
 * It arrives after the page has loaded, while the browser is idle. Until it
 * has drawn its first scene, and if it never does, the scenes play with the
 * two pictures, and the lamp lights and goes out with them.
 *
 * A tap on the frame, the keyboard in it, or a press of the lamp's switch
 * gives the dashboard to the visitor, and the tour stops driving it. It takes
 * it back on Back to the tour, on a step, on Escape in the frame, when the
 * tour leaves the screen, or when the page has scrolled a whole scene's
 * stretch with the dashboard still.
 *
 * Once the dashboard is in the frame, what a scene changes on the page, its
 * line, the lamp, a notification, the menu bar and the Dock, moves when the
 * dashboard says the scene is on its way to the screen, so the two move
 * together.
 *
 * Under reduced motion the scenes come one after another as still pictures:
 * every change is made at once, and the line under the steps is set a scene
 * at a time.
 */
import { animate, scroll } from "/vendor/motion.mjs";

const root = document.documentElement;
const section = document.getElementById("tour");
if (section && root.classList.contains("js")) begin(section);

function begin(section) {
  const $ = (selector) => section.querySelector(selector);
  const stage = $(".tour-stage");
  const screen = $(".screen");
  const words = $("#tour-line");
  const name = $(".tour-name");
  const said = $(".tour-said");
  const back = $(".tour-back");
  const cover = $(".tour-cover");
  const bannerTitle = $(".tour-banner-title");
  const bannerBody = $(".tour-banner-body");
  const switchedWords = $(".tour-switched span");
  const fill = $(".tour-fill");
  const list = $(".tour-steps ol");
  const steps = [...section.querySelectorAll(".tour-steps button")];
  if (!stage || !screen || !words || !said || !list || steps.length === 0) return;

  const scenes = steps.map((button) => ({
    name: button.textContent.replace(/\u00ad/g, "").trim(),
    line: button.dataset.line ?? "",
    parts: Math.max(1, Number(button.dataset.parts) || 1),
    lit: button.hasAttribute("data-lit"),
    banner: button.hasAttribute("data-banner"),
    jump: button.dataset.press === "jump",
    app: button.hasAttribute("data-app"),
  }));
  /** How long the computer's word on a Jump stays. */
  const SWITCHED_MS = 1500;
  /** How long a scene's words wait for the dashboard to say it is drawing the scene. */
  const DRAWN_WAIT_MS = 320;
  const YOURS =
    "The dashboard is yours to click. Nothing in it acts on a session or sends anything.";
  // Progress starts when the stage settles under the header, and ends as the tour's foot reaches the window's.
  const OFFSET = ["start 80px", "end end"];

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const phone = matchMedia("(width < 761px)");
  const say = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

  let index = -1;
  let part = -1;
  let mode = "tour";
  /** The lamp the visitor chose with the switch, or null while the scene says. */
  let lamp = null;
  let lampLit = null;
  let frame = null;
  let live = false;
  let lineMotion = null;
  /** Where the page was scrolled to when the dashboard was last given over or last scrolled itself. */
  let handedAt = 0;
  let frameScrolledAt = -Infinity;
  /** The scene whose words wait for the dashboard, and how they come in. */
  let waiting = null;
  let switchedTimer = 0;

  // ── The frame ─────────────────────────────────────────────────────────────

  const post = (message) => {
    if (live) frame?.contentWindow?.postMessage(message, location.origin);
  };

  /**
   * The dashboard is drawn at the app's own window size and scaled to the
   * screen. As the Mac app's window it is smaller, with room over it for the
   * menu bar and under it for the Dock: 34px from the screen's top, and 92px
   * over its foot.
   */
  const fit = () => {
    const width = phone.matches ? 390 : 1280;
    const box = screen.getBoundingClientRect();
    if (box.width === 0) return;
    const scale = box.width / width;
    const share = Math.max(0.5, (box.height - 34 - 92) / box.height);
    screen.style.setProperty("--tour-width", `${width}px`);
    screen.style.setProperty("--tour-height", `${Math.ceil(box.height / scale)}px`);
    screen.style.setProperty("--tour-scale", String(scale));
    screen.style.setProperty("--dock-scale", String(scale * share));
    screen.style.setProperty("--dock-x", `${((box.width * (1 - share)) / 2).toFixed(1)}px`);
    screen.style.setProperty("--dock-y", "34px");
  };
  new ResizeObserver(fit).observe(screen);
  phone.addEventListener("change", fit);

  const load = () => {
    if (frame) return;
    frame = document.createElement("iframe");
    frame.src = "/tour";
    frame.title = "The Agent Lookout dashboard";
    fit();
    screen.insertBefore(frame, cover);
  };

  /** Once the page has loaded, while the browser is idle and somebody is looking. */
  const loadLater = () => {
    const idle = window.requestIdleCallback ?? ((then) => setTimeout(then, 300));
    const whenSeen = () => {
      if (!document.hidden) return load();
      const look = () => {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", look);
        load();
      };
      document.addEventListener("visibilitychange", look);
    };
    idle(whenSeen, { timeout: 3000 });
  };
  // With Save-Data on, the dashboard is fetched only once somebody taps the frame.
  // This script itself is fetched once the page has loaded.
  if (navigator.connection?.saveData !== true) {
    if (document.readyState === "complete") loadLater();
    else window.addEventListener("load", loadLater, { once: true });
  }

  // ── A scene ───────────────────────────────────────────────────────────────

  const light = (on) => {
    if (on === lampLit) return;
    lampLit = on;
    say("lookout:lamp", { lit: on });
  };

  /** Says the line, sliding in from the way the page is going. */
  const tell = (text, title, way) => {
    said.textContent = text;
    if (name) name.textContent = title;
    lineMotion?.stop();
    lineMotion = null;
    if (reduced.matches || way === 0) return;
    lineMotion = animate(
      words,
      { opacity: [0, 1], transform: [`translateY(${way > 0 ? 10 : -10}px)`, "translateY(0px)"] },
      { duration: 0.24, ease: [0.2, 0.7, 0.2, 1] },
    );
  };

  /**
   * Marks the step, keeping it the one the Tab key lands on unless the
   * keyboard is among them. Under reduced motion the line under the steps is
   * set to the end of the scene, since it does not follow the scroll there.
   */
  const mark = (at) => {
    const among = list.contains(document.activeElement);
    steps.forEach((button, i) => {
      if (i === at) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
      if (!among) button.tabIndex = i === at ? 0 : -1;
    });
    if (reduced.matches && fill) fill.style.transform = `scaleX(${(at + 1) / scenes.length})`;
  };

  /** The app's icon, for the notification and the Dock, is fetched once the tour is under way. */
  const dress = () => {
    for (const img of section.querySelectorAll("img[data-src]")) {
      if (!img.getAttribute("src")) img.src = img.dataset.src;
    }
  };

  /** The computer's word on a Jump: for a moment, or, as a still, for as long as the scene shows. */
  const switched = (on) => {
    clearTimeout(switchedTimer);
    section.classList.toggle("is-switched", on);
    if (on && !reduced.matches) switchedTimer = setTimeout(() => switched(false), SWITCHED_MS);
  };

  /** What a scene changes on the page: its words, the lamp, a notification, the menu bar and the Dock. */
  const present = (way) => {
    const scene = scenes[index];
    tell(scene.line, scene.name, way);
    light(scene.lit);
    section.classList.toggle("is-notifying", scene.banner);
    section.classList.toggle("is-docked", scene.app);
    if (!scene.jump) switched(false);
  };

  /** Once the dashboard says the scene is on its way, or soon if it says nothing. */
  const presentWhenDrawn = (way) => {
    if (waiting) clearTimeout(waiting.timer);
    const due = index;
    waiting = {
      index: due,
      way,
      timer: setTimeout(() => {
        if (waiting?.index !== due) return;
        waiting = null;
        present(way);
      }, DRAWN_WAIT_MS),
    };
  };

  const show = (nextIndex, nextPart, way) => {
    const entering = nextIndex !== index;
    index = nextIndex;
    part = nextPart;
    mark(index);
    if (index >= 1) dress();
    if (mode === "tour" && entering) {
      if (live) presentWhenDrawn(way);
      else present(way);
    }
    post({ type: "scene", index, step: part, lamp });
  };

  /** The scene and its part at a share of the tour, from 0 to 1. */
  const at = (progress) => {
    const share = Math.min(Math.max(progress, 0), 1) * scenes.length;
    const i = Math.min(scenes.length - 1, Math.floor(share));
    const parts = scenes[i].parts;
    return { i, p: Math.min(parts - 1, Math.floor((share - i) * parts)) };
  };

  scroll(
    (progress) => {
      const { i, p } = at(progress);
      if (i !== index || p !== part) show(i, p, i > index || (i === index && p > part) ? 1 : -1);
      if (
        mode === "yours" &&
        Math.abs(window.scrollY - handedAt) >= stretch() &&
        performance.now() - frameScrolledAt > 400
      ) {
        pickUp();
      }
    },
    { target: section, offset: OFFSET },
  );
  if (!reduced.matches && fill) {
    scroll(animate(fill, { transform: ["scaleX(0)", "scaleX(1)"] }, { ease: "linear" }), {
      target: section,
      offset: OFFSET,
    });
  }

  /** How far the page scrolls through one scene, in pixels. */
  const range = () =>
    section.offsetHeight - (window.innerHeight - parseFloat(getComputedStyle(stage).top || "80"));
  const stretch = () => range() / scenes.length;

  /** Where the page is scrolled to for a scene to begin. */
  const sceneTop = (i) => {
    const top = section.getBoundingClientRect().top + window.scrollY;
    const settle = parseFloat(getComputedStyle(stage).top || "80");
    return Math.round(top - settle + stretch() * i + Math.min(16, stretch() / 8));
  };

  const goTo = (i) => {
    pickUp();
    window.scrollTo({ top: sceneTop(i), behavior: reduced.matches ? "instant" : "smooth" });
  };

  // ── Who drives it ─────────────────────────────────────────────────────────

  const takeOver = () => {
    if (mode === "yours" || !live) return;
    mode = "yours";
    handedAt = window.scrollY;
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
    switched(false);
    section.classList.add("is-yours");
    section.classList.remove("is-notifying", "is-docked");
    back.hidden = false;
    tell(YOURS, "", 0);
    post({ type: "mode", mode });
  };

  const pickUp = () => {
    if (mode === "tour") return;
    mode = "tour";
    // The keyboard comes back to the page, so its keys scroll the page again.
    if (frame && document.activeElement === frame) steps[index]?.focus({ preventScroll: true });
    lamp = null;
    section.classList.remove("is-yours");
    back.hidden = true;
    post({ type: "mode", mode });
    present(0);
    post({ type: "scene", index, step: part, lamp });
  };

  back?.addEventListener("click", () => {
    pickUp();
    steps[index]?.focus();
  });

  // A tap on the frame gives it over and lands where it was made. A drag scrolls the page.
  let down = null;
  cover?.addEventListener("pointerdown", (event) => {
    down = { x: event.clientX, y: event.clientY, at: event.timeStamp };
  });
  cover?.addEventListener("pointerup", (event) => {
    const tap =
      down &&
      Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 8 &&
      event.timeStamp - down.at <= 500;
    down = null;
    if (!tap) return;
    if (!frame) return load();
    if (!live) return;
    // Where the dashboard is drawn now: the whole screen, or the Mac app's smaller window.
    const box = frame.getBoundingClientRect();
    const scale = box.width / (phone.matches ? 390 : 1280);
    takeOver();
    post({
      type: "tap",
      x: (event.clientX - box.left) / scale,
      y: (event.clientY - box.top) / scale,
    });
  });

  // The lamp's switch gives the dashboard over, and the lamp is the visitor's.
  document.addEventListener("lookout:pressed", (event) => {
    lampLit = event.detail?.lit === true;
    if (!live) return;
    takeOver();
    lamp = lampLit ? "waiting" : "quiet";
    post({ type: "lamp", lamp });
  });

  // The page and the dashboard are in one theme.
  document.addEventListener("lookout:turned", (event) => {
    post({ type: "theme", theme: event.detail?.theme });
  });

  // The tour leaving the screen takes the dashboard back.
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) pickUp();
  }).observe(section);

  // ── The steps ─────────────────────────────────────────────────────────────

  steps.forEach((button, i) => button.addEventListener("click", () => goTo(i)));
  list.addEventListener("keydown", (event) => {
    const from = steps.indexOf(document.activeElement);
    if (from === -1) return;
    const last = steps.length - 1;
    const to = {
      ArrowLeft: from - 1,
      ArrowUp: from - 1,
      ArrowRight: from + 1,
      ArrowDown: from + 1,
      Home: 0,
      End: last,
    }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = Math.min(last, Math.max(0, to));
    steps.forEach((button, i) => (button.tabIndex = i === next ? 0 : -1));
    steps[next].focus();
    goTo(next);
  });
  // Once the keyboard leaves the steps, the Tab key comes back to the scene on show.
  list.addEventListener("focusout", (event) => {
    if (!list.contains(event.relatedTarget)) mark(index);
  });

  // ── What the dashboard says ───────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    if (!frame || event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (typeof message !== "object" || message === null) return;
    switch (message.type) {
      case "ready": {
        if (live) return;
        live = true;
        dress();
        if (typeof message.notice?.title === "string" && message.notice.title !== "") {
          bannerTitle.textContent = message.notice.title;
          bannerBody.textContent = message.notice.body;
        }
        try {
          frame.contentWindow.addEventListener(
            "scroll",
            () => {
              frameScrolledAt = performance.now();
              handedAt = window.scrollY;
            },
            { passive: true },
          );
        } catch {
          // A frame at another address would say nothing of its scroll.
        }
        const theme = root.dataset.theme;
        if (theme === "light" || theme === "dark") post({ type: "theme", theme });
        post({ type: "scene", index: Math.max(0, index), step: Math.max(0, part), lamp });
        // Shown once it has drawn the scene it was just given.
        requestAnimationFrame(() => requestAnimationFrame(() => section.classList.add("is-live")));
        return;
      }
      case "drawn":
        if (waiting && message.index === waiting.index && message.index === index) {
          clearTimeout(waiting.timer);
          const { way } = waiting;
          waiting = null;
          if (mode === "tour") present(way);
        }
        return;
      case "jumped":
        if (mode !== "tour" || !scenes[index]?.jump || typeof message.words !== "string") return;
        if (switchedWords) switchedWords.textContent = message.words;
        switched(true);
        return;
      case "lamp":
        if (mode === "yours" && typeof message.waiting === "number") light(message.waiting > 0);
        return;
      case "notification":
        if (typeof message.title === "string" && typeof message.body === "string") {
          bannerTitle.textContent = message.title;
          bannerBody.textContent = message.body;
        }
        return;
      case "took-over":
        takeOver();
        return;
      case "theme":
        say("lookout:choose", { theme: message.theme });
        return;
      case "leave":
        pickUp();
        steps[index]?.focus();
        return;
    }
  });
}
