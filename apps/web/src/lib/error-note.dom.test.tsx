import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { ErrorNote, Warning } from "./ui";

/**
 * A failure somebody can hear.
 *
 * `ErrorNote` is what two hundred and fifty-nine screens draw when a save,
 * a delete or a send comes back with an error. It appears under the button
 * that was just pressed, in red — and to somebody working by ear that is
 * nothing at all: the press did nothing they could tell, the page looked
 * unchanged, and the reason was a paragraph they had no way to know had
 * arrived.
 *
 * `role="alert"` is what makes it arrive. The test is here rather than in
 * the browser walk because the walk would have to break a request on every
 * screen to find the one that forgot.
 */

const mounted: Root[] = [];
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
});
afterAll(() => GlobalRegistrator.unregister());

function draw(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(node));
  return host;
}

test("a failed action announces itself", () => {
  const host = draw(<ErrorNote error={{ status: 500 }} />);
  const note = host.querySelector('[role="alert"]');
  expect(
    note,
    "ErrorNote is not a live region, so nobody is told",
  ).not.toBeNull();
  expect(note?.textContent).toBe("Something went wrong. Try again.");
});

test("the server's own sentence is the one announced", () => {
  const host = draw(
    <ErrorNote error={{ status: 422, serverMessage: "That code is taken." }} />,
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "That code is taken.",
  );
});

test("a refusal says what to do about it", () => {
  const forbidden = draw(<ErrorNote error={{ status: 403 }} />);
  expect(forbidden.querySelector('[role="alert"]')?.textContent).toBe(
    "Your role does not allow this.",
  );
  const expired = draw(<ErrorNote error={{ status: 401 }} />);
  expect(expired.querySelector('[role="alert"]')?.textContent).toBe(
    "Your session has expired. Sign in again.",
  );
});

/**
 * And the standing notes stay quiet.
 *
 * Most warnings in the product are on the screen when it draws — a setting
 * that is off, a period that is closed. An alert region announces what it
 * already holds, so marking those up would read a list of them at somebody
 * every time they arrived anywhere.
 */
test("a warning that was always there is not an alert", () => {
  const host = draw(<Warning>Usage reporting is off.</Warning>);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toBe("Usage reporting is off.");
});
