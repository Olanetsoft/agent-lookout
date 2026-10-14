/*
 * The frame on the first screen: the real dashboard, from /tour, laid over
 * the two pictures of it once it has drawn what the picture under it shows,
 * with a session waiting or with nothing waiting, as the lamp's switch says.
 * Nothing in it acts on a session or leaves this page.
 *
 * A clear cover lies over it, so a wheel or a finger over the frame always
 * scrolls the page. A tap on the cover gives the dashboard to the visitor and
 * lands where it was made; Escape in the frame, or Start again, gives it back.
 */
const root = document.documentElement;
const figure = document.getElementById("tour");
if (figure && root.classList.contains("js")) begin(figure);

function begin(figure) {
  const screen = figure.querySelector(".screen");
  const cover = figure.querySelector(".window-cover");
  const reset = figure.querySelector(".window-reset");
  if (!screen || !cover) return;

  // The scenes of src/site-tour/feed/scenes.ts the frame shows, by their place
  // there: the two its pictures are of. The scenes test holds them to that order.
  const QUIET = 0; // One screen
  const WAITING = 1; // Needs you

  // The window the dashboard is drawn in: the app's, or a phone's on a narrow screen.
  const WINDOW = { width: 1440, height: 900 };
  const PHONE = { width: 390, height: 720 };
  const phone = matchMedia("(width < 901px)");
  const say = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

  let frame = null;
  let live = false;
  let yours = false;
  let lit = !root.classList.contains("lamp-out");
  let appWidth = WINDOW.width;

  const post = (message) => {
    if (live) frame?.contentWindow?.postMessage(message, location.origin);
  };
  const scene = () => post({ type: "scene", index: lit ? WAITING : QUIET, step: 0, lamp: null });
  const theme = () => {
    const chosen = root.dataset.theme;
    if (chosen === "light" || chosen === "dark") post({ type: "theme", theme: chosen });
  };

  /**
   * The dashboard is drawn at its window's own size at every width, and scaled
   * to the screen's, which has the window's shape. So the whole window shows at
   * once, as its picture does, and the layout never changes with the page.
   */
  const fit = () => {
    const w = screen.clientWidth;
    if (w === 0) return;
    const size = phone.matches ? PHONE : WINDOW;
    appWidth = size.width;
    screen.style.setProperty("--tour-width", `${size.width}px`);
    screen.style.setProperty("--tour-height", `${size.height}px`);
    screen.style.setProperty("--tour-scale", String(w / size.width));
  };
  new ResizeObserver(fit).observe(screen);
  phone.addEventListener("change", fit);

  const load = () => {
    if (frame) return;
    frame = document.createElement("iframe");
    frame.src = "/tour";
    frame.title = "The Agent Lookout dashboard";
    fit();
    (screen.querySelector(".screen-view") ?? screen).append(frame);
  };

  // After the page's load, while the browser is idle and somebody looks. With
  // Save-Data on, the dashboard is fetched only once somebody taps the frame.
  const loadLater = () => {
    const idle = window.requestIdleCallback ?? ((then) => setTimeout(then, 300));
    idle(
      () => {
        if (!document.hidden) return load();
        const look = () => {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", look);
          load();
        };
        document.addEventListener("visibilitychange", look);
      },
      { timeout: 3000 },
    );
  };
  if (navigator.connection?.saveData !== true) {
    if (document.readyState === "complete") loadLater();
    else window.addEventListener("load", loadLater, { once: true });
  }

  const takeOver = () => {
    if (yours || !live) return;
    yours = true;
    figure.classList.add("is-yours");
    if (reset) reset.hidden = false;
    post({ type: "mode", mode: "yours" });
  };

  const giveBack = () => {
    if (!yours) return;
    yours = false;
    // The keyboard comes back to the page, to the lamp's switch.
    if (frame && document.activeElement === frame) {
      document.getElementById(lit ? "lamp-lit" : "lamp-out")?.focus();
    }
    figure.classList.remove("is-yours");
    if (reset) reset.hidden = true;
    post({ type: "mode", mode: "tour" });
    scene();
  };
  reset?.addEventListener("click", () => {
    giveBack();
    document.getElementById(lit ? "lamp-lit" : "lamp-out")?.focus();
  });

  // A tap on the cover: the dashboard is fetched if it is not yet, or given over
  // with the tap landing where it was made, in the dashboard's own pixels.
  let down = null;
  cover.addEventListener("pointerdown", (event) => {
    down = { x: event.clientX, y: event.clientY, at: event.timeStamp };
  });
  cover.addEventListener("pointerup", (event) => {
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

  // The lamp's switch: whatever the dashboard shows, it shows that moment. From
  // Needs you, nothing waiting is the moment after the wait was answered.
  document.addEventListener("lookout:pressed", (event) => {
    lit = event.detail?.lit === true;
    post({ type: "lamp", lamp: lit ? "waiting" : "quiet" });
  });
  document.addEventListener("lookout:turned", theme);

  window.addEventListener("message", (event) => {
    if (!frame || event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (typeof message !== "object" || message === null) return;
    switch (message.type) {
      case "ready":
        if (live) return;
        live = true;
        theme();
        scene();
        // Shown once it has drawn the scene it was just given.
        requestAnimationFrame(() => requestAnimationFrame(() => figure.classList.add("is-live")));
        return;
      case "lamp":
        // While it is theirs, the switch and the window's line follow what the visitor did.
        if (yours && typeof message.waiting === "number") {
          lit = message.waiting > 0;
          say("lookout:lamp", { lit });
        }
        return;
      case "took-over":
        takeOver();
        return;
      case "theme":
        say("lookout:choose", { theme: message.theme });
        return;
      case "leave":
        giveBack();
        return;
    }
  });
}
