import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationProvider } from "../lib/navigation";
import { HealthPanel } from "./dashboard";

/**
 * Whether this instance is on the current release, said on the screen somebody
 * opens every morning rather than only on Settings.
 *
 * Three states and not two, which is the whole point of testing it. A Free
 * instance never phones home unless somebody asks it to, so "there is nothing
 * newer" and "we have not looked" are different answers and only one of them
 * is "up to date". Claiming the wrong one is not hypothetical: an instance sat
 * on 0.26.7 being told 0.27.9 was not out, because a version it could not
 * parse was read as no update rather than as no answer.
 */

const HEALTH = {
  version: "v0.27.9+abc1234",
  uptimeSeconds: 3600,
  database: { reachable: true, sizeBytes: 12_000_000 },
  disk: {
    freeBytes: 50_000_000_000,
    totalBytes: 100_000_000_000,
    usedPercent: 50,
  },
  memory: { usedBytes: 100_000_000, totalBytes: 800_000_000 },
};

function render(updates: unknown): string {
  (globalThis as { window?: unknown }).window = {
    location: { pathname: "/", search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  const qc = new QueryClient();
  if (updates !== undefined) qc.setQueryData(["updates"], updates);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <NavigationProvider
        initial={{ moduleId: "dashboard", title: "Dashboard" }}
      >
        <HealthPanel health={HEALTH} />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

test("a newer release is named, not merely hinted at", () => {
  const html = render({
    current: "0.27.9",
    latest: "0.28.0",
    updateAvailable: true,
  });
  expect(html).toContain("0.28.0 is out");
});

test("an instance that has looked and is current says so", () => {
  const html = render({
    current: "0.27.9",
    latest: "0.27.9",
    updateAvailable: false,
  });
  expect(html).toContain("up to date");
});

/**
 * The state that matters most, and the one a two-state design gets wrong.
 *
 * Free holds no licence to identify itself with and does not phone home until
 * somebody presses for it, so `latest` is null. "Up to date" here would be a
 * claim nobody has earned.
 */
test("an instance that has not looked does not claim to be current", () => {
  const html = render({
    current: "0.27.9",
    latest: null,
    updateAvailable: false,
  });
  expect(html).toContain("not checked");
  expect(html).not.toContain("up to date");
});

/**
 * Somebody who cannot update the instance is told nothing about updates.
 *
 * The endpoint is behind `settings:read`. A refusal shows no line at all
 * rather than an error on the dashboard of somebody who could do nothing about
 * it anyway.
 */
test("no answer means no line, not an error", () => {
  const html = render(undefined);
  expect(html).toContain("This server");
  expect(html).not.toContain("up to date");
  expect(html).not.toContain("not checked");
});
