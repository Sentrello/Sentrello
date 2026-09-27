import { useEffect, useRef } from "react";

/**
 * Work somebody has typed and not saved, and the one question worth asking
 * about it: is it about to disappear?
 *
 * The editors in this product replace the list in place — raise an invoice
 * and the invoice form *is* the screen, with the rail and the section panel
 * still beside it. One click on Contacts and eight lines of typing were
 * gone, with nothing asked and nothing kept. For a money product that is the
 * kind of loss somebody does not give you twice.
 *
 * **Dirtiness is measured, not declared.** Every editor here holds its
 * fields in a dozen pieces of `useState`, so a per-form `dirty` flag would
 * be a dozen comparisons written out per form, and wrong in one of them
 * within a month. This listens for a real edit instead, so it is true only
 * after somebody has actually changed something — and false for a form they
 * opened and thought better of.
 */
const editing = new Set<symbol>();

/** Whether anything on screen holds typing that has not been saved. */
export function hasUnsaved(): boolean {
  return editing.size > 0;
}

/**
 * Arm the guard while this editor holds unsaved typing.
 *
 * Call `settled()` after a successful save: the work is on the server then,
 * and the next thing the person does should not be interrupted.
 *
 * **Nothing here is React state, and that is the whole design.** The first
 * version held a `dirty` boolean in `useState`, and it ate the first letter
 * of every invoice. The listener is in the capture phase, so it runs before
 * React's own `onChange`: `setDirty(true)` re-rendered the form, React wrote
 * the old (empty) value back into the box, and the `onChange` that followed
 * read the box it had just cleared. One character, always the first,
 * perfectly reproducible — typing "Roofing" into a new invoice gave
 * "oofing". A guard against losing work must not lose any.
 *
 * **Scoped by a marker in the document, not by a ref.** An earlier attempt
 * took a ref to the editor's own page and never fired at all: an editor's
 * first render is `<Loading/>` while its lookups arrive, so the effect ran
 * against a ref that was still null and never ran again. A later one watched
 * the whole of `#screen`, which is too much — the contact and company forms
 * open *beside* their list, so typing in the list's filter box would have
 * armed a guard about the form. `<Page editor>` marks the editor itself and
 * the listener asks whether the edit happened inside one.
 */
export function useUnsaved(): { settled: () => void } {
  const mine = useRef(Symbol("editor"));

  useEffect(() => {
    const id = mine.current;
    /*
     * `input` and `change` both. `input` is every keystroke in a text field
     * and misses a `<select>` in some browsers; `change` catches the select
     * and the checkbox. Capture, so a component that stops propagation on
     * its own field — several do, to keep a keystroke out of a parent's
     * shortcut handler — cannot hide the edit from this.
     */
    const noticed = (e: Event) => {
      if ((e.target as Element | null)?.closest("[data-editor]")) {
        editing.add(id);
      }
    };
    document.addEventListener("input", noticed, true);
    document.addEventListener("change", noticed, true);

    /*
     * The browser's own question, for the half the in-app dialog cannot
     * answer: closing the tab, reloading, or following a link out of the
     * product never reaches our navigation. Every browser shows its own
     * wording here and ignores ours, which is fine — the point is that it
     * asks at all.
     */
    const ask = (e: BeforeUnloadEvent) => {
      if (!editing.has(id)) return;
      e.preventDefault();
      // Old browsers wanted a string back; current ones want the default
      // prevented. Both, because both cost nothing.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);

    return () => {
      document.removeEventListener("input", noticed, true);
      document.removeEventListener("change", noticed, true);
      window.removeEventListener("beforeunload", ask);
      editing.delete(id);
    };
  }, []);

  return {
    settled: () => {
      editing.delete(mine.current);
    },
  };
}
