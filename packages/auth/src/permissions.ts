import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
} from "better-auth/plugins/organization/access";

// Resources Sentrello guards, on top of Better Auth's org/member/invitation defaults.
export const statement = {
  ...defaultStatements,
  // The first screen after signing in. Read-only and held by every role,
  // including the ones that can do almost nothing else — a person who cannot
  // see the landing page has nowhere to land.
  dashboard: ["read"],
  /**
   * `manage` is writing the automations, and is deliberately its own action.
   *
   * Somebody with `update` can change a deal. Somebody who can publish an
   * automation can change every deal that ever matches a rule, and email every
   * customer it touches — the same verb at a completely different scale. A
   * business should be able to let its sales team use the CRM without letting
   * them write rules that act on the whole book.
   */
  crm: ["read", "create", "update", "delete", "manage"],
  invoicing: ["read", "create", "update", "delete", "send"],
  bookkeeping: ["read", "create", "update", "delete"],
  /**
   * Moving money out of the business's own bank.
   *
   * Its own resource, not an action on `bookkeeping`, because categorising a
   * transaction and sending an ACH payment to a supplier are not the same job
   * and should not be the same grant. A bookkeeper reconciles all day and has
   * no business paying anybody; the person who approves payments may never
   * touch the ledger.
   *
   * `connect` is held apart from `send` for the same reason: whoever links the
   * business's bank account to the books is making a decision about access to
   * the accounts, which is not the same decision as paying one invoice.
   *
   * Granted by no default role except the owner's. A business that wants
   * somebody else paying suppliers says so deliberately, which is the whole
   * point.
   */
  payments: ["read", "connect", "send"],
  reports: ["read"],
  settings: ["read", "update"],
  // Optional modules declare their resources here too: the access-control
  // statement is compiled into the client as well as the server, so it cannot
  // be extended at runtime by a bundle.
  time: ["read", "create", "update", "delete", "approve"],
  scheduling: ["read", "create", "update", "delete"],
  shop: ["read", "create", "update", "delete"],
  /**
   * The till, which is a different job from editing the menu.
   *
   * `sell` is ringing a sale; `void` and `refund` are the two a business wants
   * a manager's name against; `manage` is the floor plan, the modifiers and
   * the drawer. Editing what is *for sale* stays under `shop`, because it is
   * the same catalogue the website sells from and a business that lets every
   * counter shift change prices has a different problem.
   *
   * Its own resource rather than actions on `shop` for that reason: a till
   * operator sells all day and should never be able to reprice anything.
   */
  pos: ["read", "sell", "void", "refund", "manage"],
  /**
   * Selling the same thing every month.
   *
   * Two actions rather than the usual four: looking at who is on what, and
   * changing it. A pause, a plan change and a cancellation are the same
   * decision about somebody's bill, and splitting them into create/update/
   * delete would describe the table rather than the job.
   *
   * Its own resource rather than actions on `invoicing`, because the two are
   * different work: raising an invoice for work done is a bookkeeper's, and
   * ending a customer's membership is not.
   */
  subscriptions: ["read", "manage"],
  documents: ["read", "create", "update", "delete"],
  /**
   * The mailing list.
   *
   * `send` is its own action for the same reason invoicing's is: writing a
   * campaign and putting it in front of eleven thousand people are different
   * decisions, and a business with a marketing assistant wants the first
   * without the second.
   */
  newsletter: ["read", "create", "update", "delete", "send"],
  /**
   * Short links and what became of the people who followed them.
   *
   * `read` is the reports and the list; `update` covers making and changing
   * links. `domains` is its own action because pointing a domain at this
   * instance is an act with DNS behind it — a marketing assistant writes
   * links all day and should not be able to claim a company's domain.
   */
  links: ["read", "create", "update", "delete", "domains"],
  /**
   * Search visibility.
   *
   * `read` opens the screens; `create` is the one that spends money — keyword
   * research, a site audit and a rank check are all paid calls to an outside
   * provider, and somebody who may look at last month's report should not be
   * able to run up a bill with it.
   */
  seo: ["read", "create", "update", "delete"],
  /**
   * Project management, which ships with Pro.
   *
   * Two actions beyond the usual four. Everybody on a job fills in a
   * timesheet and far fewer people move dates, so `log-time` is separable
   * from `update`; and setting what a job may cost is not the same authority
   * as running it, so `budget` is separable from both.
   */
  projects: ["read", "create", "update", "delete", "log-time", "budget"],
  /**
   * The documentation site.
   *
   * `read` opens the screens; `update` connects the repository and changes how
   * the site looks; `delete` removes a version or a language, which takes that
   * version's pages with it.
   *
   * The published site itself is public and guarded by none of this — a reader
   * has no account. These are for the business's own screens.
   */
  docs: ["read", "create", "update", "delete"],
  /**
   * Withdrawn modules, kept as resources and granted by nothing.
   *
   * Inventory, Make Deal, HR and Time Tracking are gone for good — no code, no
   * bundle, nothing on the price list. These names stay in the statement and
   * nowhere else.
   *
   * `projects` used to be here too, for a module built and deleted the day
   * after. It is a live resource again, listed above with the modules that
   * exist, and granted by the roles that should have it.
   *
   * The reason is that a business can define its own roles, and one saved
   * before the modules were withdrawn may still name them. A statement that no
   * longer knows a resource is a role that fails to load, which locks somebody
   * out of the modules that *are* installed — a worse outcome than a handful
   * of dead keys. They appear in no built-in role, so they grant nothing.
   *
   * Delete them when the role loader ignores resources it does not recognise
   * rather than refusing the whole statement.
   */
  inventory: ["read", "create", "update", "delete"],
  hr: ["read", "create", "update", "delete", "approve"],
  "make-deal": ["read", "create", "update"],
} as const;

