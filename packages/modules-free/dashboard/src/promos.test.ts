import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AD_HEIGHT,
  AD_WIDTH,
  BUILT_IN,
  expired,
  pastQuietPeriod,
  promosEnabled,
  readPromos,
  refreshPromos,
  safeUrl,
  validatePromos,
} from "./promos";

/**
 * The advertisement arrives over the network, which makes it input. These
 * tests are about what a document is not allowed to do to the page it lands
 * on, and about the block never being the reason a dashboard is empty.
 */

const good = {
  ad: {
    kind: "text",
    headline: "Get paid faster with Sentrello Pro",
    body: "Automatic chasing and the reports your accountant asks for.",
    cta: "See Pro",
    url: "https://sentrello.com/pro",
  },
};

const banner = {
  ad: {
    kind: "image",
    imageUrl: "https://ads.test/banner.png",
    alt: "A banner",
    url: "https://ads.test",
  },
};

const env = { ...process.env };
afterEach(() => {
  process.env.SENTRELLO_PROMOS = env.SENTRELLO_PROMOS;
  process.env.SENTRELLO_DATA_DIR = env.SENTRELLO_DATA_DIR;
});

test("a link is https or it is not a link", () => {
  expect(safeUrl("https://sentrello.com")).toBe("https://sentrello.com/");
  // The obvious one, and the one that matters more: a page that is otherwise
  // entirely local must not send somebody off over cleartext.
  expect(safeUrl("javascript:alert(1)")).toBeNull();
  expect(safeUrl("http://sentrello.com")).toBeNull();
  expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  expect(safeUrl("  not a url ")).toBeNull();
});

test("a document without a headline or a link is not used", () => {
  expect(
    validatePromos({ ad: { kind: "text", headline: "", url: "" } }),
  ).toBeNull();
  expect(validatePromos({ ad: { kind: "text", headline: "Hi" } })).toBeNull();
  expect(
    validatePromos({ ad: { kind: "text", url: "https://x.test" } }),
  ).toBeNull();
  expect(validatePromos({})).toBeNull();
  expect(validatePromos("a string")).toBeNull();
  expect(validatePromos(null)).toBeNull();
});

test("an advertisement with an unusable link is refused entirely", () => {
  // There is only one block now, so there is nothing to fall back to within
  // the document — a bad link means the whole thing is ignored and the
  // built-in copy shows instead.
  expect(
    validatePromos({
      ad: { kind: "text", headline: "Someone", url: "javascript:alert(1)" },
    }),
  ).toBeNull();
});

test("a banner needs an image over TLS", () => {
  expect(
    validatePromos({
      ad: {
        kind: "image",
        imageUrl: "http://ads.test/banner.png",
        url: "https://ads.test",
      },
    }),
  ).toBeNull();

  expect(validatePromos(banner)?.ad).toEqual({
    kind: "image",
    imageUrl: "https://ads.test/banner.png",
    alt: "A banner",
    url: "https://ads.test/",
  });
});

test("long copy is cut rather than allowed to break the slot", () => {
  // The slot is a fixed 728x90. Copy that does not fit is cropped by the box
  // anyway; cutting it here keeps the cached document small too.
  const parsed = validatePromos({
    ad: {
      kind: "text",
      headline: "H".repeat(500),
      body: "B".repeat(500),
      url: "https://sentrello.com",
    },
  });
  const ad = parsed?.ad;
  if (ad?.kind !== "text") throw new Error("expected a text advertisement");
  expect(ad.headline.length).toBe(80);
  expect(ad.body.length).toBe(140);
});

