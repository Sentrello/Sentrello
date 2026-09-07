import { expect, test } from "bun:test";
import { buildStatement } from "./statements";

/**
 * A statement is arithmetic somebody else checks.
 *
 * The customer reading it has their own record of what they paid and when, so
 * the two things that must hold are the order of the lines and the sign of
 * each one. Both are tested here against a hand-worked example rather than
 * against the function's own output.
 */

const contact = { id: "c1", name: "Marsh & Sons", email: "pay@marsh.test" };
const window = {
  from: new Date("2026-01-01"),
  to: new Date("2026-03-31"),
  currency: "USD",
};

test("the running balance follows the dates, not the invoice numbers", () => {
  const statement = buildStatement({
    contact,
    ...window,
    openingCents: 0,
    // INV-0002 was raised first in time; a statement sorted by number would
    // read as though the February payment landed before the January bill.
    invoices: [
      {
        number: "INV-0009",
        kind: "invoice",
        issueDate: new Date("2026-03-02"),
        dueDate: null,
        totalCents: 40_00,
      },
      {
        number: "INV-0002",
        kind: "invoice",
        issueDate: new Date("2026-01-10"),
        dueDate: null,
        totalCents: 100_00,
      },
    ],
    payments: [
      {
        receivedAt: new Date("2026-02-01"),
        amountCents: 60_00,
        invoiceNumber: "INV-0002",
      },
    ],
    now: new Date("2026-03-31"),
  });

  expect(statement.rows.map((r) => r.reference)).toEqual([
    "INV-0002",
    "INV-0002",
    "INV-0009",
  ]);
  expect(statement.rows.map((r) => r.balanceCents)).toEqual([
    100_00, 40_00, 80_00,
  ]);
  expect(statement.closingCents).toBe(80_00);
});

test("a credit note reduces what is owed", () => {
  const statement = buildStatement({
    contact,
    ...window,
    openingCents: 0,
    invoices: [
      {
        number: "INV-0011",
        kind: "invoice",
        issueDate: new Date("2026-02-01"),
        dueDate: null,
        totalCents: 250_00,
      },
      {
        number: "CN-0003",
        kind: "credit_note",
        issueDate: new Date("2026-02-14"),
        dueDate: null,
        totalCents: 50_00,
      },
    ],
    payments: [],
    now: new Date("2026-03-31"),
  });

  const credit = statement.rows[1];
  expect(credit?.kind).toBe("credit_note");
  expect(credit?.amountCents).toBe(-50_00);
  expect(statement.closingCents).toBe(200_00);
});

test("the opening balance carries in and the closing balance carries it out", () => {
  const statement = buildStatement({
    contact,
    ...window,
    openingCents: 75_00,
    invoices: [
      {
        number: "INV-0020",
        kind: "invoice",
        issueDate: new Date("2026-01-05"),
        dueDate: null,
        totalCents: 25_00,
      },
    ],
    payments: [],
    now: new Date("2026-03-31"),
  });

  expect(statement.rows[0]?.balanceCents).toBe(100_00);
  expect(statement.closingCents).toBe(100_00);
});

test("only invoices past their due date count as overdue", () => {
  const statement = buildStatement({
    contact,
    ...window,
    openingCents: 0,
    invoices: [
      {
        number: "INV-0030",
        kind: "invoice",
        issueDate: new Date("2026-01-05"),
        dueDate: new Date("2026-02-05"),
        totalCents: 30_00,
      },
      {
        number: "INV-0031",
        kind: "invoice",
        issueDate: new Date("2026-03-05"),
        // Not due yet on the "now" below, so it is owed but not late.
        dueDate: new Date("2026-04-05"),
        totalCents: 70_00,
      },
    ],
    payments: [],
    now: new Date("2026-03-10"),
  });

  expect(statement.closingCents).toBe(100_00);
  expect(statement.overdueCents).toBe(30_00);
});

test("a customer who is fully paid up is not shown as overdue", () => {
  // The late invoice was settled, so the arrears figure has to come down with
  // the balance — a paid customer told they are overdue calls the business.
  const statement = buildStatement({
    contact,
    ...window,
    openingCents: 0,
    invoices: [
      {
        number: "INV-0040",
        kind: "invoice",
        issueDate: new Date("2026-01-05"),
        dueDate: new Date("2026-02-05"),
        totalCents: 30_00,
      },
    ],
    payments: [
      {
        receivedAt: new Date("2026-02-20"),
        amountCents: 30_00,
        invoiceNumber: "INV-0040",
      },
    ],
    now: new Date("2026-03-10"),
  });

  expect(statement.closingCents).toBe(0);
  expect(statement.overdueCents).toBe(0);
});
