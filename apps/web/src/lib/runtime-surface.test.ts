import { expect, test } from "bun:test";
import { UI_MEMBERS } from "@sentrello/module-sdk/ui-runtime";
import type { SentrelloUi } from "@sentrello/module-sdk/ui-runtime";
import * as ui from "./ui";

/**
 * What modules are promised, and what Core actually exports, are the same list.
 *
 * Each module used to carry its own hand-written copy of this declaration —
 * eleven of them, none agreeing, several missing primitives that had existed
 * for months. A module can only use what its copy declares, so `Tabs` being
 * absent from three of them is the whole reason three modules hand-rolled tab
 * strips. One declaration, checked here against the real thing.
 */
test("every primitive the SDK promises modules is exported by ui.tsx", () => {
  const exported = new Set(Object.keys(ui));
  const missing = UI_MEMBERS.filter((name) => !exported.has(name));
  expect(missing).toEqual([]);
});

/**
 * The type side of the same question.
 *
 * The test above catches a name that went away. This catches a name whose
 * *shape* changed — a prop renamed, an argument added — which the runtime check
 * cannot see and which reaches a module as a broken screen rather than an error.
 */
test("ui.tsx still satisfies the declared surface", () => {
  const surface: SentrelloUi = ui;
  expect(typeof surface.Card).toBe("function");
});
