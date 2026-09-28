import { act } from "react";

/**
 * Typing into a box, in a test, so that the component actually sees it.
 *
 * **React's `onChange` does not fire for a text input under happy-dom.** Not
 * for a controlled one, not for an uncontrolled one, and not for any of the
 * usual ways of faking a keystroke — assigning `value` and dispatching
 * `input`, dispatching `change`, or writing through the prototype's own
 * setter first so React's value tracker sees a difference. `onInput` fires
 * from the same event. `onChange` on a `<select>` fires. A text input's does
 * not.
 *
 * That matters more than it sounds, because the failure is silent: the event
 * goes out, nothing throws, the box stays empty and the test carries on
 * asserting about a form nobody filled in. `forgot-password.dom.test.tsx`
 * had done exactly that since it was written — it typed a password, pressed
 * submit, and passed on a stub that would have answered the same way to an
 * empty one. Found 2026-09-28, while writing the currency picker's tests.
 *
 * So this calls the handler React would have called, with the DOM in the
 * state React would have handed it. What that skips is React's event
 * delegation, which is React's code and not ours; what it exercises is the
 * component's own `onChange`, its state, and everything the value reaches —
 * which is the whole of what a test here is entitled to claim.
 *
 * Use it for every `input` and `textarea`. A `select` needs none of this:
 * assign `value` and dispatch `change`.
 */
export function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const props = key
    ? (el as unknown as Record<string, { onChange?: (e: unknown) => void }>)[
        key
      ]
    : undefined;
  if (!props?.onChange) {
    throw new Error(
      `nothing is listening for changes on ${el.getAttribute("aria-label") ?? el.tagName} — is it a React-rendered field?`,
    );
  }

  /*
   * Through the prototype's setter, so React's value tracker is left holding
   * the old one. It costs nothing here and keeps the DOM in the state a real
   * keystroke leaves it in, which is what anything reading `el.value` later
   * in the same test will expect.
   */
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    props.onChange?.({ target: el, currentTarget: el });
  });
}
