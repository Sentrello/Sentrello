import { afterEach, beforeEach, expect, test } from "bun:test";
import { everybody } from "./everybody";

/**
 * Three hundred and more staff, against the route's real ceiling.
 *
 * The stand-in pages the way `GET /api/users` does: `perPage` capped at two
 * hundred, the total beside every page. The group and security-log screens
 * asked for one page of it and offered that as everybody, so the person who
 * sorted 201st could not be added to a group or found in the log.
 */
const staff = Array.from({ length: 450 }, (_, i) => ({
  userId: `u-${i}`,
  name: `${String(i).padStart(3, "0")} Staff`,
  email: `staff${i}@example.test`,
}));

const asked: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  asked.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    const params = new URL(String(input), "http://localhost").searchParams;
    const perPage = Math.min(200, Number(params.get("perPage") ?? 50));
    const page = Number(params.get("page") ?? 1);
    return new Response(
      JSON.stringify({
        people: staff.slice((page - 1) * perPage, page * perPage),
        total: staff.length,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("one page of the route stops at two hundred", async () => {
  const res = await fetch("/api/users?perPage=200");
  const body = (await res.json()) as { people: unknown[]; total: number };
  expect(body.people).toHaveLength(200);
  expect(body.total).toBe(450);
});

test("everybody is everybody, the last person included", async () => {
  const { people, total } = await everybody();
  expect(total).toBe(450);
  expect(people).toHaveLength(450);
  expect(people.at(-1)?.userId).toBe("u-449");
  expect(asked).toHaveLength(3);
});

/**
 * Somebody joins between two pages.
 *
 * Pages are counted from the top, so a person who sorts early and arrives
 * after page one pushes everybody down a place: page two then begins with the
 * person page one ended on. The list offered them twice, and the screens key
 * their rows by user.
 */
test("a page that overlaps the one before it offers nobody twice", async () => {
  const paged = globalThis.fetch;
  let served = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    served += 1;
    if (served === 2) {
      staff.unshift({ userId: "u-new", name: "000 New", email: "n@x.test" });
    }
    return paged(input);
  }) as typeof fetch;
  try {
    const { people } = await everybody();
    const ids = people.map((p) => p.userId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("u-449");
  } finally {
    staff.shift();
  }
});
