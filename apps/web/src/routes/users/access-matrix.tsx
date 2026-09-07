import { Card, muted } from "../../lib/ui";
import { RESOURCES } from "./policy-ui";

/**
 * What somebody may actually do, and where each grant came from — the
 * resolved view.
 *
 * `Matrix` in `../users.tsx` is a different thing answering a different
 * question: it is the *editor*, a checkbox grid a form uses to write a
 * policy's permissions. This is read-only, and it is not built from a
 * policy's own permission object — it takes `Grant[]`, the union already
 * computed by `resolveAccess` on the server from the policy given to somebody
 * directly and every group they are in, with every route to each grant named.
 * A grant reachable two ways — a person's own policy and one of their groups
 * both granting `invoicing:read` — is shown with both sources, because an
 * administrator who can only see one of them removes the wrong thing when
 * they take the person out of the group.
 */
export interface Grant {
  resource: string;
  action: string;
  sources: { kind: "policy" | "group"; name: string }[];
}

export interface AccessRow {
  resource: string;
  granted: { action: string; sources: Grant["sources"] }[];
}

/**
 * A `Grant[]` laid out resource by resource, including the resources with no
 * grants at all.
 *
 * Every resource the platform knows about gets a row, whether or not
 * anything in `grants` names it — a resource with nothing granted is shown
 * greyed by the caller rather than omitted, because the absence is the
 * answer to "why can't they do X" and leaving the row out would make the
 * screen say nothing where it should say no.
 *
 * Exported and tested on its own (`access-matrix.test.ts`) rather than only
 * exercised through the rendered component, per Ruling 39.
 */
export function accessRows(grants: Grant[]): AccessRow[] {
  return RESOURCES.map((r) => ({
    resource: r.name,
    granted: grants
      .filter((g) => g.resource === r.name)
      .map((g) => ({ action: g.action, sources: g.sources })),
  }));
}

/** `group "Accounting"` or `policy "Manager"`, matching the design's example. */
function sourceLabel(source: Grant["sources"][number]): string {
  return `${source.kind} "${source.name}"`;
}

export function AccessMatrix({ grants }: { grants: Grant[] }) {
  const rows = accessRows(grants);
  return (
    <Card>
      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.resource}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span className="w-28 shrink-0 text-sm font-medium">
              {row.resource}
            </span>
            {row.granted.length === 0 ? (
              <span className="text-sm" style={muted}>
                — not granted
              </span>
            ) : (
              <div className="flex flex-1 flex-wrap gap-x-4 gap-y-1">
                {row.granted.map((g) => (
                  <span key={g.action} className="text-sm">
                    {g.action}{" "}
                    <span className="text-xs" style={muted}>
                      ← {g.sources.map(sourceLabel).join(", ")}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
