import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { InvoiceForm } from "./invoice-form";

afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * Which tax a US customer is charged, at a business with more companies than
 * an unpaged list will return.
 *
 * The form used to fetch `/api/companies` whole and look the customer's
 * company up in the browser. That route is capped at a thousand rows and says
 * `truncated: true` when it has cut; nothing here read the flag. So past the
 * thousandth company the address was simply not found, the offer to use the
 * customer's own rates never appeared, and the invoice went out with no tax
 * on it. Quieter than a missing customer and worse: the document looks
 * finished, and the figure on it is wrong.
 *
 * The stand-in below is the real route's behaviour — the same cap, the same
 * silence about it — and the company that matters sorts last, which is
 * exactly where the cut falls.
 */
const CAP = 1000;

/** 6.25%, in millionths. Texas's state rate, and the right answer here. */
const TEXAS_PPM = 62_500;
/** 7.25%, in millionths. California's, and the wrong answer. */
const CALIFORNIA_PPM = 72_500;

const companies = Array.from({ length: 1200 }, (_, i) => ({
  id: `co-${i}`,
  name: `${String(i).padStart(4, "0")} Holdings`,
  country: "US",
  // Everybody is in California except the last one, so "found a company" and
  // "found the *right* company" cannot be mistaken for each other.
  state: i === 1199 ? "TX" : "CA",
  city: i === 1199 ? "Austin" : "Fresno",
  postcode: i === 1199 ? "78701" : "93701",
}));

/** The customer, at the company that sorts last. */
const buyer = { id: "contact-1", name: "Zeta Buyer", companyId: "co-1199" };

const taxes = [
  {
    id: "tax-ca",
    name: "California sales tax",
    ratePpm: CALIFORNIA_PPM,
    rateBp: CALIFORNIA_PPM / 100,
    categoryCode: "standard",
    compound: false,
    isDefault: false,
    active: true,
  },
  {
    id: "tax-tx",
    name: "Texas sales tax",
    ratePpm: TEXAS_PPM,
    rateBp: TEXAS_PPM / 100,
    categoryCode: "standard",
    compound: false,
    isDefault: false,
    active: true,
  },
];

/** One invoice already raised for that customer: a hundred dollars, no tax. */
const invoice = {
  invoice: {
    contactId: buyer.id,
    notes: null,
    templateId: null,
    discountType: null,
    discountValue: null,
    dueDate: null,
    paymentTerms: null,
    buyerReference: null,
    exemptionCertificateId: null,
  },
  contact: buyer,
  lines: [
    {
      description: "Roof survey",
      quantityMilli: 1000,
      unitPriceCents: 10_000,
      unit: "piece",
      taxDefinitionId: null,
      taxes: null,
    },
  ],
};

let asked: string[] = [];
/** What the last save sent, so a test can read the body rather than infer it. */
let sent: Record<string, unknown> | null = null;
/**
 * What the settings route says about currency.
 *
 * Null is an instance that has never recorded a rate, which is nearly all of
 * them — and the answer the two tax tests above run against, so the picker
 * has to be absent for them to keep passing.
 */
let money: { baseCurrency: string; currencies: string[] } | null = null;
/** What the business sells, which is also the only way to fill a line in. */
let catalogue: {
  id: string;
  name: string;
  description: string;
  unitPriceCents: number;
  unit: string;
  taxDefinitionId: string | null;
  active: boolean;
}[] = [];

