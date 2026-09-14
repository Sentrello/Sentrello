/**
 * Where a screen's title line comes from.
 *
 * The shell owns the header — breadcrumb, heading, and two empty slots. A
 * screen fills the slots by rendering these anywhere in its own tree, so the
 * primary action sits in the same place on all hundred-odd screens instead of
 * wherever each screen happened to put its toolbar.
 *
 * A portal rather than state handed up to the shell: the button stays in the
 * screen's tree, so its handlers see the screen's current state. Passing the
 * node upward captures it once, and the next render leaves the header holding
 * a button that closes over values that have moved on.
 */
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

function useSlot(id: string): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  /*
   * After the commit, when the shell's own markup is in the document. The
   * header is drawn by an ancestor, and an ancestor's DOM exists before any
   * descendant effect runs.
   */
  useEffect(() => setSlot(document.getElementById(id)), [id]);
  return slot;
}

/** The screen's primary actions, drawn at the right-hand end of the title line. */
export function PageActions({ children }: { children: ReactNode }) {
  const slot = useSlot("page-actions");
  return slot ? createPortal(children, slot) : null;
}

/** One line under the title, for what the screen is showing right now. */
export function PageSubtitle({ children }: { children: ReactNode }) {
  const slot = useSlot("page-subtitle");
  return slot ? createPortal(children, slot) : null;
}
