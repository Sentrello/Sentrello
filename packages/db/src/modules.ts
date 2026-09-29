import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { moduleState } from "./schema";

/**
 * Whether a business has turned an optional module on.
 *
 * The licence decides what a business *may* run; this decides what it has
 * actually set up. Those are different questions and were being answered by
 * the same fact: a module appeared the moment it was paid for, configured or
 * not, which puts four half-set-up screens in the sidebar of somebody who
 * bought a bundle on a Friday afternoon.
 *
 * Free modules never appear here. They are the product, not a purchase, and a
 * business that could turn off invoicing would be one support call away from
 * an instance that cannot invoice.
 */

export interface ModuleState {
  moduleId: string;
  enabled: boolean;
  enabledAt: Date | null;
}

export async function moduleStates(
  organizationId: string,
): Promise<Map<string, ModuleState>> {
  const rows = await db
    .select()
    .from(moduleState)
    .where(eq(moduleState.organizationId, organizationId));

  return new Map(
    rows.map((r) => [
      r.moduleId,
      { moduleId: r.moduleId, enabled: r.enabled, enabledAt: r.enabledAt },
    ]),
  );
}

/**
 * No row means nobody has been asked yet, and that is not the same as "no".
 *
 * It is the honest state for a module the licence has only just started
 * granting: it belongs to the business, it is waiting, and it appears under
 * Modules with a way to start rather than pretending to be switched off by
 * somebody's decision.
 */
export function isEnabled(
  states: Map<string, ModuleState>,
  moduleId: string,
): boolean {
  return states.get(moduleId)?.enabled ?? false;
}

export async function setModuleEnabled(
  organizationId: string,
  moduleId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .insert(moduleState)
    .values({
      organizationId,
      moduleId,
      enabled,
      enabledAt: enabled ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [moduleState.organizationId, moduleState.moduleId],
      set: {
        enabled,
        updatedAt: new Date(),
        // Kept from the first time it was turned on. Support gets asked "when
        // did we start using this", and a date that resets on every toggle
        // answers a different question.
        ...(enabled ? {} : { enabledAt: null }),
      },
    });
}

/**
 * Nothing adopts an existing installation automatically.
 *
 * The temptation is to turn on whatever a business is already using, so that
 * enablement arriving does not make a paid feature vanish mid-week. It would
 * need every module to answer "do I have data here", which is eight new
 * implementations of a question that has one honest answer today: no third
 * party is running a paid module yet, and on our own instances nothing is set
 * up either.
 *
 * If that changes before this ships widely, the module contract grows a
 * `hasData` and this file grows the loop. Until then, a module waiting under
 * Modules with a button is a fair place to find one.
 */

/**
 * Whether a business has deliberately put a module away.
 *
 * Not the same question as `isEnabled`, and the difference is the whole point.
 * No row means nobody has been asked yet — the module is waiting under Modules
 * with a button — and a `false` row means somebody pressed the button the other
 * way. Only the second is a decision, so only the second closes a door.
 *
 * What it closes is the doors a *stranger* comes through: a storefront that
 * takes an order, a booking page that takes an appointment, a signup form that
 * takes an address. A business that switches the shop off for the winter and
 * finds it still selling has no way to read that except as the switch not
 * working — the sidebar hid the screen where the orders arrive, which made it
 * worse rather than better.
 *
 * What it must never close is a link somebody has already been sent:
 * unsubscribe, a privacy request, managing a booking that exists, a receipt.
 * Those belong to the customer rather than to the module, and answering 404 to
 * an unsubscribe link is both rude and, in three of our four markets, unlawful.
 */
export async function putAway(
  organizationId: string,
  moduleId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: moduleState.enabled })
    .from(moduleState)
    .where(
      and(
        eq(moduleState.organizationId, organizationId),
        eq(moduleState.moduleId, moduleId),
      ),
    )
    .limit(1);
  return row ? !row.enabled : false;
}
