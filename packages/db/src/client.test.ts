import { afterEach, expect, test } from "bun:test";
import { poolSize } from "./client";

/**
 * The pool size is one number, and getting it wrong does not look like a
 * database problem: the site stays up on the connections it already holds
 * while every new one is refused, so backups and migrations fail quietly.
 */

const original = process.env.SENTRELLO_DB_POOL;
afterEach(() => {
  process.env.SENTRELLO_DB_POOL = original;
});

test("a business with its own database gets ten", () => {
  process.env.SENTRELLO_DB_POOL = undefined;
  expect(poolSize()).toBe(10);
});

test("several instances on one cluster can be told to take less", () => {
  process.env.SENTRELLO_DB_POOL = "4";
  expect(poolSize()).toBe(4);
});

test("one connection is not enough for a transaction to wait on itself", () => {
  process.env.SENTRELLO_DB_POOL = "1";
  expect(poolSize()).toBe(2);
  process.env.SENTRELLO_DB_POOL = "0";
  expect(poolSize()).toBe(2);
});

test("nonsense falls back rather than becoming NaN connections", () => {
  process.env.SENTRELLO_DB_POOL = "lots";
  expect(poolSize()).toBe(10);
});
