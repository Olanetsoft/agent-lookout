import type { ComponentProps } from "react";
import { AnimatePresence, domAnimation, LazyMotion, m, MotionConfig as Config } from "motion/react";

/**
 * Motion as the tour gives it to the dashboard: scripts/site-tour/build.mjs
 * points the dashboard's `motion/react` here. The dashboard animates one thing
 * with Motion, the Overview fading in and out as it changes, in App.tsx, and
 * that takes only Motion's animations and their exit, which `domAnimation`
 * holds. So the tour loads those and leaves out the layout animations and the
 * dragging that `motion` carries, 13 KB of the tour gzipped. The build stops
 * when the dashboard asks Motion for a name this file does not give, or for
 * layout or dragging.
 */
export { AnimatePresence, m as motion };

/** Motion's settings, over the features the tour loads. */
export function MotionConfig(props: ComponentProps<typeof Config>) {
  return (
    <LazyMotion features={domAnimation}>
      <Config {...props} />
    </LazyMotion>
  );
}
