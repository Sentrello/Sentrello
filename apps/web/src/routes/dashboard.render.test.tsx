import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationProvider } from "../lib/navigation";
import { HealthPanel, WhoOwesPanel } from "./dashboard";

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

/**
 * The cap the panel is told about has to reach the screen.
 *
 * The receivables report is paged — two hundred invoices by default, a
 * thousand at most — and the buckets and total beside them are still the whole
 * ledger. The server composes the sentence rather than sending a flag,
 * precisely because a flag is what `/api/contacts` sent when it capped at a
 * thousand rows: honest, received by five screens, rendered by none, and five
 * customer pickers quietly offered the first thousand names.
 *
 * Both directions, because a panel that printed a notice unconditionally would
 * pass the first of these and be a new defect.
 */
function owed(notice: string | null): string {
  (globalThis as { window?: unknown }).window = {
    location: { pathname: "/", search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  const qc = new QueryClient();
  qc.setQueryData(["reports", "accounts-receivable"], {
    invoices: [
      {
        invoiceId: "inv-1",
        number: "INV-0001",
        customerName: "A customer",
        currency: "USD",
        balanceDue: 125_00,
        ageDays: 40,
      },
    ],
    aging: { current: 0, days30: 0, days60: 125_00, days90plus: 0 },
    totalCents: 125_00,
    notice,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <NavigationProvider
        initial={{ moduleId: "dashboard", title: "Dashboard" }}
      >
        <WhoOwesPanel />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

test("a paged receivables report says on the panel what it cut", () => {
  const html = owed(
    "Showing 200 of 6,412 invoices owed to you, oldest first. The figures above cover all 6,412.",
  );
  expect(html).toContain("Showing 200 of 6,412 invoices owed to you");
  // The figures are the whole ledger and must not be hedged by the notice.
  expect(html).toContain("125.00");
});

test("a report that cut nothing says nothing", () => {
  const html = owed(null);
  expect(html).toContain("INV-0001");
  expect(html).not.toContain("Showing");
});
