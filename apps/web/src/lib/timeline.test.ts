import { expect, test } from "bun:test";
import { mergeTimeline } from "./timeline";

/**
 * The property worth holding is that **nothing the server sends disappears.**
 *
 * The old merge was a whitelist of two kinds, and a whitelist drops what it
 * does not recognise. That is how mailbox sync's emails and meetings were
 * invisible on the very record they were synced for, on the day they shipped,
 * with every server test green.
 */

const money = (cents: number) => `£${(cents / 100).toFixed(2)}`;

const history = [
  { at: "2026-09-01T10:00:00Z", kind: "call", title: "Rang about the roof" },
  {
    at: "2026-09-02T10:00:00Z",
    kind: "deal",
    title: "Deal opened: Roof",
    link: { moduleId: "deals", recordId: "d1", title: "Roof" },
  },
];

test("every kind the server sends reaches the list", () => {
  const timeline = [
    {
      kind: "invoice",
      at: "2026-09-03T10:00:00Z",
      id: "1",
      summary: "INV-1",
      amountCents: 10_00,
    },
    {
      kind: "payment",
      at: "2026-09-04T10:00:00Z",
      id: "2",
      summary: "card",
      amountCents: 10_00,
    },
    {
      kind: "email",
      at: "2026-09-05T10:00:00Z",
      id: "3",
      summary: "Re: the roof",
    },
    {
      kind: "meeting",
      at: "2026-09-06T10:00:00Z",
      id: "4",
      summary: "Site visit",
    },
    {
      kind: "deal",
      at: "2026-09-07T10:00:00Z",
      id: "d1",
      event: "closed",
      summary: "Roof",
    },
  ];
  const merged = mergeTimeline(history, timeline, money);

  expect(merged.map((e) => e.kind)).toEqual([
    "deal",
    "meeting",
    "email",
    "payment",
    "invoice",
    "call",
  ]);
  expect(merged.find((e) => e.kind === "email")?.title).toBe(
    "Email: Re: the roof",
  );
  expect(merged.find((e) => e.kind === "meeting")?.title).toBe(
    "Meeting: Site visit",
  );
  expect(merged.find((e) => e.kind === "payment")?.detail).toBe("£10.00");
});

test("a kind this build has never seen is shown, not swallowed", () => {
  // The whole point. Whatever the next module contributes — a shipment, a
  // signature, a support ticket — it appears the day the server sends it.
  const merged = mergeTimeline(
    history,
    [
      {
        kind: "shipment",
        at: "2026-09-10T10:00:00Z",
        id: "9",
        summary: "Sent by courier",
      },
    ],
    money,
  );

  const shown = merged.find((e) => e.kind === "shipment");
  expect(shown).toBeDefined();
  expect(shown?.title).toBe("Shipment: Sent by courier");
});

test("a kind with nothing to say about itself still gets a line", () => {
  const merged = mergeTimeline(
    [],
    [{ kind: "site_visit", at: "2026-09-10T10:00:00Z", id: "9" }],
    money,
  );
  expect(merged[0]?.title).toBe("Site visit");
});

/**
 * The trap in widening the filter.
 *
 * Core's free history already emits deal lines, and the richer timeline now
 * emits them too. Letting everything through without this would draw every deal
 * twice — once coarsely and once properly — which is a worse screen than the
 * one the whitelist gave.
 */
test("a deal both sources know about is drawn once, by the source that says more", () => {
  const withRicher = mergeTimeline(
    history,
    [
      {
        kind: "deal",
        at: "2026-09-02T10:00:00Z",
        id: "d1",
        event: "opened",
        summary: "Roof",
        detail: "quoted",
      },
      {
        kind: "deal",
        at: "2026-09-07T10:00:00Z",
        id: "d1",
        event: "closed",
        summary: "Roof",
        detail: "won",
      },
    ],
    money,
  );

  const deals = withRicher.filter((e) => e.kind === "deal");
  expect(deals.map((d) => d.title)).toEqual([
    "Deal decided: Roof",
    "Deal opened: Roof",
  ]);
  // The coarse line is gone, not hidden behind one of these.
  expect(withRicher.map((e) => e.title)).not.toContain(
    "Deal opened: Roof (coarse)",
  );
  expect(deals.map((d) => d.detail)).toEqual(["won", "quoted"]);
  // And nothing else was touched on the way past.
  expect(withRicher.filter((e) => e.kind === "call")).toHaveLength(1);

  // On an instance with no richer timeline, Core's own line is all there is
  // and is kept.
  const alone = mergeTimeline(history, undefined, money);
  expect(alone.map((e) => e.title)).toEqual([
    "Deal opened: Roof",
    "Rang about the roof",
  ]);
});

test("the editable line wins, because nothing else can offer one", () => {
  // The same activity from both sides. Core's carries the id that lets
  // somebody correct what they typed, so it is the one kept — decided by what
  // the line can do, not by which kind it is.
  const merged = mergeTimeline(
    [
      {
        at: "2026-09-01T10:00:00Z",
        kind: "call",
        title: "Rang about the roof",
        activityId: "a1",
      },
    ],
    [
      {
        kind: "activity",
        at: "2026-09-01T10:00:00Z",
        id: "a1",
        summary: "call",
      },
    ],
    money,
  );
  expect(merged).toHaveLength(1);
  expect(merged[0]?.activityId).toBe("a1");
});

test("a record only one source knows about is never dropped as a duplicate", () => {
  const merged = mergeTimeline(
    [{ at: "2026-09-01T10:00:00Z", kind: "note", title: "Left a voicemail" }],
    [
      {
        kind: "invoice",
        at: "2026-09-03T10:00:00Z",
        id: "i1",
        summary: "INV-9",
      },
    ],
    money,
  );
  expect(merged.map((e) => e.kind)).toEqual(["invoice", "note"]);
});
