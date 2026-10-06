import { useEffect, useRef } from "react";

import { UPDATES_HASH } from "@core/appUpdate";
import { Button } from "@dashboard/components/ui/controls/Button";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { useAppUpdate } from "@dashboard/hooks/data/useAppUpdate";
import { useNow } from "@dashboard/hooks/data/useNow";
import { lastCheckedWords, updateWords } from "@dashboard/lib/updates/updateWords";

const SWITCH = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

/** The name of the switch, beside it and for assistive technology. */
const AUTOMATIC = "Check for updates automatically";

const LINK =
  "rounded-bar underline decoration-rule-strong underline-offset-2 transition-colors duration-120 hover:text-ink";

/**
 * Updates, in Settings, in the Mac app only: the app's version, whether it
 * checks GitHub by itself about once a day, when it last had an answer, and
 * Check for Updates…. When a newer version is found it says so, with its
 * release notes, and once it has been downloaded and checked, Install and
 * Restart, which is the only thing that installs it.
 *
 * The state is said in words beside the button, as notifications are. The
 * switch can always be flipped, so it is the segmented control. A version that
 * cannot be installed where the app runs, or a check that did not work, is
 * said in the info note, with a link to the release page. Nothing here is
 * warm. Before the app has answered, the card says nothing.
 */
export function UpdatesCard() {
  const { reading, pressed, check, install, setAutomatic } = useAppUpdate();
  // "Last checked" says the day once the check was not today.
  const now = useNow();
  const card = useRef<HTMLElement>(null);

  // The app menu's Check for Updates… opens Settings at this card.
  useEffect(() => {
    const reveal = () => {
      if (window.location.hash === UPDATES_HASH) card.current?.scrollIntoView({ block: "nearest" });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);

  const status = reading === null || reading === "unknown" ? null : reading;
  const words = status === null ? null : updateWords(status);

  return (
    <SectionCard ref={card} title='Updates' data-part='updates'>
      <div className='px-6 pb-6'>
        {/* As tall as its button, so what follows keeps its place when there is none. */}
        <div className='flex min-h-button flex-wrap items-center gap-x-3 gap-y-2'>
          {/* Said again to a screen reader when it changes. */}
          <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
            {reading === "unknown"
              ? "Whether a newer version is out could not be read."
              : words?.state}
          </p>
          {words !== null &&
            (words.install ? (
              <Button size='sm' onClick={install} disabled={pressed !== null}>
                Install and Restart
              </Button>
            ) : (
              <Button size='sm' onClick={check} disabled={!words.canCheck || pressed !== null}>
                Check for Updates…
              </Button>
            ))}
        </div>

        {words !== null && (words.detail !== null || words.notesUrl !== null) && (
          <p data-part='found' className='mt-1 text-body text-ink-secondary'>
            {words.detail}
            {words.detail !== null && words.notesUrl !== null && " "}
            {words.notesUrl !== null && (
              <a href={words.notesUrl} target='_blank' rel='noreferrer' className={LINK}>
                Release notes
              </a>
            )}
          </p>
        )}

        {words?.note && (
          <Callout title={words.note.title} className='mt-3'>
            <p>
              {words.note.detail}{" "}
              <a href={words.note.link} target='_blank' rel='noreferrer' className={LINK}>
                Release page
              </a>
            </p>
          </Callout>
        )}

        {status !== null && (
          <>
            <div className='mt-3 flex items-center justify-between gap-6 border-b border-hairline py-2'>
              {/* The switch carries the same name, so this is not read twice. */}
              <span aria-hidden className='text-body text-ink'>
                {AUTOMATIC}
              </span>
              <SegmentedControl
                label={AUTOMATIC}
                value={status.automatic ? "on" : "off"}
                onValueChange={(value) => setAutomatic(value === "on")}
                options={SWITCH}
              />
            </div>
            <FactList>
              <FactRow label='Version' mono>
                v{status.version}
              </FactRow>
              <FactRow label='Last checked'>
                <span className='tabular-nums'>{lastCheckedWords(status, now)}</span>
              </FactRow>
            </FactList>
          </>
        )}

        <p className='mt-3 text-body text-ink-secondary'>
          Agent Lookout asks GitHub whether a newer version has been released when you press Check
          for Updates…, and about once a day while Check for updates automatically is on. It sends
          nothing about your sessions: GitHub sees the app's version number and your IP address, as
          with any web request.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          A newer version is downloaded and checked first, and installed only when you press Install
          and Restart. To update itself, Agent Lookout must be in a folder it can change, such as
          Applications.
        </p>
      </div>
    </SectionCard>
  );
}
