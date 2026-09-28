import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "@sentrello/module-sdk";

/**
 * Nothing rendered on the server formats a date on its own.
 *
 * Postgres hands a date column over as midnight UTC. Format that without
 * saying which zone you mean and the runtime uses the machine's — so on a
 * self-hosted box set to Denver, an invoice due on 1 October went out to the
 * customer saying 30 September. Our own containers are UTC, which is exactly
 * why nobody saw it.
 *
 * `calendarDay` is the answer and it is one line to call. This is here
 * because the five places that had the bug were written months apart by
 * somebody reaching for the obvious method, and the sixth will be too.
 *
 * An explicit `timeZone` is allowed through: a booking at 2pm in the
 * business's own zone is a moment, not a day, and saying so is the correct
 * way to write it.
 */
const ROOTS = ["packages/modules-free", "packages/db", "packages/email"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(path);
  }
  return out;
}

test("a date rendered on the server names its timezone or uses the helper", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const bare: string[] = [];

  for (const dir of ROOTS) {
    for (const path of sources(join(root, dir))) {
      const text = stripComments(readFileSync(path, "utf8"));
      // The call and its arguments, which may run over several lines.
      for (const call of text.matchAll(
        /\b(?:toLocaleDateString|toLocaleString|new Intl\.DateTimeFormat)\s*\(([\s\S]{0,300}?)\)\s*[.;,)]/g,
      )) {
        if (call[1]?.includes("timeZone")) continue;
        const line = text.slice(0, call.index).split("\n").length;
        bare.push(`${path.slice(root.length + 1)}:${line}`);
      }
    }
  }

  expect(
    bare,
    `these format a date in whatever zone the server happens to be set to — call calendarDay, or pass timeZone and mean it:\n    ${bare.join("\n    ")}`,
  ).toEqual([]);
});
