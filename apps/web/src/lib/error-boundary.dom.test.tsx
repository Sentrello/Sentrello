import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { ErrorBoundary } from "./error-boundary";

/**
 * The failure this exists to stop is total, not local.
 *
 * A render that throws with nothing above it to catch takes React's whole
 * tree down — header, rail, panel, screen — and leaves a white page. Until
 * this boundary there was none anywhere in the product, and the one place a
 * third-party module renders into the page had nothing around it at all.
 */

const mounted: Root[] = [];
// Unmounted rather than wiped, for the reason `row-menu.dom.test.tsx` gives:
// clearing the body behind React's back makes the next unmount throw.
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
});
afterAll(() => GlobalRegistrator.unregister());

function draw(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  // React writes the caught error to the console itself, on top of what the
  // boundary logs. Quietened so a passing run does not read like a failing
  // one; restored straight after, or the next test debugs in the dark.
  const wasError = console.error;
  console.error = () => {};
  try {
    act(() => root.render(node));
  } finally {
    console.error = wasError;
  }
  return host;
}

function Throws(): React.ReactElement {
  throw new Error("Cannot read properties of null (reading 'total')");
}

test("a screen that throws is replaced, and says which one", () => {
  const host = draw(
    <ErrorBoundary label="Projects">
      <Throws />
    </ErrorBoundary>,
  );
  expect(host.textContent).toContain("Projects stopped working");
});

/**
 * The claim on the screen is that everything else still works, so the thing
 * worth pinning is that the boundary contains the failure rather than merely
 * describing it: a sibling rendered beside it is still there.
 */
test("what is beside it keeps working", () => {
  const host = draw(
    <div>
      <p>The rail</p>
      <ErrorBoundary label="Projects">
        <Throws />
      </ErrorBoundary>
    </div>,
  );
  expect(host.textContent).toContain("The rail");
  expect(host.textContent).toContain("stopped working");
});

/**
 * The message, because on a self-hosted product the person reading it is
 * often the person who can report it usefully — and "something went wrong"
 * is not a bug report.
 */
test("the error itself is shown", () => {
  const host = draw(
    <ErrorBoundary label="Shop">
      <Throws />
    </ErrorBoundary>,
  );
  expect(host.textContent).toContain("reading 'total'");
});

test("a screen that does not throw is left alone", () => {
  const host = draw(
    <ErrorBoundary label="Shop">
      <p>Forty-one orders</p>
    </ErrorBoundary>,
  );
  expect(host.textContent).toBe("Forty-one orders");
});

/**
 * The top of the tree says something different, because "everything else
 * still works" is not true there — there is no header and no rail left to
 * move to, and the only way on is a reload.
 */
test("the one at the top offers the only way out it has", () => {
  const host = draw(
    <ErrorBoundary label="Sentrello" scope="app">
      <Throws />
    </ErrorBoundary>,
  );
  expect(host.textContent).toContain("Sentrello stopped working");
  expect(host.textContent).toContain("Reload");
  expect(host.textContent).not.toContain("Every other screen still works");
});

test("a screen boundary does not offer a reload button", () => {
  const host = draw(
    <ErrorBoundary label="Projects">
      <Throws />
    </ErrorBoundary>,
  );
  expect(host.textContent).toContain("Every other screen still works");
  expect(host.querySelector("button")).toBeNull();
});