function serve(url: string): unknown {
  asked.push(url);
  const at = new URL(url, "http://localhost");
  const params = at.searchParams;

  switch (at.pathname) {
    case "/api/contacts": {
      const q = (params.get("q") ?? "").toLowerCase();
      const matched = [buyer].filter((c) => c.name.toLowerCase().includes(q));
      return { contacts: matched, total: matched.length };
    }
    case "/api/companies": {
      // The route as it stands: a thousand rows, sorted, and an honest flag
      // that used to go unread. The customer's company is not among them.
      const rows = companies.slice(0, CAP);
      return {
        companies: rows,
        total: rows.length,
        ...(companies.length > CAP ? { truncated: true } : {}),
      };
    }
    case "/api/invoicing/us-taxes": {
      // The server resolves the address from the customer, which is the whole
      // point: the browser cannot see past the cap. The old `state`/`city`
      // parameters still answer, so this fails on the lookup being impossible
      // rather than on the route having changed shape.
      const contactId = params.get("contactId");
      const company = contactId
        ? companies.find((c) => c.id === buyer.companyId)
        : companies.find(
            (c) => c.state === (params.get("state") ?? "").toUpperCase(),
          );
      if (!company) return { source: "manual", taxes: [] };
      const applies = company.state === "TX" ? "tax-tx" : "tax-ca";
      return { source: "manual", taxes: taxes.filter((t) => t.id === applies) };
    }
    case "/api/invoices/inv-1":
      return invoice;
    case "/api/invoicing/taxes":
      return { taxes, categories: [] };
    case "/api/invoicing/items":
      return { items: catalogue };
    case "/api/invoicing/templates":
      return { templates: [] };
    case "/api/invoicing/exemptions":
      return { certificates: [] };
    case "/api/invoicing/settings":
      return {
        ...(money ?? {}),
        settings: { paymentTermOptions: [], units: ["piece"] },
      };
    case "/api/invoices":
      return { invoice: { id: "inv-new", number: "INV-002" } };
    default:
      throw new Error(`the form asked for ${url}, which nothing here serves`);
  }
}

/**
 * The stub goes on for each test and comes off after it.
 *
 * It used to be a bare assignment at module scope. Bun loads every test file
 * into one process before it runs any of them, so four files each installing
 * their own `globalThis.fetch` at import time left whichever loaded last
 * serving all four — and a form asking for a URL that file does not know
 * about fell through to the real network. That is the ECONNREFUSED that has
 * been read as contention twice: 2,284 tests pass and two fail, never the
 * same two, and never when the file is run on its own.
 */
const realFetch = globalThis.fetch;
beforeEach(() => {
  money = null;
  sent = null;
  catalogue = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify(serve(String(input))), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mount(node: React.ReactNode): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const point = document.createElement("div");
  document.body.append(point);
  act(() => {
    createRoot(point).render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    );
  });
  return point;
}

/** The picker's debounce, then whatever the queries do with their answers. */
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function labelled<T extends Element>(host: HTMLElement, label: string): T {
  const found = host.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`nothing on the form is labelled "${label}"`);
  return found;
}

/** The offer to apply the customer's own jurisdictions' rates. */
function localRatesOffer(host: HTMLElement): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("local rates"),
  );
  if (!found) {
    throw new Error("the form offered no local rates for this customer");
  }
  return found;
}

test("a customer at the twelve-hundredth company gets that company's rate", async () => {
  asked = [];
  const host = mount(<InvoiceForm onDone={() => {}} />);
  await settle();

  // Chosen the way somebody chooses one: focus the picker, take what it offers.
  const search = host.querySelector<HTMLInputElement>('input[type="search"]');
  if (!search) throw new Error("the form drew no customer picker");
  act(() => {
    search.dispatchEvent(new Event("focusin", { bubbles: true }));
  });
  await settle();
  const option = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === buyer.name,
  );
  if (!option) throw new Error("the picker did not offer the customer");
  click(option);
  await settle();

  // The offer exists at all: the old code looked this company up in a list
  // that stopped 199 rows short of it and concluded there was no address.
  click(localRatesOffer(host));
  await settle();

  // Texas, because that is where this customer is — not California, which
  // 1,199 of the 1,200 companies are in and which any "found something"
  // assertion would have accepted.
  expect(labelled<HTMLSelectElement>(host, "Line 1 tax 1").value).toBe(
    "tax-tx",
  );

  // And never by fetching the companies table, which is where the silence was.
  expect(asked.some((url) => url.startsWith("/api/companies"))).toBe(false);
});

test("the tax that lands on the invoice is that state's, in cents", async () => {
  asked = [];
  const host = mount(<InvoiceForm documentId="inv-1" onDone={() => {}} />);
  await settle();

  click(localRatesOffer(host));
  await settle();

  // $100.00 at Texas's 6.25% is $6.25 of tax and $106.25 owed. California's
  // 7.25% would read $7.25, and the old outcome — no address found, so no
  // rate offered — left an invoice for a flat $100.00.
  expect(host.textContent).toContain("$6.25");
  expect(host.textContent).toContain("$106.25");
  expect(host.textContent).not.toContain("$7.25");
  expect(asked.some((url) => url.startsWith("/api/companies"))).toBe(false);
});

