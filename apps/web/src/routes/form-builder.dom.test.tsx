import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FormBuilder } from "./form-builder";

afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * The form builder, which had no test of its markup at all.
 *
 * It was rewritten on 25 September because the screen was hard to use, and
 * "hard to use" is not something a test catches. What a test can hold is the
 * structure the rewrite put in: a table with one row per question rather than
 * a wrapping list, a type that can be changed, and the per-answer panels
 * closed until somebody asks for them.
 */
const choice = {
  name: "what_brings_you",
  label: "What brings you here?",
  type: "radio",
  options: ["A quote", "Support"],
};
const text = { name: "name", label: "Your name", type: "text" };

function render(fields: (typeof text)[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <FormBuilder
          formId="frm_test"
          fields={fields}
          tag={null}
          style={null}
          redirectUrl={null}
          notifyEmail={null}
          onDone={() => {}}
        />
      </QueryClientProvider>,
    );
  });
  return host;
}

test("every question is a row, and every row has the same cells", () => {
  const host = render([text, choice]);
  const table = host.querySelector("table");
  expect(table).not.toBeNull();
  // The choice draws a second row for its answers, under its own question.
  expect(table?.querySelectorAll("tbody tr").length).toBe(3);
  // Six headers, and the last is the remove column, which has no name.
  const headers = [...(table?.querySelectorAll("th") ?? [])].map((th) =>
    th.textContent?.trim(),
  );
  expect(headers).toEqual([
    "Question",
    "Answered with",
    "Width",
    "Required",
    "Order",
    "",
  ]);
});

test("a question's type can be changed after it is made", () => {
  // It could not be. Asking for an email address as a text box meant deleting
  // the question and writing it out again.
  const host = render([text]);
  const select = host.querySelector<HTMLSelectElement>(
    'select[aria-label="How Your name is answered"]',
  );
  expect(select).not.toBeNull();
  expect(select?.value).toBe("text");
  expect(select?.options.length).toBeGreaterThan(5);
});

test("the per-answer panels are closed until somebody asks", () => {
  /*
   * A five-answer question used to draw five collapsibles of four unlabelled
   * inputs — twenty controls in one line of a list — for a feature the comment
   * beside it says most forms want none of.
   */
  const host = render([choice]);
  const opener = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "What each answer shows",
  );
  expect(opener).not.toBeUndefined();
  expect(opener?.getAttribute("aria-expanded")).toBe("false");
  // Nothing from the panels is in the document while it is shut.
  expect(host.textContent).not.toContain("What the link says");

  act(() => opener?.click());
  expect(host.textContent).toContain("What the link says");
});

test("the ends of the order cannot be pressed", () => {
  const host = render([text, choice]);
  const up = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Move Your name up"]',
  );
  const down = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Move What brings you here? down"]',
  );
  expect(up?.disabled).toBe(true);
  expect(down?.disabled).toBe(true);
});

test("Cancel asks before throwing work away, and only when there is work", () => {
  const host = render([text]);
  // Nothing touched: Cancel is a plain button that closes.
  expect(host.textContent).toContain("Cancel");
  expect(
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel")
      ?.className,
  ).toBeDefined();

  const required = host.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  act(() => required?.click());
  // Now there is something to lose, so Cancel is the two-step confirm.
  const cancel = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Cancel",
  );
  act(() => cancel?.click());
  expect(host.textContent).toContain("Throw away these changes?");
});
