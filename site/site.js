/*
 * The page's first script. It is loaded in the head, so its first part runs
 * before the first paint and the page never shows one state and then takes it
 * back. Without it the page shows the lamp lit and follows the system's Night
 * or Day, and the two switches are not drawn.
 *
 * It does three things: puts back a Night or Day choice kept in this browser
 * and runs the Night and Day switch, holds the lamp, out or lit, with its
 * switch, and once the page has loaded fetches the tour, tour.js. The tour
 * tells it which the lamp is as it plays, and hears from it when either switch
 * is pressed. Nothing leaves this browser.
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
  // The page opens on the tour's first scene, with nothing waiting.
  root.classList.add("lamp-out");

  // The two switches are set as the parser reaches them, so no frame shows one
  // in a state the page is not in.
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

  // The tour's script comes once the page has loaded, so nothing it needs is
  // fetched before the first screen's picture.
  window.addEventListener(
    "load",
    () => {
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
    const pictures = [$("shot-out"), waiting].filter(Boolean).map((img) => img.parentNode);

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

    // The other theme's pictures are fetched and decoded on copies first, so
    // the page and its pictures turn together and the frame is never empty.
    // Once the dashboard has taken their place they are never shown again, so
    // they are neither waited for nor pointed at the other theme, and the
    // other theme's pictures are never fetched.
    let turns = 0;
    const turn = (theme) => {
      const day = theme === "light";
      const mine = ++turns;
      const live = root.querySelector(".tour.is-live") !== null;
      const ready = live
        ? []
        : pictures.map((picture) => {
            const copy = picture.cloneNode(true);
            point(copy, day);
            return decoded(copy.querySelector("img"));
          });
      return Promise.race([Promise.all(ready), after(2500)]).then(() => {
        if (mine !== turns) return;
        if (!live) for (const picture of pictures) point(picture, day);
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
