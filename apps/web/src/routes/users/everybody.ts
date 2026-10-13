import { api } from "../../lib/api";

export interface PersonRow {
  userId: string;
  name: string;
  email: string;
}

/** The most `/api/users` hands back in one page. */
const PAGE = 200;

/**
 * Everybody who works here, for a screen that offers a choice of them.
 *
 * `/api/users` is paged and stops at two hundred a page, and two screens
 * asked for one page and offered it as the whole staff: the group's "Add
 * somebody" list and the security log's actor and subject filters. At a
 * business of three hundred the person who sorted last could not be put in a
 * group or looked up in the log, and all either screen could do was say so.
 *
 * So it asks for every page. Staff only, which is the route's default, and a
 * business this product is for has at most a few hundred of those — three
 * requests, not a table scan. Known limit: an instance with thousands of
 * staff would want a search box here instead.
 */
export async function everybody(): Promise<{
  people: PersonRow[];
  total: number;
}> {
  const people: PersonRow[] = [];
  let total = 0;
  for (let page = 1; ; page += 1) {
    const answer = await api<{ people: PersonRow[]; total: number }>(
      `/api/users?perPage=${PAGE}&page=${page}`,
    );
    total = answer.total;
    people.push(...answer.people);
    // An empty page ends it too, so a total that shrank between two
    // requests cannot keep this asking for ever.
    if (answer.people.length === 0 || people.length >= total) break;
  }
  return { people, total };
}
