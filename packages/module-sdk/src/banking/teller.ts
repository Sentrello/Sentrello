import type {
  BankAccountInfo,
  BankCapabilities,
  BankCredentials,
  BankProvider,
  BankTransactionPage,
  ConnectionStart,
  PaymentResult,
} from "./provider";

/**
 * The simpler of the two, and the cheaper one to start with.
 *
 * Free to a hundred connections and priced per call after that, which suits a
 * business with one bank account and no appetite for an application process.
 * Two limits it is honest about up front, both in `capabilities` so the screen
 * can say them before anybody commits:
 *
 *  - **United States only.** It cannot serve the other three markets, so a
 *    business in Canada or the UK is choosing the other provider whether it
 *    knows it or not.
 *  - **Payments go over Zelle**, not ACH. Excellent for paying a contractor
 *    once; wrong for a monthly supplier bill, which is exactly the case the
 *    other provider is here for.
 *
 * It authenticates with a client certificate rather than a secret in a header,
 * which is why the secret stored here is the certificate and its key.
 */
const api = () => process.env.TELLER_API_BASE ?? "https://api.teller.io";

async function call<T>(
  credentials: BankCredentials,
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${api()}${path}`, {
    ...init,
    headers: {
      // The enrolment's own token is the username, with no password.
      authorization: `Basic ${btoa(`${accessToken}:`)}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const said = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(
      said.error?.message ?? `the bank connection failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

export const teller: BankProvider = {
  id: "teller",

  capabilities(): BankCapabilities {
    return {
      name: "Teller",
      countries: ["US"],
      payments: true,
      // Named as a business would say it, not as the rail is documented.
      rails: ["Zelle"],
      // Its payments are one at a time. A monthly bill would have to be sent
      // by hand every month, which is not a schedule.
      recurringPayments: false,
      onboarding:
        "A free account covers up to a hundred connected banks. It works with " +
        "United States banks only, and it can send a one-off payment but not " +
        "set up a repeating one.",
      // Its enrolment is a widget, and this application does not load one.
      hostedConnection: false,
    };
  },

  async startConnection(credentials, args): Promise<ConnectionStart> {
    /**
     * Nothing is fetched here.
     *
     * Its widget is opened with the application id, and the enrolment comes
     * back from the browser — there is no token to create first. The contract
     * still asks for this step because the other provider needs it, and a
     * screen that has to know which provider it is talking to before it can
     * open a window is a screen that will get it wrong when a third arrives.
     */
    void args;
    return {
      token: credentials.clientId ?? "",
      provider: "teller",
    };
  },

  async completeConnection(_credentials, publicToken) {
    // The enrolment token *is* the lasting credential: there is nothing to
    // exchange it for, and pretending otherwise would mean storing a token
    // that had already been spent.
    return { accessToken: publicToken, institutionName: null };
  },

  async listAccounts(credentials, accessToken): Promise<BankAccountInfo[]> {
    const accounts = await call<TellerAccount[]>(
      credentials,
      "/accounts",
      accessToken,
    );

    return await Promise.all(
      accounts.map(async (account) => {
        let balanceCents: number | null = null;
        try {
          const balance = await call<{ available: string; ledger: string }>(
            credentials,
            `/accounts/${account.id}/balances`,
            accessToken,
          );
          // Strings, in whole units, so the rounding happens once and here.
          balanceCents = Math.round(
            Number.parseFloat(balance.available ?? balance.ledger) * 100,
          );
        } catch {
          // A balance that will not load is a figure this screen leaves blank
          // rather than a bank it refuses to show.
        }

        return {
          reference: account.id,
          name: account.name,
          last4: account.last_four ?? null,
          kind: account.subtype ?? account.type ?? "other",
          currency: account.currency ?? "USD",
          balanceCents,
        };
      }),
    );
  },

  async syncTransactions(
    credentials,
    accessToken,
    cursor,
  ): Promise<BankTransactionPage> {
    const accounts = await call<TellerAccount[]>(
      credentials,
      "/accounts",
      accessToken,
    );

    /**
     * It pages backwards from the newest, so the cursor here is the last
     * transaction already seen rather than a token the provider issues.
     *
     * Which means a sync stops when it reaches something known, and a bank
     * that posts a transaction late is caught by the next full pass rather
     * than missed for ever — the failure the date-window approach has.
     */
    const seen = cursor;
    const transactions: BankTransactionPage["transactions"] = [];
    let newest: string | null = null;

    for (const account of accounts) {
      const rows = await call<TellerTransaction[]>(
        credentials,
        `/accounts/${account.id}/transactions?count=500`,
        accessToken,
      );
      for (const row of rows) {
        if (seen && row.id === seen) break;
        newest ??= row.id;
        transactions.push({
          reference: row.id,
          accountReference: account.id,
          // Already signed the way this product reads: negative is money out.
          amountCents: Math.round(Number.parseFloat(row.amount) * 100),
          currency: account.currency ?? "USD",
          description: row.description,
          postedAt: new Date(`${row.date}T00:00:00Z`),
          pending: row.status !== "posted",
          category: row.details?.category ?? null,
        });
      }
    }

    // Nothing to remove: it does not report deletions, and inventing them
    // would mean guessing that a transaction we cannot see has been reversed.
    return { transactions, cursor: newest ?? cursor, removed: [] };
  },

  async disconnect(credentials, accessToken) {
    await call(credentials, "/accounts", accessToken, { method: "DELETE" });
  },

  async pay(credentials, accessToken, request): Promise<PaymentResult> {
    const sent = await call<{ id: string; status: string }>(
      credentials,
      `/accounts/${request.fromAccountReference}/payments`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "zelle",
          amount: (request.amountCents / 100).toFixed(2),
          // Zelle addresses a person, not an account number.
          counterparty: { name: request.payee.name },
          memo: request.description.slice(0, 80),
        }),
      },
    );
    return { reference: sent.id, status: sent.status, expectedAt: null };
  },

  // No `payRepeatedly`: it cannot schedule one, and a screen offering a button
  // this provider will not honour is worse than one that says it cannot.
};

interface TellerAccount {
  id: string;
  name: string;
  last_four?: string | null;
  type?: string;
  subtype?: string;
  currency?: string;
}

interface TellerTransaction {
  id: string;
  amount: string;
  description: string;
  date: string;
  status: string;
  details?: { category?: string | null };
}
