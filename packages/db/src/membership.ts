import { db } from "./client";
import { and, eq } from "./orm";
import * as schema from "./schema";

/**
 * Does this user id belong to somebody who works at this business?
 *
 * Every module keeps ids of people: who a CRM record belongs to, who a task is
 * assigned to, whose hours a timesheet holds, whose row is on a rate card. All
 * of them are platform user ids, and until now each module answered "is this
 * one of ours" in its own words — or, more often, did not ask.
 *
 * **It is not inert.** A user id written without this check is a foreign key
 * into a table that has no `organization_id` at all, and the screens that
 * resolve one into a name have nothing to scope by: a stranger's id stored on
 * a record printed *that person's name, from another business*, on this one's
 * board. That is a cross-tenant disclosure produced by a field somebody typed
 * an id into, and the only place it can be stopped is the write.
 *
 * **One function, in Core, because the Users module owns who works here.** A
 * module with its own list of people is a second place to forget somebody who
 * has left. Five call sites in the paid bundle and four in the CRM asked this
 * question separately, which is four chances to ask it slightly wrong and one
 * certainty that the tenth will not ask at all.
 *
 * **A suspended member is still a member, and this returns them.** `disabledAt`
 * stops somebody signing in; it does not stop them being ours. The column
 * exists precisely so that a person who has left keeps their name on the
 * invoices they raised, and a helper that hid them would make their existing
 * work unreadable and unassignable to anybody else. A fortnight's suspension
 * while a laptop is replaced must not quietly refuse every save that mentions
 * them. Giving new work to somebody who cannot sign in is a business mistake
 * to be fixed on a screen, not a disclosure to be refused at the database.
 *
 * **Not cached, deliberately.** It is one indexed read, on a table with a row
 * per person per business, taken once on a write that is already doing several
 * — and this instance has under twenty employees, so the table is under twenty
 * rows. A cache would have to be invalidated by every join, removal,
 * suspension and group change, across the web process *and* the jobs process,
 * and the two failure modes of a stale one are refusing a real employee's work
 * and accepting the id of somebody who left. The second is the bug this
 * function exists to prevent, so buying microseconds with it would be paying
 * for the disease with the cure.
 *
 * Returns the id when the person is a member of that organisation, and null
 * otherwise — including for anything that is not a non-empty string, so a
 * caller can hand it a raw request field without checking first.
 */
export async function organizationMember(
  organizationId: string,
  userId: unknown,
): Promise<string | null> {
  const id = typeof userId === "string" ? userId.trim() : "";
  if (!id || !organizationId) return null;

  const [row] = await db
    .select({ id: schema.member.userId })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.userId, id),
        eq(schema.member.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
