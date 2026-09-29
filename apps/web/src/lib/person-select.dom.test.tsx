import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { type Manager, PersonSelect } from "./crm-settings";

afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode): HTMLElement {
  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  act(() => {
    createRoot(mountPoint).render(node);
  });
  return mountPoint;
}

const managers: Manager[] = [
  {
    userId: "u-ruth",
    name: "Ruth Adeyemi",
    email: "ruth@example.test",
    image: null,
    roles: ["sales"],
  },
];

/**
 * A record owned by somebody who has left must come back out of this screen
 * owned by them.
 *
 * A `<select>` whose value matches no option shows the first one, so the owner
 * of every record a leaver touched read as "Nobody yet" — and Save sent that,
 * giving the record away without anybody choosing to.
 */
test("somebody who has left is still the selected owner", () => {
  const host = mount(
    <PersonSelect value="u-priya" onChange={() => {}} managers={managers} />,
  );
  const select = host.querySelector("select") as HTMLSelectElement;
  expect(select.value).toBe("u-priya");
  expect(
    [...select.options].find((o) => o.value === "u-priya")?.textContent,
  ).toBe("Somebody who has left");
  // And the people who are still here are all still offered.
  expect([...select.options].map((o) => o.value)).toEqual([
    "",
    "u-priya",
    "u-ruth",
  ]);
});

test("a current member needs no such option", () => {
  const host = mount(
    <PersonSelect value="u-ruth" onChange={() => {}} managers={managers} />,
  );
  const select = host.querySelector("select") as HTMLSelectElement;
  expect(select.value).toBe("u-ruth");
  expect([...select.options].map((o) => o.textContent)).toEqual([
    "Nobody yet",
    "Ruth Adeyemi",
  ]);
});

test("nobody yet is nobody, not a phantom leaver", () => {
  const host = mount(
    <PersonSelect value="" onChange={() => {}} managers={managers} />,
  );
  const select = host.querySelector("select") as HTMLSelectElement;
  expect(select.value).toBe("");
  expect([...select.options].length).toBe(2);
});