export const ac = createAccessControl(statement);

// Instance Owner — full control of THEIR business (not a platform super admin;
// that's Packet 03).
export const admin = ac.newRole({
  ...adminAc.statements,
  dashboard: ["read"],
  crm: ["read", "create", "update", "delete", "manage"],
  invoicing: ["read", "create", "update", "delete", "send"],
  bookkeeping: ["read", "create", "update", "delete"],
  // The owner of the instance can pay people. Nobody else does by default.
  payments: ["read", "connect", "send"],
  reports: ["read"],
  settings: ["read", "update"],
  time: ["read", "create", "update", "delete", "approve"],
  scheduling: ["read", "create", "update", "delete"],
  shop: ["read", "create", "update", "delete"],
  pos: ["read", "sell", "void", "refund", "manage"],
  subscriptions: ["read", "manage"],
  documents: ["read", "create", "update", "delete"],
  newsletter: ["read", "create", "update", "delete", "send"],
  links: ["read", "create", "update", "delete", "domains"],
  seo: ["read", "create", "update", "delete"],
  docs: ["read", "create", "update", "delete"],
  projects: ["read", "create", "update", "delete", "log-time", "budget"],
});

// External portal users — RBAC is intentionally tiny; row-level scoping to their
// OWN records is enforced in the module routes, not by RBAC alone.
export const customer = ac.newRole({
  dashboard: ["read"],
  invoicing: ["read"],
});

/**
 * The roles compiled into the product.
 *
 * Deliberately two, not four. Better Auth reserves exactly these names —
 * `Object.keys(roles)` — and refuses to let a business define a role of its
 * own by any of them. Every name here is a name the owner of the instance can
 * never use, so the list is kept to the ones that genuinely cannot be data:
 *
 * `admin` is what the instance owner is given when the instance is claimed,
 * before any organization exists to hold a row. A business able to delete it
 * could lock itself out of its own machine.
 *
 * `customer` is assigned by the portal when somebody is granted access, which
 * is code rather than a person choosing from a list.
 *
 * `staff` and `accounting` used to be here, and being here was the only reason
 * a business could not edit them. They are ordinary roles now, created from
 * the same defaults as Executives, Managers and the rest, and they can be
 * renamed, changed and deleted like any other. Their permissions live in the
 * users module's defaults, which is the one place that describes them.
 */
export const roles = { admin, customer };
