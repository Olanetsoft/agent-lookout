/*
 * The tour: the real dashboard, from /tour in a frame, plays a scene for each
 * stretch of scroll, with a line saying what it shows. Nothing in it acts or
 * leaves this page. A tap, its keyboard or the lamp's switch gives it to the
 * visitor; Back, a chip, Escape or a stretch of scroll takes it back.
 *
 * Scroll moves the meter; a scene punches and sweeps the frame and stamps its
 * name: CSS animations restarted by flipping an attribute between a and b,
 * none of which runs under reduced motion.
 */
import { scroll } from "/vendor/motion.mjs";

const root = document.documentElement;
const section = document.getElementById("tour");
if (section && root.classList.contains("js")) begin(section);

function begin(section) {
  const $ = (selector) => section.querySelector(selector);
  const stage = $(".tour-stage");
  const screen = $(".screen");
  const box = $(".frame");
  const name = $(".tour-name");
  const words = $("#tour-line");
  const said = $(".tour-said");
  const where = $(".tour-at");
  const roll = $(".tour-roll");
  const back = $(".tour-back");
  const cover = $(".tour-cover");
  const nav = $(".tour-chapters");
  const list = $(".tour-chapters ol");
  const stamp = $(".tour-stamp");
  const sweep = $(".tour-sweep");
  const sparks = $(".tour-sparks");
  const spot = $(".tour-spot");
  const bannerTitle = $(".tour-banner-title");
  const bannerBody = $(".tour-banner-body");
  const switchedWords = $(".tour-switched span");
  const steps = [...section.querySelectorAll(".tour-chapters ol button")];
  if (!stage || !screen || !words || !said || !list || !stamp || steps.length === 0) return;
  const items = steps.map((button) => button.parentElement);

  const scenes = steps.map((button) => ({
    name: button.textContent.replace(/\u00ad/g, "").trim(),
    line: button.dataset.line ?? "",
    parts: Math.max(1, Number(button.dataset.parts) || 1),
    lit: button.hasAttribute("data-lit"),
    banner: button.hasAttribute("data-banner"),
    jump: button.dataset.press === "jump",
    app: button.hasAttribute("data-app"),
  }));
  const count = scenes.length;
  const SWITCHED_MS = 1500;
  const DRAWN_WAIT_MS = 320;
  const GAP_MS = 340;
  const YOURS =
    "The dashboard is yours to click. Nothing in it acts on a session or sends anything.";
  // From the stage settling under the header to the tour's foot reaching the window's.
  const OFFSET = ["start 80px", "end end"];

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const phone = matchMedia("(width < 761px)");
  const strip = matchMedia("(width < 1024px), (height < 520px)");
  const say = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
  const now = () => performance.now();

  let index = -1;
  let part = -1;
  let mode = "tour";
  /** The lamp the visitor chose, or null while the scene says. */
  let lamp = null;
  let lampLit = null;
  let frame = null;
  let live = false;
  let appWidth = 1280;
  let scale = 1;
  let handedAt = 0;
  let frameScrolledAt = -Infinity;
  let waiting = null;
  let switchedTimer = 0;
  let given = "";
  let landed = -1;
  let travelTo = null;
  let travelTimer = 0;
  let fullAt = -Infinity;
  let fullTimer = 0;
  let litAtFull = null;
  let inView = false;
  let welcomed = false;
  /** Once the hint has shown, it never shows again. */
  let hinted = false;
  let hintTimer = 0;
  let heldUntil = 0;
  let touch = null;
  let toldAt = -Infinity;
  let pointed = null;
  let placing = 0;
  let peek = 0;

  /** Starts an effect again: its attribute flips between a and b, and so its animation. */
  const flip = (el, key = "go", kind = "") => {
    el.dataset[key] = kind + (el.dataset[key]?.endsWith("a") ? "b" : "a");
  };
  const moving = () => !reduced.matches && mode === "tour";
  const turn = (way) => section.style.setProperty("--way", way < 0 ? -1 : 1);
  const settle = () => parseFloat(getComputedStyle(stage).top || "80");
  /** --<prefix>x, y, w and h, in pixels. */
  const put = (el, prefix, values) =>
    values.forEach((v, i) => el.style.setProperty(`--${prefix}${"xywh"[i]}`, `${v}px`));

  // ── The frame

  const post = (message) => {
    if (live) frame?.contentWindow?.postMessage(message, location.origin);
  };

  /** Drawn 390px wide on a phone, else at 85% scale, 820 to 1280px wide. */
  const fit = () => {
    const w = screen.clientWidth;
    const h = screen.clientHeight;
    if (w === 0) return;
    appWidth = phone.matches ? 390 : Math.min(1280, Math.max(820, Math.round(w / 0.85)));
    scale = w / appWidth;
    const share = Math.max(0.5, (h - 34 - 92) / h);
    screen.style.setProperty("--tour-width", `${appWidth}px`);
    screen.style.setProperty("--tour-height", `${Math.ceil(h / scale)}px`);
    screen.style.setProperty("--tour-scale", String(scale));
    screen.style.setProperty("--dock-scale", String(scale * share));
    screen.style.setProperty("--dock-x", `${((w * (1 - share)) / 2).toFixed(1)}px`);
    place();
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

  /** After the page's load, while the browser is idle and somebody looks. */
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
  if (navigator.connection?.saveData !== true) {
    if (document.readyState === "complete") loadLater();
    else window.addEventListener("load", loadLater, { once: true });
  }

  // ── The spotlight: what the dashboard points at or presses

  /**
   * A ring over a dimmed screen while the tour drives and the middle of what it
   * rings is in sight: not under a header, out of its list or still on its way in,
   * which is looked at again every 100ms.
   */
  const place = () => {
    placing = 0;
    clearTimeout(peek);
    let at = mode === "tour" && pointed?.isConnected && pointed.getBoundingClientRect();
    if (at) {
      const { left, top, width, height } = at;
      at = pointed.contains(
        pointed.ownerDocument.elementFromPoint(left + width / 2, top + height / 2),
      );
      if (at)
        put(
          spot,
          "s",
          [left, top, width, height].map((v, i) => v * scale + (i < 2 ? -6 : 12)),
        );
      else peek = setTimeout(place, 100);
    }
    section.classList.toggle("is-spotting", !!at);
  };
  const replace = () => (placing ||= requestAnimationFrame(place));

  /** What a scene points at or presses, and Stop while it asks. */
  const watch = (doc) =>
    new MutationObserver(() => {
      const at = doc.querySelector(
        '[data-tour-pressed], [data-tour-point], [data-part="stop"][aria-expanded="true"]',
      );
      if (at && at !== pointed) {
        spot.dataset.tone = at.dataset.slot === "event-resumed" ? "ink" : "lamp";
        flip(spot);
      }
      pointed = at;
      place();
    }).observe(doc.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-tour-point", "data-tour-pressed", "aria-expanded"],
    });

  // ── Effects

  /** How far the phone's strip scrolls to bring a chip to its middle. */
  const goal = (i) =>
    Math.max(
      0,
      Math.min(
        items[i].offsetLeft - (list.clientWidth - items[i].offsetWidth) / 2,
        list.scrollWidth - list.clientWidth,
      ),
    );

  /** Where the lamp is: the dashboard's Needs you panel, or the lamp in the picture. */
  const lampPoint = (s) => {
    const hero = live && frame.contentDocument?.querySelector('[data-slot="hero"]');
    if (hero) {
      const at = hero.getBoundingClientRect();
      return [s.left + (at.left + 24) * scale, s.top + (at.top + 28) * scale];
    }
    const [x, y] = getComputedStyle(root).getPropertyValue("--lamp-at").split(" ").map(parseFloat);
    return [s.left + (s.width * x) / 100, s.top + (s.height * y) / 100];
  };

  /** Sparks from the lamp, or where the notification's icon or the Dock's count will land. */
  const burst = (kind) => {
    const s = screen.getBoundingClientRect();
    let [x, y] = lampPoint(s);
    if (kind === "banner") {
      const icon = $(".tour-banner-icon");
      x = s.left + icon.parentElement.offsetLeft + icon.offsetLeft + icon.offsetWidth / 2;
      y = s.top + icon.parentElement.offsetTop + icon.offsetTop + icon.offsetHeight / 2;
    } else if (kind === "badge") {
      const at = $(".tour-badge").getBoundingClientRect();
      x = at.left + at.width / 2;
      y = at.top + at.height / 2 - new DOMMatrix(getComputedStyle($(".tour-dock")).transform).m42;
    }
    put(sparks, "s", [x, y]);
    sparks.dataset.kind = kind;
    flip(sparks);
  };

  /** The whole set: punch, sweep, ring, the name stamped and sent to its chip, and sparks. */
  const full = (way) => {
    fullAt = now();
    const scene = scenes[index];
    turn(way);
    flip(box, "jolt", "p");
    section.style.setProperty("--sweep", 1);
    flip(sweep);
    flip($(".tour-flash"));
    const at = stamp.offsetParent.getBoundingClientRect();
    const chip = items[index].getBoundingClientRect();
    const x =
      strip.matches && now() > heldUntil
        ? list.getBoundingClientRect().left + items[index].offsetLeft - goal(index) + chip.width / 2
        : chip.left + chip.width / 2;
    put(stamp, "f", [
      x - at.left - stamp.offsetLeft,
      chip.top + chip.height / 2 - at.top - stamp.offsetTop,
    ]);
    flip(stamp);
    const changed = litAtFull !== null && lampLit !== litAtFull;
    const kind = scene.app
      ? "badge"
      : scene.banner
        ? "banner"
        : changed && (lampLit ? "lit" : way > 0 && "out");
    if (kind) burst(kind);
    litAtFull = lampLit;
  };

  /** The light set, for a next part or a scene passed in a rush. */
  const nudge = (way) => {
    turn(way);
    flip(box, "jolt", "n");
    section.style.setProperty("--sweep", 0.6);
    flip(sweep);
  };

  /** The whole set comes three times a second at most, and to the scene the scroll rests on. */
  const effects = (way) => {
    if (!way || !moving()) return;
    clearTimeout(fullTimer);
    if (now() - fullAt >= GAP_MS) return full(way);
    nudge(way);
    const due = index;
    fullTimer = setTimeout(() => {
      if (due === index && moving() && travelTo === null) full(way);
    }, GAP_MS);
  };

  /** The first time the dashboard is live and in sight. */
  const welcome = () => {
    if (welcomed || !live || !inView || index < 0) return;
    welcomed = true;
    if (moving()) full(1);
    waitToHint();
  };

  /** "Scroll to play", once the stage has settled and the page has been still a while. */
  const waitToHint = () => {
    if (hinted || !live || mode !== "tour" || section.getBoundingClientRect().top > settle() + 1) {
      return;
    }
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (hinted || index > 0 || part > 0) return;
      hinted = true;
      section.classList.add("is-hinting");
    }, 1600);
  };
  const unhint = () => {
    hinted = true;
    clearTimeout(hintTimer);
    section.classList.remove("is-hinting");
  };

  // ── A scene

  const light = (on) => {
    if (on === lampLit) return;
    lampLit = on;
    say("lookout:lamp", { lit: on });
  };

  /** The scene's name and line rise in from the way the page goes; in a rush they only change. */
  const tell = (text, heading, way) => {
    said.textContent = text;
    name.textContent = heading;
    where.textContent = heading ? `${index + 1} of ${count}: ${heading}. ` : "";
    if (!way || reduced.matches || now() - toldAt < GAP_MS) return;
    toldAt = now();
    turn(way);
    flip(name);
    flip(words);
  };

  const thumb = () => {
    const li = items[index];
    if (li) {
      const { offsetLeft: x, offsetTop: y, offsetWidth: w, offsetHeight: h } = li;
      put(nav, "", [list.offsetLeft + x, list.offsetTop + y, w, h]);
    }
  };
  const sized = new ResizeObserver(thumb);
  for (const el of [nav, ...items]) sized.observe(el);

  /** Marks the chip, Tab's stop unless the keyboard is among them, and names its neighbours. */
  const mark = (at) => {
    const among = list.contains(document.activeElement);
    steps.forEach((button, i) => {
      if (i === at) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
      if (!among) button.tabIndex = i === at ? 0 : -1;
    });
    thumb();
    for (const [button, i, word] of [
      [$(".tour-prev"), at - 1, "Previous"],
      [$(".tour-next"), at + 1, "Next"],
    ]) {
      button.setAttribute("aria-disabled", String(!scenes[i]));
      button.setAttribute("aria-label", `${word} scene${scenes[i] ? `: ${scenes[i].name}` : ""}`);
    }
  };

  const dot = () => {
    nav.querySelector(".is-on")?.classList.remove("is-on");
    items[index].querySelectorAll(".tour-dots i")[part]?.classList.add("is-on");
  };

  const centre = (i) => {
    if (strip.matches && now() > heldUntil) {
      list.scrollTo({ left: goal(i), behavior: reduced.matches ? "instant" : "smooth" });
    }
  };
  // A finger moving the strip sideways holds it there for 1.5s.
  list.addEventListener("touchstart", (event) => ([touch] = event.touches), { passive: true });
  list.addEventListener(
    "touchmove",
    ({ touches: [t] }) => {
      const x = Math.abs(t.clientX - touch.clientX);
      if (x > 10 && x > Math.abs(t.clientY - touch.clientY)) heldUntil = now() + 1500;
    },
    { passive: true },
  );

  /** Entering a scene, its chip and number change; on the way to a pressed chip, nothing more. */
  const cross = (way, passing) => {
    mark(index);
    const [was, is] = roll.children;
    was.textContent = is.textContent;
    is.textContent = String(index + 1).padStart(2, "0");
    turn(way);
    flip(roll);
    if (!passing) flip(nav, "cross");
    centre(index);
    section.style.setProperty("--parts", scenes[index].parts);
  };

  /** The app's icon is fetched once the tour is under way. */
  const dress = () => {
    for (const img of section.querySelectorAll("img[data-src]")) {
      if (!img.getAttribute("src")) img.src = img.dataset.src;
    }
  };

  /** The computer's word on a Jump: for a moment, or, with motion reduced, while the part shows. */
  const switched = (on) => {
    clearTimeout(switchedTimer);
    section.classList.toggle("is-switched", on);
    if (on && !reduced.matches) switchedTimer = setTimeout(() => switched(false), SWITCHED_MS);
  };

  /** What a scene changes on the page. */
  const present = (way) => {
    const scene = scenes[index];
    stamp.replaceChildren(items[index].firstElementChild.cloneNode(true), scene.name);
    tell(scene.line, scene.name, way);
    light(scene.lit);
    section.classList.toggle("is-notifying", scene.banner);
    section.classList.toggle("is-docked", scene.app);
    if (!scene.jump) switched(false);
    effects(way);
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

  /** The dashboard is given the scene and part, and a new scene is said. A Jump's word goes. */
  const land = (way) => {
    switched(false);
    const entering = landed !== index;
    landed = index;
    given = `${index}.${part}`;
    if (index >= 1) dress();
    if (mode === "tour" && entering) {
      if (live) presentWhenDrawn(way);
      else present(way);
    } else if (way && moving()) nudge(way);
    post({ type: "scene", index, step: part, lamp });
  };

  const show = (nextIndex, nextPart, way) => {
    const entering = nextIndex !== index;
    index = nextIndex;
    part = nextPart;
    const passing = travelTo !== null && (travelTo !== index || part > 0);
    if (entering) cross(way, passing || !way);
    dot();
    if (index || part) unhint();
    if (passing) return travel();
    clearTimeout(travelTimer);
    travelTo = null;
    land(way);
  };

  scroll(
    (progress) => {
      const share = Math.min(Math.max(progress, 0), 1) * count;
      const i = Math.min(count - 1, Math.floor(share));
      const { parts } = scenes[i];
      const p = Math.min(parts - 1, Math.floor((share - i) * parts));
      // The first scene is set still: its effects wait for the dashboard to be live and in sight.
      if (i !== index || p !== part) {
        show(i, p, index < 0 ? 0 : i > index || (i === index && p > part) ? 1 : -1);
      }
      section.style.setProperty("--p", reduced.matches ? (p + 1) / parts : Math.min(1, share - i));
      if (
        mode === "yours" &&
        Math.abs(window.scrollY - handedAt) >= stretch() &&
        now() - frameScrolledAt > 400
      ) {
        pickUp();
      }
      waitToHint();
    },
    { target: section, offset: OFFSET },
  );

  const range = () => section.offsetHeight - (window.innerHeight - settle());
  const stretch = () => range() / count;

  const sceneTop = (i) => {
    const top = section.getBoundingClientRect().top + window.scrollY;
    return Math.round(top - settle() + stretch() * i + Math.min(16, stretch() / 8));
  };

  /** A chip takes the page to its scene; those passed only mark their chips. */
  const goTo = (i) => {
    if (!scenes[i]) return;
    pickUp();
    heldUntil = 0;
    travelTo = i;
    travel();
    window.scrollTo({ top: sceneTop(i), behavior: reduced.matches ? "instant" : "smooth" });
  };

  /** The way ends 1200ms after the page last moved along it, if nothing ends it first. */
  const travel = () => {
    clearTimeout(travelTimer);
    travelTimer = setTimeout(arrive, 1200);
  };

  /** There, or wherever a hand stopped it. */
  const arrive = () => {
    if (travelTo === null) return;
    clearTimeout(travelTimer);
    travelTo = null;
    if (given !== `${index}.${part}`) land(1);
  };
  window.addEventListener("scrollend", arrive);
  for (const kind of ["wheel", "touchstart", "keydown"]) {
    window.addEventListener(kind, arrive, { capture: true, passive: true });
  }

  // ── Who drives it

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
    place();
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
    place();
    post({ type: "scene", index, step: part, lamp });
  };

  back?.addEventListener("click", () => {
    pickUp();
    steps[index]?.focus();
  });

  // A tap on the frame gives it over, and lands where it was made.
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
    const box = frame.getBoundingClientRect();
    const scale = box.width / appWidth;
    takeOver();
    post({
      type: "tap",
      x: (event.clientX - box.left) / scale,
      y: (event.clientY - box.top) / scale,
    });
  });

  // The lamp's switch gives the dashboard over. Lighting it throws sparks.
  document.addEventListener("lookout:pressed", (event) => {
    const was = lampLit;
    lampLit = event.detail?.lit === true;
    if (lampLit && !was && !reduced.matches) burst("lit");
    if (!live) return;
    takeOver();
    lamp = lampLit ? "waiting" : "quiet";
    post({ type: "lamp", lamp });
  });

  document.addEventListener("lookout:turned", (event) => {
    post({ type: "theme", theme: event.detail?.theme });
  });

  // The tour leaving the screen takes the dashboard back.
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (!inView) pickUp();
    welcome();
  }).observe(section);

  // ── The chips

  steps.forEach((button, i) => button.addEventListener("click", () => goTo(i)));
  $(".tour-prev").addEventListener("click", () => goTo(index - 1));
  $(".tour-next").addEventListener("click", () => goTo(index + 1));
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
    steps[next].focus({ preventScroll: true });
    goTo(next);
    centre(next);
  });
  // Once the keyboard leaves the chips, Tab comes back to the scene on show.
  list.addEventListener("focusout", (event) => {
    if (!list.contains(event.relatedTarget)) mark(index);
  });
  requestAnimationFrame(() => requestAnimationFrame(() => (nav.dataset.placed = "")));

  // ── What the dashboard says

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
          const view = frame.contentWindow;
          view.addEventListener(
            "scroll",
            () => {
              frameScrolledAt = now();
              handedAt = window.scrollY;
            },
            { passive: true },
          );
          // The ring follows what it rings, as the page or a list in it scrolls or a view rises.
          for (const kind of ["scroll", "animationend", "transitionend"]) {
            view.addEventListener(kind, replace, { capture: true, passive: true });
          }
          watch(frame.contentDocument);
        } catch {
          // A frame at another address would say nothing of its scroll.
        }
        const theme = root.dataset.theme;
        if (theme === "light" || theme === "dark") post({ type: "theme", theme });
        post({ type: "scene", index: Math.max(0, index), step: Math.max(0, part), lamp });
        // Shown once it has drawn the scene it was just given.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            section.classList.add("is-live");
            welcome();
          }),
        );
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
