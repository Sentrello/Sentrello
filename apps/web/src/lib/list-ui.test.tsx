import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { type ListState, listQueryString, useListQuery } from "./list-ui";

const STATE: ListState = {
  q: "",
  setQ: () => {},
  sort: "name",
  order: "asc",
  setSort: () => {},
  filters: {},
  setFilter: () => {},
  isFilterActive: () => false,
  toggleFilter: () => {},
  clearFilters: () => {},
  hasFilters: false,
  page: 1,
  setPage: () => {},
  perPage: 25,
  setPerPage: () => {},
};

function Probe({ resource }: { resource: string }) {
  const { rows } = useListQuery<{ id: string }>(resource, STATE);
  return <>{rows.map((r) => r.id).join(",")}</>;
}

/**
 * A module's routes live under its own prefix — `/api/shop/orders`, not
 * `/api/orders` — but the response still names its rows after the thing they
 * are, not the path they were fetched from: `{ orders, total }`. The rows key
 * is the last segment of the resource, so `shop/orders` reads `orders` and
 * Core's own flat resources, where the path is already one word, are
 * unaffected.
 */
test("a namespaced resource reads its rows from the last segment of its path", () => {
  const qc = new QueryClient();
  const query = listQueryString(STATE, true);
  qc.setQueryData(["shop/orders", query], {
    orders: [{ id: "o1" }, { id: "o2" }],
    total: 2,
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe resource="shop/orders" />
    </QueryClientProvider>,
  );
  expect(html).toBe("o1,o2");
});

test("a flat resource still reads its rows under its own name", () => {
  const qc = new QueryClient();
  const query = listQueryString(STATE, true);
  qc.setQueryData(["contacts", query], {
    contacts: [{ id: "c1" }],
    total: 1,
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe resource="contacts" />
    </QueryClientProvider>,
  );
  expect(html).toBe("c1");
});

/**
 * A screen that needs a field beside rows and total — a money summary above
 * an orders table, say — reads it off the same response `useListQuery`
 * already fetched, instead of standing up a second `useQuery` against the
 * same cache key to get at it. One cache entry serves both, so nothing else
 * was, or needed to be, fetched.
 */
test("a caller can read a field beside rows and total from the same response", () => {
  const qc = new QueryClient();
  const query = listQueryString(STATE, true);
  qc.setQueryData(["shop/orders", query], {
    orders: [{ id: "o1" }],
    total: 1,
    totals: { paidCount: 3, paidCents: 500, awaiting: 1 },
  });

  function ProbeWithTotals({ resource }: { resource: string }) {
    const { rows, response } = useListQuery<{ id: string }>(resource, STATE);
    const totals = (response as { totals?: { paidCount: number } })?.totals;
    return (
      <>
        {rows.map((r) => r.id).join(",")}:{totals?.paidCount}
      </>
    );
  }

  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ProbeWithTotals resource="shop/orders" />
    </QueryClientProvider>,
  );
  expect(html).toBe("o1:3");
  // A second `useQuery` on the same key would still land in this same cache
  // entry — one entry is what "no second request" looks like here.
  expect(qc.getQueryCache().getAll()).toHaveLength(1);
});

/**
 * The cache key stays the full path. Two modules can each own a resource
 * called "orders" — the last segment is only how the response is read, not
 * how the request is cached — and collapsing the key to that segment would
 * hand one module's cached rows to the other.
 */
test("two modules' same-named resources do not share a cache entry", () => {
  const qc = new QueryClient();
  const query = listQueryString(STATE, true);
  qc.setQueryData(["shop/orders", query], {
    orders: [{ id: "shop-1" }],
    total: 1,
  });
  qc.setQueryData(["billing/orders", query], {
    orders: [{ id: "billing-1" }],
    total: 1,
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe resource="shop/orders" />
      <Probe resource="billing/orders" />
    </QueryClientProvider>,
  );
  expect(html).toBe("shop-1billing-1");
});

/**
 * A trailing slash leaves `lastIndexOf("/") + 1` pointing past the end of
 * the string, so the rows key comes out empty and the list reads as
 * permanently empty rather than as a caller's typo.
 */
test("a trailing slash on the resource does not empty the rows key", () => {
  const qc = new QueryClient();
  const query = listQueryString(STATE, true);
  qc.setQueryData(["shop/orders/", query], {
    orders: [{ id: "o1" }],
    total: 1,
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe resource="shop/orders/" />
    </QueryClientProvider>,
  );
  expect(html).toBe("o1");
});
