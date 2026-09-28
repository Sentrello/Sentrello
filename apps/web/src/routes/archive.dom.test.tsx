import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { namelessControls } from "../lib/accessible-dom";
import { Archive } from "./archive";

afterAll(() => GlobalRegistrator.unregister());

/**
 * Every control on the archive screen says what it is.
 *
 * The file input that takes an archive back was written bare — no label, no
 * `aria-label`. A file input with no name is announced as "button", so the
 * screen presented somebody using a screen reader with an unnamed button on a
 * page whose other two buttons write to and delete from the live tables. Axe
 * rates that critical and the browser suite failed on it.
 *
 * The whole screen rather than that one input, because the fault was not
 * special: it is what happens when a control is written without the Field the
 * rest of the platform uses, and the next one will be written the same way.
 */
const answers: Record<string, unknown> = {
  "/api/archive/sets": {
    sets: [
      {
        id: "activity",
        label: "Activity and history",
        description: "Record history, older than the retention floor.",
        statutory: false,
        requiresClosedBooks: false,
        carriesForward: false,
      },
    ],
    retention: { years: 6, countryCode: "GB", cutoff: "2019-01-01" },
  },
  "/api/archive/plan": {
    set: "activity",
    from: "2018-01",
    to: "2018-12",
    counts: [{ table: "record_events", rows: 12 }],
    rows: 12,
    blockers: [{ kind: "retention", message: "GB means 6 years." }],
    retention: { years: 6, countryCode: "GB", cutoff: "2019-01-01" },
  },
  "/api/archive/runs": {
    runs: [
      {
        id: "run-1",
        setId: "activity",
        periodFrom: "2018-01-01",
        periodTo: "2018-12-31",
        filename: "activity-2018.zip",
        status: "done",
        bytes: 2048,
        sha256: "abc",
        rows: [{ table: "record_events", rows: 12 }],
        removedRows: null,
        carriedForward: [],
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        present: true,
      },
    ],
  },
  "/api/archive/destination": {
    id: "folder",
    defaultDirectory: "/var/lib/sentrello",
    values: {},
    set: [],
    available: [
      {
        id: "folder",
        label: "A folder on this machine",
        description: "Writes into this instance's data directory.",
        fields: [
          {
            name: "directory",
            label: "Directory",
            placeholder: "/var/lib/sentrello",
            help: "Where the zip is written.",
          },
        ],
      },
    ],
  },
};

globalThis.fetch = (async (input: RequestInfo | URL) =>
  new Response(
    JSON.stringify(answers[String(input).split("?")[0] ?? ""] ?? {}),
    { headers: { "content-type": "application/json" } },
  )) as typeof fetch;

test("nothing on the archive screen is a control with no name", async () => {
  const point = document.createElement("div");
  document.body.append(point);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    createRoot(point).render(
      <QueryClientProvider client={client}>
        <Archive />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });

  // The screen drew, rather than sitting on its spinner — an empty page passes
  // every accessibility question ever asked of it.
  expect(point.textContent).toContain("Put one back");
  expect(point.querySelector('input[type="file"]')).not.toBeNull();

  expect(namelessControls(point)).toEqual([]);
});