test("a failed fetch keeps yesterday's copy rather than clearing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "promos-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_PROMOS = "on";

  const stored = await refreshPromos(
    async () => new Response(JSON.stringify(good), { status: 200 }),
  );
  expect(stored?.ad.kind).toBe("text");

  // Server down, then serving rubbish. Neither may blank the block.
  expect(
    await refreshPromos(async () => {
      throw new Error("connection refused");
    }),
  ).toBeNull();
  expect(
    await refreshPromos(
      async () => new Response("not json at all", { status: 200 }),
    ),
  ).toBeNull();
  expect(
    await refreshPromos(async () => new Response("{}", { status: 500 })),
  ).toBeNull();

  const kept = await readPromos();
  if (kept.ad.kind !== "text") throw new Error("expected a text advertisement");
  expect(kept.ad.headline).toBe("Get paid faster with Sentrello Pro");
  expect(
    JSON.parse(await readFile(join(dir, "promos.json"), "utf8")).ad.headline,
  ).toBe("Get paid faster with Sentrello Pro");
});

test("a document that does not validate falls back to the built-in copy", async () => {
  // The case that matters most: something well-formed enough to parse but not
  // to trust. It must not reach the screen and must not blank it either.
  const dir = await mkdtemp(join(tmpdir(), "promos-bad-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_PROMOS = "on";

  expect(
    await refreshPromos(
      async () =>
        new Response(JSON.stringify({ ad: { kind: "text", headline: "Hi" } }), {
          status: 200,
        }),
    ),
  ).toBeNull();
  expect(await readPromos()).toEqual(BUILT_IN);
});

test("with nothing cached, the built-in copy is what shows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "promos-empty-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  expect(await readPromos()).toEqual(BUILT_IN);
});

test("turned off means no fetch and no cached copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "promos-off-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_PROMOS = "on";
  await refreshPromos(
    async () => new Response(JSON.stringify(good), { status: 200 }),
  );

  process.env.SENTRELLO_PROMOS = "off";
  expect(promosEnabled()).toBe(false);
  let called = 0;
  expect(
    await refreshPromos(async () => {
      called += 1;
      return new Response(JSON.stringify(good), { status: 200 });
    }),
  ).toBeNull();
  expect(called).toBe(0);
  // And the block goes back to what shipped, rather than the last thing we sent.
  expect(await readPromos()).toEqual(BUILT_IN);
});

test("the slot is one fixed leaderboard", () => {
  // Both ends have to agree on the size, or a banner uploaded in Master is the
  // wrong shape for the hole it goes in.
  expect(AD_WIDTH).toBe(728);
  expect(AD_HEIGHT).toBe(90);
});

/**
 * An offer that names a date stops making the claim when the date passes.
 *
 * "Founder pricing with a price-lock guarantee until December 31st" is served
 * to every instance, and on the first of January it is a false claim on
 * somebody else's dashboard. The people who would notice are not the people
 * reading it. An expired document falls back to the copy that ships in the
 * box, which promises nothing about a date.
 */
