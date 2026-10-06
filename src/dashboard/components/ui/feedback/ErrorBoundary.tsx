import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@dashboard/components/ui/controls/Button";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * The last line of defence. If drawing the page throws, this shows the error
 * presentation on a card of glass in its place, so a fault never leaves an
 * empty page that looks like nothing is running.
 *
 * "Try again" draws the page afresh. If the same data breaks it again, the
 * message comes back, and reloading is the next thing to try.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console for whoever reports it. Nothing is sent anywhere.
    console.error("Agent Lookout could not draw the page.", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section
        data-slot='page-error'
        aria-label='Page problem'
        className='glass-card mx-auto mt-[6vh] w-full max-w-[620px] p-5'
      >
        <Callout
          tone='error'
          title='Agent Lookout could not draw this page'
          action={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
        >
          <p>
            Something in the page itself went wrong. Your sessions are not affected: the page
            changes nothing in them unless you press Stop and confirm. If trying again does not
            help, reload the page.
          </p>
        </Callout>
        <FactList className='mt-3'>
          <FactRow label='What happened' mono>
            {error.message || error.name}
          </FactRow>
        </FactList>
      </section>
    );
  }
}
