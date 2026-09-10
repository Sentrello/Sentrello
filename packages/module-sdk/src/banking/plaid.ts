import type {
  BankAccountInfo,
  BankCapabilities,
  BankCredentials,
  BankProvider,
  BankTransactionPage,
  ConnectionStart,
  PaymentRequest,
  PaymentResult,
} from "./provider";

/**
 * The provider that covers every market this product is sold into.
 *
 * Read as a base URL rather than a constant so a test can point it at a stub:
 * the same reason the payment adapters do it, and the reason those could be
 * tested at all.
 */
const api = (test: boolean) =>
  process.env.PLAID_API_BASE ??
  (test ? "https://sandbox.plaid.com" : "https://production.plaid.com");

async function call<T>(
  credentials: BankCredentials,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${api(credentials.test)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: credentials.clientId,
      secret: credentials.secret,
      ...body,
    }),
  });

  if (!res.ok) {
    /**
     * The provider's own words, not ours.
     *
     * It answers with a display message written for the person who is stuck —
     * "your bank needs you to log in again" — and a code for us. Throwing away
     * the first and showing a status code is how a business ends up ringing
     * somebody instead of doing the one thing that would fix it.
     */
    const said = (await res.json().catch(() => ({}))) as {
      error_message?: string;
      display_message?: string;
      error_code?: string;
    };
    throw new Error(
      said.display_message ??
        said.error_message ??
        `the bank connection failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

/** Whole currency units to integer cents, which is what this product stores. */
function cents(amount: number | null | undefined): number {
  return Math.round((amount ?? 0) * 100);
}

export const plaid: BankProvider = {
  id: "plaid",

  capabilities(): BankCapabilities {
    return {
      name: "Plaid",
      // The four markets this product is sold into, and no others.
      countries: ["US", "CA", "GB", "IE", "FR", "ES", "NL", "DE"],
      payments: true,
      rails: ["ACH", "Same-day ACH", "RTP", "Wire"],
      recurringPayments: true,
      onboarding:
        "Reading accounts needs a free developer account. Moving money is a " +
        "separate application: they check who you are before you can send a " +
        "payment, and that takes a few days.",
      hostedConnection: true,
    };
  },

  async startConnection(credentials, args): Promise<ConnectionStart> {
    const made = await call<{ link_token: string; hosted_link_url?: string }>(
      credentials,
      "/link/token/create",
      {
        user: { client_user_id: args.organizationId },
        client_name: "Sentrello",
        products: ["transactions"],
        country_codes: ["US", "CA", "GB"],
        language: "en",
        /**
         * Their page, not their script in ours.
         *
         * The usual integration loads the provider's JavaScript into the
         * application. On a product whose argument is that a business's data
         * stays on its own machine, that is a third party with reach into
         * every page of the books. A redirect there and back has none of it,
         * and the public token never passes through the browser at all.
         */
        hosted_link: { completion_redirect_uri: args.returnUrl },
      },
    );
    return {
      token: made.link_token,
      provider: "plaid",
      url: made.hosted_link_url,
    };
  },

  async resultOf(credentials, startToken) {
    /**
     * What the hosted session produced.
     *
     * The browser comes back knowing only the token it left with, so the
     * instance asks. A session somebody abandoned answers with no public
     * token, which is a connection that did not happen rather than an error.
     */
    const session = await call<{
      link_sessions?: {
        results?: { item_add_results?: { public_token: string }[] };
      }[];
    }>(credentials, "/link/token/get", { link_token: startToken });

    const added =
      session.link_sessions?.[0]?.results?.item_add_results?.[0]?.public_token;
    return { publicToken: added ?? null };
  },

  async completeConnection(credentials, publicToken) {
    const swapped = await call<{ access_token: string; item_id: string }>(
      credentials,
      "/item/public_token/exchange",
      { public_token: publicToken },
    );

    // The bank's name, so the screen can say "Chase" rather than an item id.
    let institutionName: string | null = null;
    try {
      const item = await call<{ item: { institution_id?: string } }>(
        credentials,
        "/item/get",
        { access_token: swapped.access_token },
      );
      if (item.item.institution_id) {
        const found = await call<{ institution: { name: string } }>(
          credentials,
          "/institutions/get_by_id",
          {
            institution_id: item.item.institution_id,
            country_codes: ["US", "CA", "GB"],
          },
        );
        institutionName = found.institution.name;
      }
    } catch {
      // A missing name is a worse label, not a failed connection.
    }

    return { accessToken: swapped.access_token, institutionName };
  },

  async listAccounts(credentials, accessToken): Promise<BankAccountInfo[]> {
    const got = await call<{
      accounts: {
        account_id: string;
        name: string;
        mask: string | null;
        subtype: string | null;
        balances: { current: number | null; iso_currency_code: string | null };
      }[];
    }>(credentials, "/accounts/get", { access_token: accessToken });

    return got.accounts.map((account) => ({
      reference: account.account_id,
      name: account.name,
      last4: account.mask,
      kind: account.subtype ?? "other",
      currency: account.balances.iso_currency_code ?? "USD",
      balanceCents:
        account.balances.current === null
          ? null
          : cents(account.balances.current),
    }));
  },

  async syncTransactions(
    credentials,
    accessToken,
    cursor,
  ): Promise<BankTransactionPage> {
    const page = await call<{
      added: PlaidTransaction[];
      modified: PlaidTransaction[];
      removed: { transaction_id: string }[];
      next_cursor: string;
      has_more: boolean;
    }>(credentials, "/transactions/sync", {
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
      count: 500,
    });

    /**
     * Added and modified together, because both mean "this is what it says
     * now". A bank amends a transaction days later — the amount settles, the
     * description gains a merchant name — and treating a modification as new
     * would leave the old one beside it, which is a duplicate on a statement
     * somebody is reconciling.
     */
    return {
      transactions: [...page.added, ...page.modified].map((t) => ({
        reference: t.transaction_id,
        accountReference: t.account_id,
        /**
         * Sign flipped on purpose.
         *
         * This provider reports money *leaving* as positive. Every figure in
         * this product reads the other way — positive is money in — and a
         * ledger that disagrees with itself about which way is out is not
         * worth having.
         */
        amountCents: -cents(t.amount),
        currency: t.iso_currency_code ?? "USD",
        description: t.merchant_name ?? t.name,
        postedAt: new Date(`${t.date}T00:00:00Z`),
        pending: t.pending,
        category: t.personal_finance_category?.primary ?? null,
      })),
      /**
       * Null rather than an empty string.
       *
       * The first sync after a bank is connected comes back with nothing at
       * all and no cursor — the provider is still preparing the history, which
       * takes a few seconds. Storing "" and sending it next time is a cursor
       * that means nothing; storing null means "start from the beginning",
       * which is what is actually wanted.
       */
      cursor: page.next_cursor || null,
      removed: page.removed.map((r) => r.transaction_id),
    };
  },

  async disconnect(credentials, accessToken) {
    await call(credentials, "/item/remove", { access_token: accessToken });
  },

  async pay(credentials, accessToken, request): Promise<PaymentResult> {
    const authorised = await authorise(credentials, accessToken, request);
    const sent = await call<{ transfer: PlaidTransfer }>(
      credentials,
      "/transfer/create",
      {
        access_token: accessToken,
        account_id: request.fromAccountReference,
        authorization_id: authorised,
        description: statementText(request.description),
      },
    );
    return {
      reference: sent.transfer.id,
      status: sent.transfer.status,
      expectedAt: sent.transfer.expected_settlement_date
        ? new Date(sent.transfer.expected_settlement_date)
        : null,
    };
  },

  async payRepeatedly(
    credentials,
    accessToken,
    request,
  ): Promise<PaymentResult> {
    if (!request.schedule) {
      throw new Error("a repeating payment needs a schedule");
    }
    const made = await call<{
      recurring_transfer: { recurring_transfer_id: string; status: string };
    }>(credentials, "/transfer/recurring/create", {
      access_token: accessToken,
      account_id: request.fromAccountReference,
      idempotency_key: crypto.randomUUID(),
      type: "credit",
      network: "ach",
      // Paying a business rather than a person. The class is not decoration:
      // it is what the receiving bank uses to decide how the payment may be
      // returned, and the wrong one is a payment that bounces oddly.
      ach_class: request.payee.kind === "business" ? "ccd" : "ppd",
      amount: (request.amountCents / 100).toFixed(2),
      description: statementText(request.description),
      schedule: {
        start_date: request.schedule.startsOn.toISOString().slice(0, 10),
        ...(request.schedule.endsOn
          ? { end_date: request.schedule.endsOn.toISOString().slice(0, 10) }
          : {}),
        interval_unit: request.schedule.every,
        interval_count: 1,
        interval_execution_day: request.schedule.startsOn.getUTCDate(),
      },
      user: { legal_name: request.payee.name },
    });
    return {
      reference: made.recurring_transfer.recurring_transfer_id,
      status: made.recurring_transfer.status,
      expectedAt: request.schedule.startsOn,
    };
  },
};

/**
 * A payment is authorised before it is sent.
 *
 * Two calls rather than one, because the provider decides in between whether
 * it will stand behind this transfer — and a refusal here is a payment that
 * never left, which is a far better outcome than one that leaves and is
 * returned a week later with a fee.
 */
async function authorise(
  credentials: BankCredentials,
  accessToken: string,
  request: PaymentRequest,
): Promise<string> {
  const decided = await call<{
    authorization: {
      id: string;
      decision: string;
      decision_rationale?: { description?: string };
    };
  }>(credentials, "/transfer/authorization/create", {
    access_token: accessToken,
    account_id: request.fromAccountReference,
    type: "credit",
    network: "ach",
    amount: (request.amountCents / 100).toFixed(2),
    ach_class: request.payee.kind === "business" ? "ccd" : "ppd",
    user: { legal_name: request.payee.name },
  });

  if (decided.authorization.decision !== "approved") {
    throw new Error(
      decided.authorization.decision_rationale?.description ??
        "the bank would not authorise this payment",
    );
  }
  return decided.authorization.id;
}

/**
 * What the other side will actually see on their statement.
 *
 * The rails allow ten characters. Sending more is not an error — it is
 * silently cut, and the supplier rings up asking what "INVOICE 20" was.
 */
function statementText(description: string): string {
  return description.replace(/[^\x20-\x7E]/g, "").slice(0, 10) || "PAYMENT";
}

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  name: string;
  merchant_name: string | null;
  date: string;
  pending: boolean;
  personal_finance_category?: { primary: string } | null;
}

interface PlaidTransfer {
  id: string;
  status: string;
  expected_settlement_date?: string;
}
