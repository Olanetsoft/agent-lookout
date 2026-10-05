/*
 * The page's whole script. It is loaded in the head, so its first part runs
 * before the first paint and the page never shows one state and then takes it
 * back. Without it the page shows the lamp lit and follows the system's Night
 * or Day, and the two switches are not drawn.
 *
 * It does three things: puts back a Night or Day choice kept in this browser,
 * runs the Night and Day switch, and opens the page with nothing waiting
 * before it lights the lamp. Nothing leaves this browser.
 */
((root) => {
  const KEY = "agent-lookout-theme";
  const GROUND = { dark: "#090908", light: "#d4d0ca" };
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
  // The page opens with nothing waiting, unless motion is not wanted.
  if (matchMedia("(prefers-reduced-motion: no-preference)").matches) root.classList.add("lamp-out");

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

  const nothing = () => {};
  const after = (ms) => new Promise((done) => setTimeout(done, ms));
  /** Settles once a picture is fetched and decoded, or cannot be. */
  const decoded = (img) => (img && img.decode ? img.decode().catch(nothing) : Promise.resolve());
  /** Settles once somebody is looking at the page. */
  const watched = () =>
    new Promise((done) => {
      if (!document.hidden) return done();
      const look = () => {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", look);
        done();
      };
      document.addEventListener("visibilitychange", look);
    });

  document.addEventListener("DOMContentLoaded", () => {
    early.disconnect();
    markTheme();
    markLamp();
    // A switch slides only after the page has been drawn with it in place.
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("ready")));

    const $ = (id) => document.getElementById(id);
    const quiet = $("shot-out");
    const waiting = $("shot-lit");
    const pictures = [quiet, waiting].filter(Boolean).map((img) => img.parentNode);

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
    // The plate that theme shows is not drawn until then, so where a plate is
    // in use its pictures are fetched ahead as well.
    const plates = [...document.querySelectorAll(".plate-slot")];
    let turns = 0;
    const turn = (theme) => {
      const day = theme === "light";
      const mine = ++turns;
      const ready = pictures.map((picture) => {
        const copy = picture.cloneNode(true);
        point(copy, day);
        return decoded(copy.querySelector("img"));
      });
      if (plates.some((plate) => plate.getClientRects().length))
        for (const img of document.querySelectorAll(
          `.plate-slot.${day ? "by-day" : "at-night"} img`,
        )) {
          img.loading = "eager";
          ready.push(decoded(img));
        }
      return Promise.race([Promise.all(ready), after(2500)]).then(() => {
        if (mine !== turns) return;
        for (const picture of pictures) point(picture, day);
        root.dataset.theme = theme;
        root.classList.remove("unsettled");
        for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
          meta.content = GROUND[theme];
      });
    };

    const choose = (theme) => {
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
    document
      .querySelector("[data-turn]")
      ?.addEventListener("click", () => choose(isDay() ? "dark" : "light"));
    const settled = kept ? turn(kept) : Promise.resolve();

    // ── The lamp ───────────────────────────────────────────────────────────
    const out = $("lamp-out");
    const lit = $("lamp-lit");
    if (!out || !lit || !waiting) return;

    let touched = false;
    const show = () => root.classList.toggle("lamp-out", out.checked);
    // The lamp never lights before its picture can be drawn whole.
    const set = () => (lit.checked ? decoded(waiting).then(show) : show());
    for (const input of [out, lit]) input.addEventListener("change", set);
    // A press on the choice already made is still a hand on the switch.
    out.parentNode.addEventListener("click", () => (touched = true));

    if (!root.classList.contains("lamp-out")) return;

    // The one moment: nothing is waiting, and a second and a half after the
    // quiet picture is on the screen the lamp lights. Touching the switch
    // first calls that off. A waiting picture that cannot be fetched does too.
    let seen = 0;
    settled
      .then(watched)
      .then(() => decoded(quiet))
      .then(() => {
        seen = Date.now();
        return waiting.decode();
      })
      .then(() => after(Math.max(0, 1500 - (Date.now() - seen))))
      .then(() => {
        if (touched) return;
        lit.checked = true;
        show();
      })
      .catch(nothing);
  });
})(document.documentElement);
