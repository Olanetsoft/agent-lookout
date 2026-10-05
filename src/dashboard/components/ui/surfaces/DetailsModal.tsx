import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef, type ReactNode } from "react";

import { Button } from "@dashboard/components/ui/controls/Button";
import { cn } from "@dashboard/lib/utils";

const SIZES = {
  sm: "w-[min(440px,100%)]",
  default: "w-[min(600px,100%)]",
  /** Room for a chart. */
  wide: "w-[min(760px,100%)]",
} as const;

interface DetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  size?: keyof typeof SIZES;
  children: ReactNode;
}

/**
 * The dialog that shows the history behind a count. It is floating glass: the
 * densest tint with real blur behind it, a rim of light, the deepest shadow and
 * the panel's 24px corners, over a flat scrim. Radix Dialog does the hard parts:
 * it traps focus and closes on Escape and on a click outside.
 *
 * Radix returns focus to a `Dialog.Trigger`, and this dialog has none: a count
 * opens it from its own button. So the dialog remembers what had focus when it
 * opened and gives focus back to it on close.
 *
 * Closing is animated as well as opening: the scrim and the dialog fade, and the
 * dialog drops a little. Radix keeps each element in the page for as long as its
 * closing animation runs, which is why the scrim, the overlay and the dialog each
 * carry one. Focus goes back to the opener once the dialog has gone.
 */
export function DetailsModal({
  open,
  onOpenChange,
  title,
  description,
  size = "default",
  children,
}: DetailsModalProps) {
  const opener = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <div
          aria-hidden
          data-slot='scrim'
          data-state={open ? "open" : "closed"}
          className='fixed inset-0 z-40 bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in'
        />
        <Dialog.Overlay className='fixed inset-0 z-50 overflow-y-auto px-4 pt-[6vh] pb-24 data-[state=closed]:animate-fade-out'>
          <Dialog.Content
            data-slot='details-modal'
            className={cn(
              "glass-float glass-blur mx-auto px-6 pt-5 pb-6",
              "data-[state=closed]:animate-drop data-[state=open]:animate-rise-fast",
              SIZES[size],
            )}
            {...(description ? {} : { "aria-describedby": undefined })}
            onOpenAutoFocus={() => {
              // Focus has not moved into the dialog yet, so this is still the opener.
              opener.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              opener.current?.focus();
              opener.current = null;
            }}
          >
            <header className='flex items-start justify-between gap-4'>
              <div className='min-w-0'>
                <Dialog.Title className='text-title font-semibold'>{title}</Dialog.Title>
                {description && (
                  <Dialog.Description className='mt-1 max-w-[56ch] text-body text-ink-secondary'>
                    {description}
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close asChild>
                <Button size='icon' aria-label='Close'>
                  <X aria-hidden className='size-4' strokeWidth={1.75} />
                </Button>
              </Dialog.Close>
            </header>
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
