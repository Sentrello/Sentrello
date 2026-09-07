import { expect, test } from "bun:test";
import { singleAdministratorNoMail } from "./authentication";

/**
 * The condition behind §8's third warning, pulled out of the component and
 * tested against the real function (Ruling 39) rather than a copy of the
 * logic living only in this file.
 */

test("one administrator with no mail configured is a single point of failure", () => {
  expect(
    singleAdministratorNoMail({ administrators: 1, mailConfigured: false }),
  ).toBe(true);
});

test("one administrator with mail configured is not warned about", () => {
  expect(
    singleAdministratorNoMail({ administrators: 1, mailConfigured: true }),
  ).toBe(false);
});

test("two administrators with no mail configured is not warned about", () => {
  expect(
    singleAdministratorNoMail({ administrators: 2, mailConfigured: false }),
  ).toBe(false);
});

test("zero administrators — a state the server should never actually return — still reads as a single point of failure, not a crash", () => {
  expect(
    singleAdministratorNoMail({ administrators: 0, mailConfigured: false }),
  ).toBe(true);
});
