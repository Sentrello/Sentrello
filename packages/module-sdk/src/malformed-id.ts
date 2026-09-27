/**
 * An id that cannot be an id, recognised the same way on both sides.
 *
 * Here rather than in the host because the module harness has to answer it
 * the same way the host does — a harness that stops mirroring the host is a
 * test suite quietly describing behaviour nobody ships. `createModuleApp`
 * uses it, and `apps/server` imports it from here.
 *
 * No new dependency: this is a shape check over an error object, and this
 * package deliberately depends on nothing but Hono.
 */
/**
 * Whether a failure is only "that is not the shape of an id".
 *
 * Drizzle wraps the driver's error, so the cause chain is walked rather than
 * the top of it. `22P02` is `invalid_text_representation`, which Postgres
 * also raises for a bad integer or a bad enum — hence the second half: this
 * must not swallow anything but an id.
 */
export function isMalformedUuid(err: unknown): boolean {
  let at: unknown = err;
  for (let depth = 0; at && depth < 5; depth += 1) {
    const e = at as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      e.code === "22P02" &&
      typeof e.message === "string" &&
      e.message.includes("uuid")
    ) {
      return true;
    }
    at = e.cause;
  }
  return false;
}

/**
 * Whether a failure is Postgres cutting a statement that ran too long.
 *
 * `57014` is `query_canceled`, which is what `statement_timeout` raises. It
 * is not a fault in the request and it is not a fault a person can do
 * anything about by trying again — but it *is* one a self-hoster can do
 * something about, which is why it must not arrive as "something went
 * wrong". See `statementTimeout` in `@sentrello/db`.
 *
 * Beside `isMalformedUuid` and walked the same way, because drizzle wraps
 * the driver's error and the code is somewhere down the cause chain.
 */
export function isStatementTimeout(err: unknown): boolean {
  let at: unknown = err;
  for (let depth = 0; at && depth < 5; depth += 1) {
    const e = at as { code?: unknown; cause?: unknown };
    if (e.code === "57014") return true;
    at = e.cause;
  }
  return false;
}
