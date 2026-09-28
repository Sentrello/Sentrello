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

/**
 * Every guarded route an app has actually registered.
 *
 * Ground truth, where `guardedRoutes` above is inference. It reads the
 * source with a regular expression, which works right up until a module
 * generates its routes — the CRM builds contacts, companies, deals, tasks,
 * tags, notes and activities from one template with a computed permission
 * key, so the scanner resolved none of the seven biggest record types in the
 * product and the gating test passed in silence over every screen that uses
 * them.
 *
 * Hono lists what it has registered, path and method included, and
 * `requirePermission` tags the middleware it returns. So this is not a better
 * guess: it is the table the server enforces, whatever shape the code that
 * registered it happened to take.
 *
 * The symbol is looked up by name rather than imported, because this package
 * is the one `@sentrello/auth` depends on and not the other way round.
 */
const DECLARES = Symbol.for("sentrello.requirePermission");

interface RoutesOf {
  routes: { method: string; path: string; handler: unknown }[];
}

export function declaredRoutes(app: RoutesOf): GuardedRoute[] {
  const out = new Map<string, GuardedRoute>();
  for (const route of app.routes) {
    const declared = (
      route.handler as Record<symbol, Record<string, string[]> | undefined>
    )?.[DECLARES];
    if (!declared) continue;
    const needs = Object.entries(declared)
      .map(([resource, actions]) => `${resource}: ${JSON.stringify(actions)}`)
      .join(", ");
    const found = {
      method: route.method.toUpperCase(),
      path: normalisePath(route.path),
      needs,
    };
    // `ALL` is Hono's wildcard method; a route registered that way guards
    // every verb, so it answers for each of them rather than for a verb
    // called "ALL" that no caller will ever ask about.
    const methods =
      found.method === "ALL"
        ? ["GET", "POST", "PATCH", "PUT", "DELETE"]
        : [found.method];
    for (const method of methods) {
      out.set(`${method} ${found.path}`, { ...found, method });
    }
  }
  return [...out.values()];
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
/*
 * The handlers a write can hang off.
 *
 * `Blur` is here because three writes in one module were "the blur is the
 * write" — task notes, a board column's name, the hours on a time entry, each
 * saved when the field was left rather than on a press. The alternation had
 * three names in it and those three were invisible, which is the same defect
 * as reading one line at a time and was found the same afternoon.
 *
 * Kept as one definition rather than two copies of the same list, because the
 * test above and the match below going out of step is how a scanner comes to
 * look for something it no longer recognises.
 */
/*
 * `Submit` was missing, and it is where a form's save lives.
 *
 * The sweep that put a permission on four hundred controls read `onClick`,
 * `onConfirm`, `onChange` and `onBlur`. A dialog's Save button is
 * `type="submit"` inside a `<form onSubmit={...}>`, so the mutation fires
 * from the form and not from the button — invisible here, and the guard
 * reported green over the two biggest record forms in the CRM.
 *
 * Found by drawing the product as somebody holding `read` and nothing else:
 * New contact was offered, the form opened, and Save was live all the way to
 * the 403.
 *
 * `KeyDown` for the same reason, one screen over. The button that adds a CRM
 * tag carries `needs`; the input beside it fires the same mutation on Enter
 * and carried nothing. So the control was refused and the keyboard was not.
 */
const HANDLERS = "Click|Confirm|Change|Blur|Submit|KeyDown";
const HANDLER = new RegExp(`on(?:${HANDLERS})=\\{`);
const FIRES = new RegExp(
  `on(?:${HANDLERS})=\\{[\\s\\S]{0,220}?(\\w+)\\.mutate`,
);

export function controlsFiringMutations(source: string): Control[] {
  const lines = source.split("\n");
  const out: Control[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    /*
     * The handler and the call it makes are often on different lines.
     *
     * `onClick={() =>` and `change.mutate({` sit one above the other wherever
     * the arguments are an object, which is most of the product — and reading
     * one line at a time this guard could not see any of them. It reported
     * zero ungated writes in three repositories while blind to **107 of the
     * 519 controls**, a fifth of the surface, which is the worse kind of
     * green: the kind that stops anybody looking.
     *
     * So the window is the handler and the four lines under it. It has to
     * start at the handler, so a `.mutate` on its own line is never counted
     * twice, and the cap keeps it inside one element rather than running on
     * into the next.
     */
    if (!HANDLER.test(lines[i] ?? "")) continue;
    /*
     * The cap alone does not keep the window inside one element, and a
     * self-closing one is where it runs on. `<ProjectPicker list={list}
     * chosen={chosen} onChange={setProjectId} />` sits one line above a
     * `<Button needs={{ seo: ["create"] }} onClick={() => start.mutate()}>`,
     * and the picker was read as the write: a site chooser, a note field, a
     * filter — all reads, all reported bare while the button above them
     * carried the permission all along. So the window also stops at the next
     * line that opens an element.
     */
    const withinElement: string[] = [];
    for (let k = i; k < Math.min(i + 5, lines.length); k += 1) {
      if (k > i && /^\s*<[A-Za-z]/.test(lines[k] ?? "")) break;
      withinElement.push(lines[k] ?? "");
    }
    const fired = FIRES.exec(withinElement.join("\n"));
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
      /*
       * Far enough to reach the request.
       *
       * Sixteen lines stopped short of it on any form that assembles a body
       * before it sends one — the contact form builds twenty lines of object
       * first — so the path was never found and the method fell through to
       * the default below.
       */
      const body = lines.slice(decl, decl + 48).join("\n");
      const call = /api[<(][^`"']*[`"']([^`"']+)[`"']/.exec(body);
      if (call?.[1]) path = normalisePath(call[1]);

      /*
       * The method, when it is not a literal.
       *
       * `method: "POST"` was the only shape read, and a form that both
       * creates and updates writes `method: contact ? "PATCH" : "POST"`.
       * That matched nothing, fell to `GET`, and every such control was
       * excused as a read — which is how the two biggest record forms in the
       * CRM carried no permission with the guard green over them.
       *
       * So: the literal if there is one, otherwise the strictest verb
       * quoted anywhere in the request, and otherwise a write. A mutation is
       * not a read. Defaulting the unknown case to `GET` made the guard
       * quieter exactly where it could not see.
       */
      const verb = /method:\s*"(\w+)"/.exec(body);
      if (verb?.[1]) {
        method = verb[1].toUpperCase();
      } else {
        const quoted = [...body.matchAll(/"(GET|POST|PATCH|PUT|DELETE)"/g)].map(
          (m) => (m[1] as string).toUpperCase(),
        );
        const rank = ["DELETE", "PUT", "PATCH", "POST", "GET"];
        method =
          quoted.sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0] ?? "POST";
      }
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
    /*
     * A few lines past the handler, because a keyboard shortcut asks inside
     * its own body.
     *
     * `onKeyDown={(e) => {` is the line this loop finds and `if (!may(...))
     * return;` is the line under it, so a window ending at the handler
     * reported the one screen that had already got this right as a gap. A
     * guard that reports a gap where there is none is the kind that gets
     * suppressed, and takes the real findings with it.
     */
    const tag = lines.slice(tagStart, i + 8).join("\n");
    /*
     * `needs=` is the usual way and `may(` is the other one: a checkbox has
     * no kit primitive to hang a prop on, so the compliance screen disables
     * itself by asking directly. Both are the control being gated, and a
     * guard that only knew the prop would report the honest one as a gap.
     */
    let gated = tag.includes("needs=") || /\bmay[A-Z(]/.test(tag);

    /*
     * A form's gate is on the button, not on the form.
     *
     * `<form onSubmit={...}>` is where the mutation fires, so that is the
     * element this loop finds — and `needs` belongs on the Save inside it,
     * which is the control somebody actually presses and the one the kit can
     * disable. Reading only the opening tag reported every properly gated
     * form as bare.
     *
     * Bounded to the form's own submit: the first `type="submit"` below it.
     */
    if (!gated && /^\s*<form\b/.test(lines[tagStart] ?? "")) {
      const within = lines.slice(i, i + 200).join("\n");
      const submit = within.indexOf('type="submit"');
      if (submit >= 0) {
        const around = within.slice(Math.max(0, submit - 400), submit + 400);
        gated = around.includes("needs=") || /\bmay[A-Z(]/.test(around);
      }
    }

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