test("an offer that has ended is not shown", () => {
  const ended = {
    ad: BUILT_IN.ad,
    expiresAt: "2026-01-01T00:00:00.000Z",
  };
  expect(expired(ended, new Date("2026-01-02T00:00:00.000Z"))).toBe(true);
  // On the day itself it is over: an offer "until the 31st" is not still
  // running on the 1st, and the boundary is the half nobody tests.
  expect(expired(ended, new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
  expect(expired(ended, new Date("2025-12-31T23:59:59.000Z"))).toBe(false);
});

test("an offer with no end date runs until it is replaced", () => {
  expect(expired({ ad: BUILT_IN.ad })).toBe(false);
});

/**
 * And a date nobody can read is not an expiry.
 *
 * Refusing to show anything because of a typo in a field that is optional
 * would be a worse failure than showing an offer a day too long.
 */
test("an unreadable end date does not hide the offer", () => {
  expect(expired({ ad: BUILT_IN.ad, expiresAt: "the end of the month" })).toBe(
    false,
  );
  expect(expired({ ad: BUILT_IN.ad, expiresAt: "" })).toBe(false);
});

test("an end date survives being read from a document", () => {
  const doc = validatePromos({
    ad: {
      kind: "text",
      headline: "Founder pricing",
      body: "Until the end of the year.",
      cta: "See it",
      url: "https://sentrello.com/pro",
    },
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  expect(doc?.expiresAt).toBe("2027-01-01T00:00:00.000Z");
});

/**
 * And the expiry is applied where the dashboard actually reads it.
 *
 * `expired()` being right proves nothing on its own: taking the check out of
 * `readPromos` left every test above this one green, which is the whole
 * reason this one exists. What a dashboard shows is what `readPromos`
 * returns.
 */
test("the dashboard is given the built-in copy once an offer has ended", async () => {
  const dir = await mkdtemp(join(tmpdir(), "promos-"));
  const previous = process.env.SENTRELLO_DATA_DIR;
  process.env.SENTRELLO_DATA_DIR = dir;

  try {
    await writeFile(
      join(dir, "promos.json"),
      JSON.stringify({
        ad: {
          kind: "text",
          headline: "Founder pricing",
          body: "Until December 31st.",
          cta: "Unlock Pro",
          url: "https://sentrello.com/pro",
        },
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    const shown = await readPromos();
    expect(shown.ad).toEqual(BUILT_IN.ad);
    if (shown.ad.kind === "text") {
      expect(shown.ad.body).not.toContain("December");
    }
  } finally {
    if (previous === undefined) {
      process.env.SENTRELLO_DATA_DIR = undefined;
    } else {
      process.env.SENTRELLO_DATA_DIR = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("an offer still running is the one the dashboard shows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "promos-"));
  const previous = process.env.SENTRELLO_DATA_DIR;
  process.env.SENTRELLO_DATA_DIR = dir;

  try {
    await writeFile(
      join(dir, "promos.json"),
      JSON.stringify({
        ad: {
          kind: "text",
          headline: "Still running",
          body: "For a while yet.",
          cta: "Look",
          url: "https://sentrello.com/pro",
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );

    const shown = await readPromos();
    expect(shown.ad.kind === "text" && shown.ad.headline).toBe("Still running");
  } finally {
    if (previous === undefined) {
      process.env.SENTRELLO_DATA_DIR = undefined;
    } else {
      process.env.SENTRELLO_DATA_DIR = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A business is left alone for its first two months.
 *
 * The first thing somebody sees after claiming an instance should not be an
 * advertisement: they have not added a contact or raised an invoice, and the
 * only call to action on the screen being "spend more money" is the wrong
 * first impression of something they have just installed.
 *
 * After that the offer stands until they take it. It is not a campaign with
 * an end — it is what Free says about Pro.
 */
test("nothing is offered for the first sixty days", () => {
  const claimed = new Date("2026-01-01T00:00:00.000Z");
  const day = 86_400_000;

  expect(pastQuietPeriod(claimed, new Date(claimed.getTime()))).toBe(false);
  expect(pastQuietPeriod(claimed, new Date(claimed.getTime() + 59 * day))).toBe(
    false,
  );
  // The boundary, which is the half nobody tests: the sixtieth day is when it
  // starts, not the day after.
  expect(pastQuietPeriod(claimed, new Date(claimed.getTime() + 60 * day))).toBe(
    true,
  );
  expect(
    pastQuietPeriod(claimed, new Date(claimed.getTime() + 400 * day)),
  ).toBe(true);
});

/**
 * And a date that cannot be read does not silence the offer for ever.
 *
 * A business whose creation date is missing would otherwise never be told
 * about Pro at all — a commercial hole nobody would see, because there is
 * nothing on the screen to notice. Being shown an offer early is the smaller
 * failure of the two.
 */
test("a business with no readable start date is offered the upgrade", () => {
  expect(pastQuietPeriod(null)).toBe(true);
  expect(pastQuietPeriod(undefined)).toBe(true);
  expect(pastQuietPeriod("not a date")).toBe(true);
});

test("the start date may arrive as a string, as the database hands it over", () => {
  const day = 86_400_000;
  const claimed = new Date("2026-01-01T00:00:00.000Z");
  expect(
    pastQuietPeriod(claimed.toISOString(), new Date(claimed.getTime() + day)),
  ).toBe(false);
  expect(
    pastQuietPeriod(
      claimed.toISOString(),
      new Date(claimed.getTime() + 61 * day),
    ),
  ).toBe(true);
});
