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
      like sending recurring invoices. Settings &rarr; Licence has the reason
      and the remedy.
    </div>
  );
}