function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** The currency picker, or nothing when the form drew none. */
function currencyPicker(host: HTMLElement): HTMLSelectElement | undefined {
  return [...host.querySelectorAll("select")].find((s) =>
    [...s.options].some((o) => o.value === "EUR"),
  );
}

/**
 * An invoice in the customer's money, raised from the form that raises one.
 *
 * All of the machinery shipped and none of it could be reached. A rate is
 * stored per document, converted into the ledger at that rate, carried
 * through settlement gain and loss and period-end revaluation, and Pro has a
 * screen to record a rate on. The form hard-coded `"USD"`, then omitted the
 * field entirely — so the only currency a business could invoice in was its
 * own, while multi-currency sat on the price list the whole time. Found
 * 2026-09-28.
 *
 * Driven through the catalogue rather than by typing: React's `onChange`
 * never fires for a text input under happy-dom, so a test that types into
 * one and then asserts on the result is asserting on an empty form. Every
 * control touched below is a `select`, which does work.
 */
test("a business with no rates recorded is never asked which currency", async () => {
  const host = mount(<InvoiceForm onDone={() => {}} />);
  await settle();

  // One answer is not a question. `money` is null here, which is the shape of
  // an instance that has never opened the currency screen — nearly all of
  // them, and none of them should meet this field.
  expect(currencyPicker(host)).toBeUndefined();
  expect(host.textContent).not.toContain("Currency");
});

test("an invoice can be raised in a currency the business has priced", async () => {
  money = { baseCurrency: "GBP", currencies: ["GBP", "EUR"] };
  catalogue = [
    {
      id: "item-1",
      name: "Roof survey",
      description: "Roof survey",
      unitPriceCents: 10_000,
      unit: "piece",
      taxDefinitionId: null,
      active: true,
    },
  ];
  const host = mount(<InvoiceForm onDone={() => {}} />);
  await settle();

  const picker = currencyPicker(host);
  if (!picker) throw new Error("the form offered no currency to choose from");

  // The business's own is what it starts on, and the one below it is the one
  // a rate was recorded for. Nothing else: a currency with no rate is a
  // document the route refuses, so offering it would be offering a dead end.
  expect(picker.value).toBe("GBP");
  expect([...picker.options].map((o) => o.value)).toEqual(["GBP", "EUR"]);

  choose(
    labelled<HTMLSelectElement>(host, "Line 1 from the catalogue"),
    "item-1",
  );
  await settle();
  expect(host.textContent).toContain("£100.00");

  choose(picker, "EUR");
  await settle();

  // The totals are what the customer will be asked for, so they are in the
  // customer's money. A euro invoice showing a pound sign is a figure nobody
  // can act on, and it is the figure this screen is for.
  expect(host.textContent).toContain("€100.00");
  expect(host.textContent).not.toContain("£100.00");

  const raise = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Raise it",
  );
  if (!raise) throw new Error("the form offered no way to raise the invoice");
  click(raise);
  await settle();

  expect(sent?.currency).toBe("EUR");
});

test("the currency the business keeps its books in is not sent", async () => {
  money = { baseCurrency: "GBP", currencies: ["GBP", "EUR"] };
  catalogue = [
    {
      id: "item-1",
      name: "Roof survey",
      description: "Roof survey",
      unitPriceCents: 10_000,
      unit: "piece",
      taxDefinitionId: null,
      active: true,
    },
  ];
  const host = mount(<InvoiceForm onDone={() => {}} />);
  await settle();

  choose(
    labelled<HTMLSelectElement>(host, "Line 1 from the catalogue"),
    "item-1",
  );
  await settle();

  const raise = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Raise it",
  );
  if (!raise) throw new Error("the form offered no way to raise the invoice");
  click(raise);
  await settle();

  /*
   * Omitted rather than stated, so there is one answer to "what currency is
   * this" and it stays on the server. A form that names the base currency on
   * every document keeps sending last week's answer after a business changes
   * it.
   */
  expect(sent).not.toBeNull();
  expect("currency" in (sent ?? {})).toBe(false);
});
