/*
 * The page's first script. It is loaded in the head, so its first part runs
 * before the first paint and the page never shows one state and then takes it
 * back. Without it the page shows the lamp lit, follows the system's Night or
 * Day and shows every feature at rest, and the switches and copy buttons are
 * not drawn.
 *
 * It runs the Night and Day switch, putting back a choice kept in this
 * browser; holds the lamp, out or lit, with its switch; copies the npx command
 * and the coding-agent prompt; brings each feature in as it comes into view;
 * and once the page has loaded fetches tour.js, which puts the dashboard in the
 * frame. The frame tells it which the lamp is while the visitor has it, and
 * hears from it when either switch is pressed. Nothing leaves this browser.
 *
 * The two scripts speak through events on the document:
 *
 *   lookout:turned    the page has turned to Night or Day, { theme }
 *   lookout:choose    choose Night or Day, as the switch does, { theme }
 *   lookout:lamp      light the lamp or put it out, { lit }
 *   lookout:pressed   a hand on the lamp's switch, { lit }
 */
((root) => {
  const KEY = "agent-lookout-theme";
  const GROUND = { dark: "#060605", light: "#d4d0ca" };
  const systemDay = matchMedia("(prefers-color-scheme: light)");

  // Before the first paint.
  let kept = null;
  try {
    kept = localStorage.getItem(KEY);
  } catch {
    // Storage can be blocked. The page then follows the system.
  }
  if (kept !== "light" && kept !== "dark") kept = null;
  root.classList.add("js");
  if (kept) {
    root.dataset.theme = kept;
    // The pictures follow the system until they are pointed at the choice below.
    if ((kept === "light") !== systemDay.matches) root.classList.add("unsettled");
  }
  // The features come in as they are reached, unless motion is reduced.
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches)
    root.classList.add("reveals");

  // The two switches are set as the parser reaches them, so no frame shows one
  // in a state the page is not in. The page opens lit, as it is without script.
  const isDay = () => (kept ? kept === "light" : systemDay.matches);
  const check = (id) => {
    const input = document.getElementById(id);
    if (input) input.checked = true;
  };
  const markTheme = () => check(isDay() ? "theme-day" : "theme-night");
  const markLamp = () => check(root.classList.contains("lamp-out") ? "lamp-out" : "lamp-lit");
  const early = new MutationObserver(() => {
    markTheme();
    markLamp();
    // The second lamp radio is the last of the four.
    if (document.getElementById("lamp-lit")) early.disconnect();
  });
  early.observe(root, { childList: true, subtree: true });

  // The frame's script comes once the page has loaded, so nothing it needs is
  // fetched before the first screen's picture, and only on a page with the frame.
  window.addEventListener(
    "load",
    () => {
      if (!document.getElementById("tour")) return;
      const tour = document.createElement("script");
      tour.type = "module";
      tour.src = "/tour.js";
      document.head.append(tour);
    },
    { once: true },
  );

  const nothing = () => {};
  const after = (ms) => new Promise((done) => setTimeout(done, ms));
  /** Settles once a picture is fetched and decoded, or cannot be. */
  const decoded = (img) => (img && img.decode ? img.decode().catch(nothing) : Promise.resolve());
  const say = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

  document.addEventListener("DOMContentLoaded", () => {
    early.disconnect();
    markTheme();
    markLamp();
    // A switch slides only after the page has been drawn with it in place.
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("ready")));

    const $ = (id) => document.getElementById(id);
    const waiting = $("shot-lit");
    const hero = [$("shot-out"), waiting].filter(Boolean).map((img) => img.parentNode);
    const pictures = [...document.querySelectorAll("picture")].filter((picture) =>
      picture.querySelector("source[data-day]"),
    );

    // ── Night and Day ──────────────────────────────────────────────────────
    //
    // The page's colours follow data-theme. A picture is chosen by the media
    // of its <source> elements, which follow the system until one of these is
    // pressed. A source marked data-day holds a Day picture: it is switched on
    // for Day and off for Night.
    const point = (picture, day) => {
      for (const source of picture.querySelectorAll("source[data-day]"))
        source.media = day ? source.dataset.day || "all" : "not all";
    };

    /** A feature's picture already drawn, and in sight or nearly. */
    const near = (picture) => {
      const img = picture.querySelector("img");
      if (!img?.complete || img.naturalWidth === 0) return false;
      const box = img.getBoundingClientRect();
      return box.bottom > -0.5 * innerHeight && box.top < 1.5 * innerHeight;
    };

    // The other theme's pictures are fetched and decoded on copies first, so
    // the page and its pictures turn together and nothing in sight is empty:
    // the frame's, and the features' already drawn near the view. The rest
    // are only pointed, and load as they come into view. Once the dashboard
    // has taken the frame's place its pictures are never shown again, so they
    // are neither waited for nor pointed, and the other theme's are never
    // fetched.
    let turns = 0;
    const turn = (theme) => {
      const day = theme === "light";
      const mine = ++turns;
      const live = root.querySelector(".window.is-live") !== null;
      const shown = pictures.filter((picture) => !(live && hero.includes(picture)));
      const first = shown.filter((picture) => hero.includes(picture) || near(picture));
      const ready = first.map((picture) => {
        const copy = picture.cloneNode(true);
        const img = copy.querySelector("img");
        img.loading = "eager";
        point(copy, day);
        return decoded(img);
      });
      return Promise.race([Promise.all(ready), after(2500)]).then(() => {
        if (mine !== turns) return;
        for (const picture of shown) point(picture, day);
        root.dataset.theme = theme;
        root.classList.remove("unsettled");
        for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
          meta.content = GROUND[theme];
        say("lookout:turned", { theme });
      });
    };

    const choose = (theme) => {
      if (theme !== "light" && theme !== "dark") return Promise.resolve();
      kept = theme;
      try {
        localStorage.setItem(KEY, theme);
      } catch {
        // The choice then lasts for this visit.
      }
      markTheme();
      return turn(theme);
    };

    // Until a choice is made here, the switch follows the system.
    systemDay.addEventListener?.("change", markTheme);
    for (const input of [$("theme-night"), $("theme-day")])
      input?.addEventListener("change", () => choose(input.value));
    // The dashboard's own switches turn the page too.
    document.addEventListener("lookout:choose", (event) => {
      if (event.detail?.theme !== (isDay() ? "light" : "dark")) choose(event.detail?.theme);
    });
    if (kept) turn(kept);

    // ── Copy ───────────────────────────────────────────────────────────────
    //
    // Each button copies the text of the element it names, which the visitor
    // can see and select without script too. Where the clipboard refuses, the
    // text is selected, to be copied with the keyboard.
    const told = $("copied");
    const tell = (words) => {
      if (!told) return;
      told.textContent = "";
      // Said again even when the words are the same as last time.
      requestAnimationFrame(() => (told.textContent = words));
    };
    for (const button of document.querySelectorAll("button[data-copy-from]")) {
      const from = $(button.dataset.copyFrom);
      if (!from) continue;
      let timer = 0;
      button.addEventListener("click", () => {
        const text = from.textContent;
        const select = () => {
          getSelection()?.selectAllChildren(from);
          tell("Selected. Copy it with your keyboard.");
        };
        if (!navigator.clipboard?.writeText) return select();
        navigator.clipboard.writeText(text).then(() => {
          button.classList.add("is-copied");
          clearTimeout(timer);
          timer = setTimeout(() => button.classList.remove("is-copied"), 1600);
          tell(button.dataset.said ?? `Copied ${text}`);
        }, select);
      });
    }

    // ── Features coming into view ──────────────────────────────────────────
    if (root.classList.contains("reveals")) {
      const seen = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add("is-seen");
            seen.unobserve(entry.target);
          }
        },
        { rootMargin: "0px 0px -10% 0px", threshold: 0.15 },
      );
      for (const feature of document.querySelectorAll(".reveal")) seen.observe(feature);
      window.addEventListener("beforeprint", () => {
        for (const feature of document.querySelectorAll(".reveal"))
          feature.classList.add("is-seen");
      });
    }

    // ── The lamp ───────────────────────────────────────────────────────────
    const out = $("lamp-out");
    const lit = $("lamp-lit");
    if (!out || !lit || !waiting) return;

    let lamps = 0;
    // The lamp never lights before its picture can be drawn whole.
    const light = (on) => {
      const mine = ++lamps;
      (on ? decoded(waiting) : Promise.resolve()).then(() => {
        if (mine !== lamps) return;
        root.classList.toggle("lamp-out", !on);
      });
    };
    const set = (on) => {
      (on ? lit : out).checked = true;
      light(on);
    };
    // A press on the choice already made is still a hand on the switch, so a
    // click says so as well as a change. One press is said once.
    let saidAt = -Infinity;
    const pressed = () => {
      if (performance.now() - saidAt < 100) return;
      saidAt = performance.now();
      say("lookout:pressed", { lit: lit.checked });
    };
    for (const input of [out, lit]) {
      input.addEventListener("change", () => {
        light(lit.checked);
        pressed();
      });
      input.addEventListener("click", pressed);
    }
    document.addEventListener("lookout:lamp", (event) => set(event.detail?.lit === true));
  });
})(document.documentElement);
