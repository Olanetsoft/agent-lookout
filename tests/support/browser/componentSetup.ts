// Loaded before every browser test, so Tailwind utilities, the colour tokens and
// the bundled fonts resolve exactly as they do in the app. The stylesheet reads
// no file in tests/, so a class that only a test names makes no rule.
import "@dashboard/styles/index.css";

import { beforeEach } from "vitest";
import { commands } from "vitest/browser";

import "./media";

// Every test starts on a computer that asks for no less motion than usual,
// whatever the one running the tests asks. Windows Server, as CI runs it, has
// its animations off, which the browser there reads as a wish for less motion.
// A test that wants less asks for it with `preferReducedMotion`.
beforeEach(async () => {
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});
