/**
 * Which control fires which route, and what that route asks for.
 *
 * Written after getting the same two answers wrong three times each, by hand
 * and then by script. Both mistakes look like a working answer, which is why
 * they survived: a permission that is plausible and wrong disables a control
 * for somebody entitled to it, or leaves one open that should not be.
 *
 * ## The two traps, which is most of why this file exists
 *
 * **A mutation is found by name, and names repeat.** `accounting.tsx` holds
 * two `post` and two `add`; `mod-shop` holds six `save`. Keying them into a
 * map gives every control with that name the *last* declaration parsed. The
 * answer is the nearest declaration **above** the control — lexical scope,
 * which is what the compiler would say. Twenty-one of Pro's eighty-four
 * derived answers were wrong this way, and the tell was a route in the
 * output, `PUT /api/accounting/period`, that exists nowhere.
 *
 * **A path matches its GET before its PATCH.** `/api/subscriptions/proration/
 * settings` is `subscriptions: ["read"]` on the way in and
 * `subscriptions: ["manage"]` on the way out. Matching on the path alone
 * takes whichever comes first in the file and is usually the read — the
 * permissive one. So the method is part of the key, never an afterthought.
 */

/** A route that declares a permission: `POST /api/invoices/:id/void`. */
export interface GuardedRoute {
  method: string;
  /** With every parameter and template hole reduced to `:x`. */
  path: string;
  /** Verbatim from `requirePermission`, e.g. `invoicing: ["update"]`. */
  needs: string;
}

/** `:id`, `:taskId` and `${kind}` all stand for "something goes here". */
export function normalisePath(path: string): string {
  return path
    .replace(/\$\{[^}]*\}/g, ":x")
    .replace(/:[A-Za-z_]\w*/g, ":x")
    .replace(/\?.*$/, "");
}

/** Every permission-guarded route in a file of server source. */
export function guardedRoutes(source: string): GuardedRoute[] {
  const out: GuardedRoute[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const verb = /app\.(get|post|patch|put|delete)\(/.exec(lines[i] ?? "");
    if (!verb) continue;
    // The route's own head: its path, then its middleware, before the handler.
    const head = lines.slice(i, i + 10).join("\n");
    const path = /[`"']([^`"']*\/api\/[^`"']*)[`"']/.exec(head);
    if (!path?.[1]) continue;
    const guard = /requirePermission\(\s*\{([^}]*)\}\s*\)/.exec(head);
    if (!guard?.[1]) continue;
    out.push({
      method: (verb[1] as string).toUpperCase(),
      path: normalisePath(path[1]),
      needs: guard[1].trim().replace(/\s+/g, " "),
    });
  }
  return out;
}

/** A control that fires a mutation, and what it carries. */
export interface Control {
  line: number;
  /** The mutation it calls. */
  mutation: string;
  /** Whether a `needs` prop is already on it. */
  gated: boolean;
  /** The route it reaches, once resolved. */
  method?: string;
  path?: string;
}

/**
 * Every control in a screen that fires a mutation, with the route resolved
 * from the declaration **in scope for it** rather than by name.
 */
export function controlsFiringMutations(source: string): Control[] {
  const lines = source.split("\n");
  const out: Control[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const fired = /on(?:Click|Confirm|Change)=\{[^}]*?(\w+)\.mutate/.exec(
      lines[i] ?? "",
    );
    if (!fired?.[1]) continue;
    const name = fired[1];

    // Lexical scope: the nearest declaration above, never a map keyed by name.
    let decl = -1;
    for (let j = i; j >= 0; j -= 1) {
      if (
        new RegExp(`\\bconst ${name} = useMutation\\b`).test(lines[j] ?? "")
      ) {
        decl = j;
        break;
      }
    }

    let method: string | undefined;
    let path: string | undefined;
    if (decl >= 0) {
      const body = lines.slice(decl, decl + 16).join("\n");
      const call = /api[<(][^`"']*[`"']([^`"']+)[`"']/.exec(body);
      const verb = /method:\s*"(\w+)"/.exec(body);
      if (call?.[1]) path = normalisePath(call[1]);
      method = verb?.[1]?.toUpperCase() ?? "GET";
    }

    /*
     * The prop sits in the element's own opening tag, which starts at the
     * nearest line above that opens one — not a fixed number of lines back.
     *
     * A window of twelve reported a `ConfirmButton` as bare when its `needs`
     * was thirteen lines up, above a long `message`. A guard that reports a
     * gap where there is none is worse than no guard: it gets suppressed, and
     * takes the real findings with it.
     */
    let tagStart = i;
    while (tagStart > 0 && !/^\s*<[A-Za-z]/.test(lines[tagStart] ?? "")) {
      tagStart -= 1;
    }
    const tag = lines.slice(tagStart, i + 1).join("\n");
    const gated = tag.includes("needs=");

    out.push({ line: i + 1, mutation: name, gated, method, path });
  }
  return out;
}

/** The permission a control's route asks for, or null if it has none. */
export function needsFor(
  control: Control,
  routes: GuardedRoute[],
): string | null {
  if (!control.method || !control.path) return null;
  const hit = routes.find(
    (r) => r.method === control.method && r.path === control.path,
  );
  return hit?.needs ?? null;
}
