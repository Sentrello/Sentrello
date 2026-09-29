/**
 * The banner for a paid module that is not running.
 *
 * `/healthz` has reported this for a while, and the licence screen explains
 * it — and `pro-core` still managed to be dark for weeks, twice, because
 * both places require somebody to go and look. Since the paid half of
 * Bookkeeping moved into its own bundle the stakes stopped being cosmetic: a
 * missing bundle is bills, banking and reconciliation gone, and recurring
 * invoices silently not raised. So the fault comes to the screen instead,
 * on every page, until it is fixed.
 *
 * The server decides who sees it: `/api/_meta` carries the names only for
 * somebody whose role can open the settings screen the banner points at.
 * An instance with nothing wrong sends an empty list, and this draws
 * nothing at all — which is every Free instance and every healthy Pro one.
 */
export function ModuleFailures({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-md border px-3 py-2 text-sm"
      style={{
        borderColor: "var(--text-danger)",
        color: "var(--text-danger)",
      }}
    >
      <strong>A paid module is not running:</strong> {names.join(", ")}.
      Everything it provides is unavailable — including work it does on its own,
      like sending recurring invoices.{" "}
      {/* Linked, not merely named: the screen with the reason on it is four
          clicks away and this banner already knows which one it is. */}
      <a className="link" href="/settings-licence">
        Settings &rarr; Licence and updates
      </a>{" "}
      has the reason and the remedy.
    </div>
  );
}

/**
 * The banner for a card that did not go through.
 *
 * A failed payment gives fourteen days in which everything keeps working, and
 * the only place that said so was one line on the licence screen. A business
 * that does not go and look therefore learns about it the way it is worst
 * learned: paid features gone, on a Tuesday morning, with no idea why.
 *
 * Said here instead, on every screen, with the day it stops and where to fix
 * it. Same audience as `ModuleFailures` — `/api/_meta` sends the date only to
 * somebody whose role can open the licence screen — and nothing at all for a
 * business whose billing is fine, which is all of them nearly all of the time.
 */
export function BillingWarning({ until }: { until: string | null }) {
  if (!until) return null;
  const when = new Date(until);
  if (Number.isNaN(when.getTime())) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-md border px-3 py-2 text-sm"
      style={{
        borderColor: "var(--text-warning)",
        color: "var(--text-warning)",
      }}
    >
      {/*
        The date is the *deadline* — the first moment Pro stops — so it is said
        as the day features stop rather than the day they keep working until.
        "Keeps working until the 16th" from a window that ends at midnight on
        the 16th is a day the product promised and would not have delivered.
      */}
      <strong>A payment did not go through.</strong> Paid features stop on{" "}
      {when.toLocaleDateString()} unless the card is updated.{" "}
      <a className="link" href="/settings-licence">
        Settings &rarr; Licence and updates
      </a>{" "}
      has the card details and the remedy.
    </div>
  );
}

/**
 * The banner for a disk that is nearly full.
 *
 * What a full disk looks like from inside the product is PostgreSQL refusing to
 * write: an invoice that cannot be raised, a payment that cannot be recorded, a
 * ledger that stops — and by then it has already happened. The business whose
 * disk it is has no IT department and is not reading logs, so the warning has to
 * arrive on the screen they are already looking at.
 *
 * Only ever shown to somebody who can act on it, and only past ninety per cent:
 * a warning that appears with a fortnight of room left is one people learn to
 * ignore before the day it matters.
 */
export function DiskWarning({ percentUsed }: { percentUsed?: number }) {
  if (percentUsed === undefined) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-md border px-3 py-2 text-sm"
      style={{
        borderColor: "var(--text-danger)",
        color: "var(--text-danger)",
      }}
    >
      <strong>This server is {percentUsed}% full.</strong> When the disk fills,
      the database stops accepting writes — no invoices, no payments, nothing
      recorded.{" "}
      <a className="link" href="/settings-archive">
        Settings &rarr; Archive and storage
      </a>{" "}
      takes old records off the machine, and old backups are usually what is
      taking the room.
    </div>
  );
}
