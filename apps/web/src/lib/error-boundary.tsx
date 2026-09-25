import { Component, type ErrorInfo, type ReactNode } from "react";
import { Empty, Warning } from "./ui";

/**
 * One screen failing instead of all of them.
 *
 * React unmounts the **entire tree** when a render throws and nothing catches
 * it: not the screen, the whole application — header, rail, panel and all —
 * replaced by a white page with no way back but a reload. Until this there
 * was no boundary anywhere in the product, so any module's screen could do
 * that to the business using it.
 *
 * That is this architecture's worst failure by shape. Modules are built in
 * other repositories, shipped as prebuilt scripts and loaded at runtime into
 * a page the host is responsible for. `module-ui.ts` already takes care that
 * a module whose script is *missing* leaves everything else working, and says
 * so in as many words — a module whose script loads and then throws on a null
 * had no such promise, and it is the likelier of the two.
 *
 * What it draws is deliberately not an apology. It names the screen, says
 * plainly that the rest still works — a claim the person can check by pressing
 * something — and shows the error, because on a self-hosted product the person
 * reading it is often the person who can report it usefully.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { failed?: Error }
> {
  state: { failed?: Error } = {};

  static getDerivedStateFromError(failed: Error) {
    return { failed };
  }

  componentDidCatch(failed: Error, info: ErrorInfo) {
    // The console, not a notice of its own: this is for whoever has devtools
    // open, and the person reading the screen already has the message.
    console.error(`[screen] ${this.props.label} threw`, failed, info);
  }

  render() {
    const { failed } = this.state;
    if (!failed) return this.props.children;

    return (
      <Empty title={`${this.props.label} stopped working`}>
        <p className="text-sm">
          Nothing else is affected. Every other screen still works, and
          reloading the page will try this one again.
        </p>
        {failed.message ? (
          <Warning className="mt-2 text-xs">{failed.message}</Warning>
        ) : null}
      </Empty>
    );
  }
}
