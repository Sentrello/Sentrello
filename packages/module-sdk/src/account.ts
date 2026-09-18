import type { SummaryFigure } from "./summaries";

/**
 * One section of a customer's own account with the business.
 *
 * A business's customer today has as many logins as it has modules: a Shop
 * account, an emailed subscription-management link, a private booking link,
 * an invoicing portal token — four surfaces, four credentials, no single
 * place that says "here is what you have with this business." This is that
 * place, built the way `registerWidget` built the dashboard a few hours
 * earlier: a module declares a section with its own entitlement, the host
 * arranges whatever this instance loaded, and every response is filtered
 * through one check before it is ever sent — so a section nobody may see is
 * never *disclosed*, not merely left off the page somebody could still probe
 * for.
 *
 * ## Who is asking
 *
 * The viewer here is a customer of the business, not a member of its staff —
 * usually with no platform account at all. `requirePermission` and the role
 * system do not apply to them; there is no role to hold. What stands in for
 * it is **which business** (`organizationId`) and **which of that business's
 * customers** (`contactId`) — the CRM contact the host resolves from
 * whatever credential got them onto the page, before any module is asked
 * anything. The host verifies the credential once; a module trusts the ids it
 * is handed but must still name both in every query, because a copied id is
 * exactly what `contactId` scoping exists to catch.
 *
 * ## Two gates, one of them new
 *
 * - **Entitlement**, the business's — `entitlement` is the same shape as a
 *   dashboard widget's: what the licence must grant beyond loading the module
 *   at all. A business without Booking has no Booking section for anyone,
 *   because the module is never loaded and never registers one.
 * - **Presence**, the customer's — `hasAny` replaces the permission check a
 *   staff surface would use, because none applies here. It answers whether
 *   *this* contact has anything in this section at all, and is checked before
 *   `load` and before the section is offered. A customer who has never booked
 *   gets no Booking section, not an empty one: an empty section would tell a
 *   customer who has no other way of knowing that the business runs Booking,
 *   and would tell anyone who later reads the page over their shoulder that
 *   this customer never has. Absence is the only answer that discloses
 *   nothing either way.
 */
export interface AccountSection {
  /** Unique across modules; the module id is a good prefix. */
  id: string;
  label: string;
  icon?: string;
  /**
   * What the licence must grant beyond loading the module at all.
   *
   * Most sections leave this off: loading the module was the entitlement.
   */
  entitlement?: { tier?: "pro"; module?: string };
  /**
   * Whether this customer has anything here at all.
   *
   * Checked before `load`, and before the section is offered — a section this
   * answers false for is left out of the response entirely.
   */
  hasAny: (organizationId: string, contactId: string) => Promise<boolean>;
  /** The section's figures, in the module's own words. Called only when `hasAny` said yes. */
  load: (organizationId: string, contactId: string) => Promise<SummaryFigure[]>;
  /**
   * Where "view" leads, for a module that already has a page of its own —
   * Shop's order history, a subscriber's own portal, a booking's manage link.
   * The host cannot name such a page for a module it does not import, so the
   * module names its own.
   */
  href?: (organizationId: string, contactId: string) => Promise<string | null>;
}

export interface RegisteredAccountSection extends AccountSection {
  moduleId: string;
}

/**
 * Module scope, not a class. See `widgets.ts` for why this is one array
 * rather than one per module: every module resolves the SDK to the host's own
 * copy, and the host clears it before loading because the boot tests load
 * modules more than once in one process.
 */
const registry: RegisteredAccountSection[] = [];

export function addAccountSection(section: RegisteredAccountSection): void {
  // By module and id together, like every registry here. Replacing on the bare
  // id meant a second module choosing the same word took the first one's
  // section off the customer's page with nothing said anywhere.
  const at = registry.findIndex(
    (s) => s.moduleId === section.moduleId && s.id === section.id,
  );
  if (at >= 0) registry[at] = section;
  else registry.push(section);
}

export function allAccountSections(): RegisteredAccountSection[] {
  return [...registry];
}

/** For tests and for a host that loads its modules more than once. */
export function clearAccountSections(): void {
  registry.length = 0;
}
