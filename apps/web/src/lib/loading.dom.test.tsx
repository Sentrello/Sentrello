import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Loading } from "./ui";

afterAll(() => GlobalRegistrator.unregister());

/**
 * What the product shows while it is still fetching.
 *
 * The shell drew nothing at all — `return null` — until the session and the
 * instance's own shape had answered. On the twenty milliseconds that usually
 * takes, that is right: a spinner inside one frame is a flicker. On a phone
 * on mobile data it made the whole product a blank rectangle for as long as
 * the network took, with nothing on it to tell loading from broken. Which is
 * the connection this product's own customer is most likely to be on,
 * standing in a workshop or a van.
 *
 * So: nothing for a fifth of a second, then a word. Both halves matter, and
 * both are held here — a delay nobody waits out is as bad as no delay.
 */
function draw(element: React.ReactElement) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  act(() => root.render(element));
  return { node, stop: () => act(() => root.unmount()) };
}

test("it says nothing at first, so a fast answer never flickers", () => {
  const { node, stop } = draw(<Loading after={200} />);
  expect(node.textContent).toBe("");
  stop();
});

test("and it speaks once the wait is long enough to notice", async () => {
  const { node, stop } = draw(<Loading after={20} />);
  expect(node.textContent).toBe("");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(node.textContent).toContain("Loading");
  stop();
});

/** No delay asked for is the old behaviour, for callers that want it now. */
test("asked for nothing, it says so immediately", () => {
  const { node, stop } = draw(<Loading />);
  expect(node.textContent).toContain("Loading");
  stop();
});
