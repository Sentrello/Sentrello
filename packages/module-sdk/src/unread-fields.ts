import { readFileSync } from "node:fs";

/**
 * Fields a route accepts that no screen ever sends.
 *
 * The sweeps beside this one ask about routes: is this route reached, does this
 * request reach a route. Both were green while a project's customer — the
 * connection the Project Management module is built around — could not be set
 * from anywhere. `PATCH /api/projects/:id` *is* reached, by the status
 * dropdown, and a route being called says nothing about which of its fields
 * anybody can reach.
 *
 * So this asks the smaller question: the handler reads `body.companyId`; does
 * any screen put `companyId` in a request body? A field that is read and never
 * written is a capability that exists, is tested, is described in the module's
 * notes as built, and cannot be used.
 *
 * **It is a text sweep and it will be wrong sometimes.** Verify every hit
 * before believing it — some fields are genuinely written by something that is
 * not a screen, which is what `writtenElsewhere` is for, and writing a name
 * there falsely is how a module comes back clean with a dead field.
 */

/** `body.foo`, `body["foo"]`, and `const { foo, bar } = body`. */
export function fieldsRead(files: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const found = new Set<string>();

    for (const m of text.matchAll(/\bbody\.([A-Za-z_$][\w$]*)/g)) {
      if (m[1]) found.add(m[1]);
    }
    for (const m of text.matchAll(/\bbody\[\s*["'`]([^"'`]+)["'`]\s*\]/g)) {
      if (m[1]) found.add(m[1]);
    }
    /**
     * Destructuring, which is how about half of these handlers read a body.
     * Renames (`{ a: b }`) keep the wire name, which is the one on the left —
     * a screen sends `a`, and what the handler calls it afterwards is its own
     * business.
     */
    for (const m of text.matchAll(
      /(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:c\.req\.json\(\)|body\b)/g,
    )) {
      for (const part of (m[1] ?? "").split(",")) {
        const name = part
          .split(":")[0]
          ?.trim()
          .replace(/^\.\.\./, "");
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) found.add(name);
      }
    }

    if (found.size) out.set(file, found);
  }
  return out;
}

/**
 * Field names a screen puts into a request body.
 *
 * Deliberately not scoped to a particular request: matching a body to the fetch
 * it belongs to needs a parser, and the question here is only "can anybody set
 * this field at all". Scoping it per-call would trade real coverage for
 * precision nobody asked for, and the answer would still need verifying by
 * hand.
 *
 * It over-collects on purpose — every `key:` in the file, including ones that
 * are not request bodies at all. That biases the sweep towards missing a gap
 * rather than inventing one, which is the right way round: a guard that cries
 * wolf is a guard somebody switches off.
 */
export function fieldsWritten(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // `foo:` in an object literal, and shorthand `{ foo, bar }`.
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
      if (m[1]) out.add(m[1]);
    }
    for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
      for (const part of (m[1] ?? "").split(",")) {
        const name = part.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
      }
    }
  }
  return out;
}

/**
 * Fields the routes read that the screens never send, as `file: field`.
 *
 * `ignore` is for the names that are noise rather than findings — a body field
 * called `id` or `name` is written by everything, and a handler's own locals
 * sometimes look like body reads.
 */
export function unreadFields(args: {
  routeFiles: string[];
  screenFiles: string[];
  /** Field names written by something that is not a screen, and why. */
  writtenElsewhere?: Record<string, string>;
  ignore?: string[];
}): string[] {
  const written = fieldsWritten(args.screenFiles);
  const excused = new Set([
    ...Object.keys(args.writtenElsewhere ?? {}),
    ...(args.ignore ?? []),
  ]);

  const missing: string[] = [];
  for (const [file, fields] of fieldsRead(args.routeFiles)) {
    for (const field of fields) {
      if (written.has(field) || excused.has(field)) continue;
      missing.push(`${file.split("/").slice(-2).join("/")}: ${field}`);
    }
  }
  return missing.sort();
}
