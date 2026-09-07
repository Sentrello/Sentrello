import {
  activeOrganizationId,
  mayAccess,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, inArray, isNull, schema } from "@sentrello/db";
import { record } from "@sentrello/db/security-events";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import { banking, secrets } from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { applyRules } from "./bank-rules";

/**
 * A live bank connection, instead of a file somebody downloads every week.
 *
 * The reconciliation machinery already here works in terms of an import — a
 * statement, and the rows on it. A feed makes one of those per sync rather
 * than a second kind of row, so matching, the money list and the reconcile
 * screen all keep working with nothing rewritten.
 *
 * **Most people setting this up are not technical.** That shapes nearly every
 * decision below: the provider's own words are passed through rather than a
 * status code, a connection that has quietly stopped says so on the screen
 * instead of showing stale figures, and what a provider *cannot* do is
 * answered before somebody picks it rather than when they try.
 */

/** Nothing here is Free: a bank feed is part of what a licence buys. */
export function registerBankFeeds(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  /**
   * Hourly, because a bank posts when it posts.
   *
   * Registered whatever the licence says and gated when it runs, the same as
   * the recurring bills job: the host collects jobs as a module loads, so a
   * licence arriving later must not need a restart to start syncing, and one
   * lapsing must stop the work rather than leave a scheduler entry nobody can
   * see.
   */
  ctx.registerJob({
    name: "bank-feeds",
    cron: "37 * * * *",
    handler: async () => {
      if (!ctx.entitled({ tier: "pro" })) return { skipped: "not entitled" };
      await syncEveryConnection();
      return { synced: true };
    },
  });

  /**
   * What a business is choosing between, in its own words.
   *
   * Read from the providers rather than written here twice: a screen that
   * describes a provider from a list of its own is a screen that will one day
   * describe it wrongly.
   */
  ctx.app.get(
    "/api/bank-feeds/providers",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const held = await db
        .select({
          provider: schema.bankProviderAccounts.provider,
          testMode: schema.bankProviderAccounts.testMode,
          isDefault: schema.bankProviderAccounts.isDefault,
          verifiedAt: schema.bankProviderAccounts.verifiedAt,
          clientId: schema.bankProviderAccounts.clientId,
        })
        .from(schema.bankProviderAccounts)
        .where(eq(schema.bankProviderAccounts.organizationId, orgId));

      /**
       * Whether this person may connect a bank, asked rather than assumed.
       *
       * The bookkeeper can see the connections and fetch a statement — that is
       * their job — and cannot link the business's bank account to the books,
       * which is a decision about access to the accounts. Without this the
       * screen would offer them buttons that answer 403, which is the same
       * failure as offering a repeating payment to a provider that cannot
       * schedule one: a control that cannot be honoured.
       */
      const mayConnect = await mayAccess(c.req.raw.headers, {
        payments: ["connect"],
      });

      return c.json({
        mayConnect,
        providers: banking.BANK_PROVIDERS.map((provider) => {
          const mine = held.find((h) => h.provider === provider.id);
          return {
            id: provider.id,
            ...provider.capabilities(),
            // Whether this business has credentials for it, never what they
            // are. The client id is not secret and the screen shows it so
            // somebody can tell which account they pasted in.
            connected: Boolean(mine),
            clientId: mine?.clientId ?? null,
            testMode: mine?.testMode ?? true,
            isDefault: mine?.isDefault ?? false,
            verifiedAt: mine?.verifiedAt ?? null,
          };
        }),
      });
    },
  );

  /** Pasting in the credentials a business got from its provider. */
  ctx.app.put(
    "/api/bank-feeds/providers/:provider",
    requireSession(),
    requirePermission({ payments: ["connect"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("provider") ?? "";
      const provider = banking.bankProvider(id);
      if (!provider) return c.json({ error: "no such provider" }, 404);

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const secret = String(body.secret ?? "").trim();
      if (!secret) return c.json({ error: "the secret is needed" }, 400);

      const clientId =
        typeof body.clientId === "string" && body.clientId.trim()
          ? body.clientId.trim()
          : null;
      const testMode = body.testMode !== false;

      const [existing] = await db
        .select({ id: schema.bankProviderAccounts.id })
        .from(schema.bankProviderAccounts)
        .where(
          and(
            eq(schema.bankProviderAccounts.organizationId, orgId),
            eq(schema.bankProviderAccounts.provider, id),
          ),
        )
        .limit(1);

      const values = {
        organizationId: orgId,
        provider: id,
        clientId,
        secret: secrets.seal(secret),
        testMode,
        // The first one set is the one new connections go through, so a
        // business that only ever adds one never has to think about it.
        isDefault: !existing,
        // Pasting a new secret un-verifies it: what was proved was the old one.
        verifiedAt: null,
      };

      if (existing) {
        await db
          .update(schema.bankProviderAccounts)
          .set(values)
          .where(eq(schema.bankProviderAccounts.id, existing.id));
      } else {
        await db.insert(schema.bankProviderAccounts).values(values);
      }

      /**
       * Written down, because somebody will need to know.
       *
       * Changing which account reads a business's bank is exactly the kind of
       * thing that is obvious at the time and unanswerable six months later.
       * The log already carries who changed a role or turned off somebody's
       * second factor; a bank belongs in the same place.
       */
      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "bank.credentials.changed",
        detail: { provider: id, testMode },
      });

      return c.json({ saved: true });
    },
  );

  /**
   * Proving the credentials work before anybody relies on them.
   *
   * The same shape as the payment settings: save, test, then use. Somebody who
   * mistypes a secret should find out here, not when a bank connection fails
   * three days later with a message about tokens.
   */
  ctx.app.post(
    "/api/bank-feeds/providers/:provider/test",
    requireSession(),
    requirePermission({ payments: ["connect"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("provider") ?? "";
      const provider = banking.bankProvider(id);
      if (!provider) return c.json({ error: "no such provider" }, 404);

      const credentials = await credentialsFor(orgId, id);
      if (!credentials) return c.json({ error: "nothing saved yet" }, 400);

      try {
        // Starting a connection is the cheapest call that needs the secret to
        // be right, and it creates nothing.
        await provider.startConnection(credentials, {
          organizationId: orgId,
          returnUrl: `${base(c)}/accounting-banking`,
        });
      } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 200);
      }

      await db
        .update(schema.bankProviderAccounts)
        .set({ verifiedAt: new Date() })
        .where(
          and(
            eq(schema.bankProviderAccounts.organizationId, orgId),
            eq(schema.bankProviderAccounts.provider, id),
          ),
        );
      return c.json({ ok: true });
    },
  );

  /** Step one of connecting a bank: the token the provider's window opens with. */
  ctx.app.post(
    "/api/bank-feeds/connect/start",
    requireSession(),
    requirePermission({ payments: ["connect"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        provider?: unknown;
      };
      const id = typeof body.provider === "string" ? body.provider : "";
      const provider = banking.bankProvider(id);
      if (!provider) return c.json({ error: "no such provider" }, 404);

      const credentials = await credentialsFor(orgId, id);
      if (!credentials) {
        return c.json(
          {
            error: `there are no ${provider.capabilities().name} details saved yet`,
          },
          400,
        );
      }

      try {
        const start = await provider.startConnection(credentials, {
          organizationId: orgId,
          returnUrl: `${base(c)}/accounting-banking`,
        });
        return c.json(start);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    },
  );

  /** Step two: what the provider's window handed back. */
  ctx.app.post(
    "/api/bank-feeds/connect/finish",
    requireSession(),
    // The other half of the same decision as starting one.
    requirePermission({ payments: ["connect"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const id = typeof body.provider === "string" ? body.provider : "";
      const provider = banking.bankProvider(id);
      if (!provider) return c.json({ error: "no such provider" }, 404);

      const credentials = await credentialsFor(orgId, id);
      if (!credentials) return c.json({ error: "nothing saved yet" }, 400);

      /**
       * Where the token comes from depends on whose page they were just on.
       *
       * A provider that hosts the flow never hands the browser a public token
       * — the instance asks afterwards what the session produced, which is
       * also why one never appears in an address bar or a history. One that
       * uses a widget gives it to the browser, which passes it here. Both end
       * at the same exchange.
       */
      let publicToken =
        typeof body.publicToken === "string" ? body.publicToken : "";
      if (!publicToken && provider.resultOf) {
        const startToken =
          typeof body.startToken === "string" ? body.startToken : "";
        if (!startToken) {
          return c.json({ error: "that connection did not complete" }, 400);
        }
        try {
          const said = await provider.resultOf(credentials, startToken);
          if (!said.publicToken) {
            // Somebody closed the window before choosing a bank. Nothing was
            // connected and nothing is broken, so this is not an error.
            return c.json({ connection: null, accounts: 0 });
          }
          publicToken = said.publicToken;
        } catch (err) {
          return c.json({ error: (err as Error).message }, 502);
        }
      }
      if (!publicToken) {
        return c.json({ error: "that connection did not complete" }, 400);
      }

      try {
        const done = await provider.completeConnection(
          credentials,
          publicToken,
        );
        const [connection] = await db
          .insert(schema.bankConnections)
          .values({
            organizationId: orgId,
            provider: id,
            institutionName: done.institutionName,
            accessToken: secrets.seal(done.accessToken),
            testMode: credentials.test,
          })
          .returning();
        if (!connection) throw new Error("the connection was not saved");

        // Bring the accounts in straight away: a connection that shows nothing
        // until a job runs at some point looks like it did not work.
        const brought = await adoptAccounts(
          orgId,
          provider,
          credentials,
          done.accessToken,
        );

        /**
         * And try for the transactions, knowing they may not be there yet.
         *
         * A bank asked for its history the moment it is connected answers with
         * nothing: the provider spends a few seconds preparing it. Verified
         * against the sandbox — the first call came back with no transactions
         * and no cursor, the second with seventeen.
         *
         * Best-effort, so a connection is never reported as failed because the
         * history was not warm yet. What it buys is the common case where it
         * is, and the rows are there before anybody looks; when it is not, the
         * screen says the bank is still preparing them and the hourly job
         * finishes the job.
         */
        await syncConnection({ ...connection, cursor: null }).catch(() => {});

        await record({
          organizationId: orgId,
          actor: c.get("session").user,
          action: "bank.connected",
          detail: {
            provider: id,
            bank: done.institutionName,
            testMode: credentials.test,
            accountsAdded: brought,
          },
        });

        return c.json(
          { connection: { id: connection.id }, accounts: brought },
          201,
        );
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    },
  );

  /** The banks this business has connected, and whether each is still working. */
  ctx.app.get(
    "/api/bank-feeds",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select({
          id: schema.bankConnections.id,
          provider: schema.bankConnections.provider,
          institutionName: schema.bankConnections.institutionName,
          testMode: schema.bankConnections.testMode,
          lastSyncedAt: schema.bankConnections.lastSyncedAt,
          lastError: schema.bankConnections.lastError,
          createdAt: schema.bankConnections.createdAt,
        })
        .from(schema.bankConnections)
        .where(eq(schema.bankConnections.organizationId, orgId))
        .orderBy(desc(schema.bankConnections.createdAt));
      // The token is not in the select on purpose: there is no shape of this
      // response that should carry it.
      return c.json({ connections: rows });
    },
  );

  /**
   * Fetching now, because somebody is looking at the screen.
   *
   * Bookkeeping rather than payments: this brings a statement in and moves no
   * money, and the person reconciling is exactly who wants to press it.
   */
  ctx.app.post(
    "/api/bank-feeds/:id/sync",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [connection] = await db
        .select()
        .from(schema.bankConnections)
        .where(
          and(
            eq(schema.bankConnections.id, c.req.param("id") ?? ""),
            eq(schema.bankConnections.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!connection) return c.json({ error: "not found" }, 404);

      const result = await syncConnection(connection);
      return result.error
        ? c.json({ error: result.error }, 502)
        : c.json({ added: result.added, updated: result.updated });
    },
  );

  ctx.app.delete(
    "/api/bank-feeds/:id",
    requireSession(),
    requirePermission({ payments: ["connect"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [connection] = await db
        .select()
        .from(schema.bankConnections)
        .where(
          and(
            eq(schema.bankConnections.id, c.req.param("id") ?? ""),
            eq(schema.bankConnections.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!connection) return c.json({ error: "not found" }, 404);

      /**
       * Ended at the provider as well, not only here.
       *
       * A row deleted on our side while the provider keeps refreshing the
       * connection is a business that thinks it has disconnected its bank and
       * has not. If the provider refuses, the row still goes — but it is said
       * out loud rather than swallowed.
       */
      let saidAtProvider: string | null = null;
      const provider = banking.bankProvider(connection.provider);
      const credentials = await credentialsFor(orgId, connection.provider);
      if (provider && credentials) {
        try {
          await provider.disconnect(
            credentials,
            secrets.open(connection.accessToken),
          );
        } catch (err) {
          saidAtProvider = (err as Error).message;
        }
      }

      await db
        .delete(schema.bankConnections)
        .where(eq(schema.bankConnections.id, connection.id));

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "bank.disconnected",
        detail: {
          provider: connection.provider,
          bank: connection.institutionName,
          // Whether the provider agreed it was ended, because a row deleted
          // here while the provider keeps refreshing is a business that thinks
          // it has disconnected and has not.
          endedAtProvider: saidAtProvider === null,
        },
      });

      // What came in stays: those rows are a statement somebody may already
      // have reconciled against, and removing them would unpick the books.
      return c.json({ disconnected: true, providerSaid: saidAtProvider });
    },
  );
}

/** The business's own credentials for one provider, unsealed. */
export async function credentialsFor(
  organizationId: string,
  provider: string,
): Promise<banking.BankCredentials | null> {
  const [row] = await db
    .select()
    .from(schema.bankProviderAccounts)
    .where(
      and(
        eq(schema.bankProviderAccounts.organizationId, organizationId),
        eq(schema.bankProviderAccounts.provider, provider),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    clientId: row.clientId,
    secret: secrets.open(row.secret),
    test: row.testMode,
  };
}

/**
 * Every account behind a new connection becomes one in the chart.
 *
 * A business connecting its bank expects to see its bank, not to then be asked
 * to create an account and say which is which. An account that already carries
 * the same last four digits is matched rather than duplicated — reconnecting
 * after a bank asks for a fresh login is the ordinary case, and it must not
 * leave two of everything.
 */
async function adoptAccounts(
  organizationId: string,
  provider: banking.BankProvider,
  credentials: banking.BankCredentials,
  accessToken: string,
): Promise<number> {
  const accounts = await provider.listAccounts(credentials, accessToken);
  const existing = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, organizationId));

  let brought = 0;
  for (const account of accounts) {
    /**
     * The provider's own id first, the last four digits only as a fallback.
     *
     * Two accounts at one bank can end in the same four digits — a current and
     * a savings opened together often do — and treating them as one puts a
     * business's savings into its current account. The digits are still worth
     * checking, for the account somebody added by hand before ever connecting
     * a feed.
     */
    const already = existing.find(
      (row) =>
        row.isBank &&
        (row.bankProviderReference === account.reference ||
          (row.bankProviderReference === null &&
            account.last4 !== null &&
            row.bankAccountLast4 === account.last4)),
    );
    if (already) {
      // Claim it, so the next sync finds it by reference rather than by four
      // digits it may share with another account.
      if (!already.bankProviderReference) {
        await db
          .update(schema.accounts)
          .set({ bankProviderReference: account.reference })
          .where(eq(schema.accounts.id, already.id));
      }
      continue;
    }

    // A code that does not collide with the chart's own numbering.
    const used = new Set(existing.map((row) => row.code));
    let code = 1010;
    while (used.has(String(code))) code += 1;

    await db.insert(schema.accounts).values({
      organizationId,
      code: String(code),
      name: account.name,
      // A bank account is money the business has: an asset, always.
      type: "asset",
      isBank: true,
      bankName: provider.capabilities().name,
      bankAccountLast4: account.last4,
      bankProviderReference: account.reference,
    });
    used.add(String(code));
    brought += 1;
  }
  return brought;
}

export interface SyncResult {
  added: number;
  updated: number;
  /** How many of them a rule put straight into an account. */
  categorised?: number;
  error?: string;
}

/**
 * One connection, brought up to date.
 *
 * Errors are stored rather than thrown out of the job: a bank that wants
 * somebody to sign in again is the commonest thing that happens to a feed, and
 * it is a message on a screen rather than a failed job nobody reads.
 */
export async function syncConnection(connection: {
  id: string;
  organizationId: string;
  provider: string;
  institutionName: string | null;
  accessToken: string;
  cursor: string | null;
}): Promise<SyncResult> {
  const provider = banking.bankProvider(connection.provider);
  const credentials = await credentialsFor(
    connection.organizationId,
    connection.provider,
  );
  if (!provider || !credentials) {
    const error = "the details for this provider are missing";
    await note(connection.id, error);
    return { added: 0, updated: 0, error };
  }

  let page: banking.BankTransactionPage;
  try {
    page = await provider.syncTransactions(
      credentials,
      secrets.open(connection.accessToken),
      connection.cursor,
    );
  } catch (err) {
    const error = (err as Error).message;
    await note(connection.id, error);
    return { added: 0, updated: 0, error };
  }

  let added = 0;
  let updated = 0;

  /**
   * The bank's own account ids, mapped to the accounts in the chart.
   *
   * Without this a synced line does not say which account it left, and
   * anything that posts it — a rule, or somebody categorising it — has to
   * guess. One read for the statement rather than one per line.
   */
  const ledgerAccounts = await db
    .select({
      id: schema.accounts.id,
      reference: schema.accounts.bankProviderReference,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, connection.organizationId));
  const byReference = new Map(
    ledgerAccounts
      .filter((row) => row.reference)
      .map((row) => [row.reference as string, row.id]),
  );

  if (page.transactions.length > 0) {
    /**
     * One statement per sync that brought anything.
     *
     * Everything downstream is written in terms of an import, so a feed that
     * invented its own kind of row would need matching, reconciliation and the
     * money list written a second time.
     */
    const [statement] = await db
      .insert(schema.bankImports)
      .values({
        organizationId: connection.organizationId,
        filename: `${connection.institutionName ?? provider.capabilities().name} — ${new Date().toISOString().slice(0, 10)}`,
      })
      .returning();
    if (!statement) throw new Error("the statement was not created");

    /**
     * Which of these the business already has.
     *
     * `INSERT … ON CONFLICT DO UPDATE … RETURNING` hands back a row either
     * way, so counting the returned rows called every sync an all-new one and
     * reported nothing as updated, ever. Asked first instead.
     */
    const seen = new Set(
      (
        await db
          .select({
            reference: schema.bankTransactions.providerReference,
          })
          .from(schema.bankTransactions)
          .where(
            and(
              eq(
                schema.bankTransactions.organizationId,
                connection.organizationId,
              ),
              inArray(
                schema.bankTransactions.providerReference,
                page.transactions.map((row) => row.reference),
              ),
            ),
          )
      ).map((row) => row.reference),
    );

    for (const row of page.transactions) {
      await db
        .insert(schema.bankTransactions)
        .values({
          organizationId: connection.organizationId,
          importId: statement.id,
          date: row.postedAt,
          description: row.description,
          amountCents: row.amountCents,
          providerReference: row.reference,
          bankAccountId: byReference.get(row.accountReference) ?? null,
          pending: row.pending,
          category: row.category,
        })
        .onConflictDoUpdate({
          target: [
            schema.bankTransactions.organizationId,
            schema.bankTransactions.providerReference,
          ],
          // Amount, description and pending only. The match somebody made
          // against the ledger is theirs and a later sync does not undo it.
          set: {
            amountCents: row.amountCents,
            description: row.description,
            pending: row.pending,
            date: row.postedAt,
          },
        });
      if (seen.has(row.reference)) updated += 1;
      else added += 1;
    }
  }

  /**
   * What the bank took back.
   *
   * A pending card authorisation that never settles is withdrawn rather than
   * corrected, and a line left behind for one is money the statement says was
   * never spent — a reconciliation that cannot be made to balance and a
   * business hunting for a transaction its bank no longer has.
   *
   * Only ever a line nobody has reconciled. If somebody has already posted
   * against it the ledger holds the truth of what they did, and deleting the
   * statement line underneath would hide it rather than correct it.
   */
  if (page.removed.length > 0) {
    await db
      .delete(schema.bankTransactions)
      .where(
        and(
          eq(schema.bankTransactions.organizationId, connection.organizationId),
          inArray(schema.bankTransactions.providerReference, page.removed),
          isNull(schema.bankTransactions.matchedEntryId),
        ),
      );
  }

  await db
    .update(schema.bankConnections)
    .set({ cursor: page.cursor, lastSyncedAt: new Date(), lastError: null })
    .where(eq(schema.bankConnections.id, connection.id));

  /**
   * And then the rules, on what just arrived.
   *
   * The point of a feed for somebody who is not an accountant: the statement
   * comes in overnight and the recurring half of it is already in the right
   * accounts by morning. A rule that cannot post leaves its line alone rather
   * than failing the sync — the transactions are safely in either way.
   */
  const ruled = await applyRules(connection.organizationId);

  return { added, updated, categorised: ruled.applied };
}

async function note(connectionId: string, error: string): Promise<void> {
  await db
    .update(schema.bankConnections)
    .set({ lastError: error, lastSyncedAt: new Date() })
    .where(eq(schema.bankConnections.id, connectionId));
}

/** Every connection on this instance, for the job. */
export async function syncEveryConnection(): Promise<void> {
  const connections = await db.select().from(schema.bankConnections);
  for (const connection of connections) {
    // One bank failing is not the others' problem.
    try {
      await syncConnection(connection);
    } catch (err) {
      console.error("[accounting] a bank sync failed", err);
    }
  }
}

function base(c: RouteContext): string {
  return process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
}
