/**
 * The bank connection contract.
 *
 * Written the same way as the payment processor one beside it, and for the
 * same reason: a business pastes its own credentials into a screen, and every
 * part of the product that talks to a bank goes through one interface. The
 * keys belong to the business. Sentrello is never in the money flow, never the
 * originator of a payment, and on a self-hosted instance never sees any of it.
 *
 * **Two providers, deliberately.** The same argument as Stripe and PayPal: one
 * integration is a dependency, two is a choice. They are not two flavours of
 * one flow —
 *
 *  - one hands back a short-lived token, the customer picks their bank in a
 *    window it owns, and gives back a permanent token to exchange;
 *  - the other enrols through its own widget and returns an enrolment the
 *    business keeps.
 *
 * Writing to whichever came first and generalising later would bake its shape
 * in, which is exactly what happened with payments before this pattern
 * existed.
 *
 * **Reading and paying are separate capabilities on purpose.** Every provider
 * can read an account. Not every provider can move money, and the ones that
 * can do it over different rails with different limits — so a business is told
 * what its choice can and cannot do *before* it connects, rather than finding
 * out when it tries to pay a supplier.
 */

/** What a business pasted in, sealed and stored per organization and mode. */
export interface BankCredentials {
  /** The provider's own client identifier, where it has one. */
  clientId: string | null;
  secret: string;
  /** Whether these are the provider's sandbox credentials. */
  test: boolean;
}

/**
 * What a provider can actually do, asked before anything is connected.
 *
 * A business choosing between two providers is choosing between different
 * capabilities, and the screen has to be able to say so plainly. Most people
 * using this are not going to read an API's documentation to find out that
 * their choice cannot pay a supplier in another country.
 */
export interface BankCapabilities {
  /** What the provider is called, to a person. */
  name: string;
  /** Countries whose banks it can connect, as ISO 3166-1 alpha-2. */
  countries: string[];
  /** Whether it can move money at all, not only read. */
  payments: boolean;
  /** The rails it pays over, named the way a business would say them. */
  rails: string[];
  /** Whether it can schedule a payment that repeats. */
  recurringPayments: boolean;
  /**
   * What a business has to do before it can use this, in one sentence.
   *
   * Not every provider is a paste-a-key affair: moving money means being
   * underwritten, and a business that discovers that halfway through setting
   * up a supplier payment has been misled by the screen that offered it.
   */
  onboarding: string;
}

/** A bank account as the provider describes it. */
export interface BankAccountInfo {
  /** The provider's id for it, stored so a sync can find it again. */
  reference: string;
  name: string;
  /** Last four digits only. Enough to recognise, useless to anybody else. */
  last4: string | null;
  /** checking | savings | credit | other — what the business calls it. */
  kind: string;
  currency: string;
  /** In integer cents, like every other figure in this product. */
  balanceCents: number | null;
}

/** One movement on a statement. */
export interface BankTransactionInfo {
  reference: string;
  accountReference: string;
  /** Positive is money in. Providers disagree about the sign; adapters fix it. */
  amountCents: number;
  currency: string;
  description: string;
  postedAt: Date;
  /** Whether the bank still calls this provisional. */
  pending: boolean;
  /** What the provider guessed it was, when it guesses. */
  category: string | null;
}

/**
 * A page of movements, and where to carry on from.
 *
 * Cursor rather than dates: a bank can post a transaction days late and
 * re-fetching "since last Tuesday" either misses it or fetches the week again
 * every time. The cursor is the provider's own answer to what has changed.
 */
export interface BankTransactionPage {
  transactions: BankTransactionInfo[];
  /** Given back on the next call. Null when the provider has no more. */
  cursor: string | null;
  /** References the provider says are gone and should be removed here too. */
  removed: string[];
}

/** Starting a connection: what the browser needs to open the provider's window. */
export interface ConnectionStart {
  /** The short-lived token the provider's widget is opened with. */
  token: string;
  /** Which provider, so the screen knows which flow it is in. */
  provider: string;
  /**
   * A page the provider hosts, when it offers one.
   *
   * Strongly preferred over a widget. The alternative is loading a third
   * party's JavaScript into the application a business runs its books in — on
   * a product whose argument is that the data stays on their machine, that is
   * a script with access to every page it is loaded on. A redirect to somebody
   * else's page and back has none of that reach.
   *
   * When this is present the browser never sees a public token: it comes back
   * to the instance, which asks the provider what happened. See
   * `resultOf` below.
   */
  url?: string;
}

export interface PaymentRequest {
  /** The connected account the money leaves. */
  fromAccountReference: string;
  amountCents: number;
  currency: string;
  /** What it is for, as it should read on the statement. */
  description: string;
  /**
   * Who is being paid.
   *
   * A supplier's own bank details, because paying a bill is a credit to
   * somebody outside this business. Moving money between the business's own
   * accounts uses the same shape with an account it already holds.
   */
  payee: {
    name: string;
    accountNumber: string;
    routingNumber: string;
    /** Whether the receiving account is a business or a person. */
    kind: "business" | "personal";
  };
  /** When it repeats, if it does. */
  schedule?: {
    /** week | month | quarter | year */
    every: string;
    startsOn: Date;
    endsOn: Date | null;
  };
}

export interface PaymentResult {
  reference: string;
  /** pending | posted | failed | cancelled */
  status: string;
  /** When the provider expects it to land. */
  expectedAt: Date | null;
}

/**
 * What every bank provider does.
 *
 * `pay` and `payRepeatedly` are optional because not every provider has them,
 * and a screen that offers a button the provider cannot honour is worse than a
 * screen that says so.
 */
export interface BankProvider {
  readonly id: string;
  capabilities(): BankCapabilities;

  /** Step one: the token the provider's own window is opened with. */
  startConnection(
    credentials: BankCredentials,
    args: { organizationId: string; returnUrl: string },
  ): Promise<ConnectionStart>;

  /**
   * What happened in a hosted session, asked of the provider afterwards.
   *
   * Only for providers that host the flow themselves. The browser comes back
   * with nothing but the token it started with, so the instance asks what the
   * session produced — which also means a public token never passes through
   * anybody's browser or address bar.
   */
  resultOf?(
    credentials: BankCredentials,
    startToken: string,
  ): Promise<{ publicToken: string | null }>;

  /**
   * Step two: what the window handed back, exchanged for something lasting.
   *
   * The value returned here is what gets sealed and stored. It is not the
   * business's provider secret — it is permission to read one set of accounts,
   * and revoking it is how a business disconnects a bank.
   */
  completeConnection(
    credentials: BankCredentials,
    publicToken: string,
  ): Promise<{ accessToken: string; institutionName: string | null }>;

  listAccounts(
    credentials: BankCredentials,
    accessToken: string,
  ): Promise<BankAccountInfo[]>;

  syncTransactions(
    credentials: BankCredentials,
    accessToken: string,
    cursor: string | null,
  ): Promise<BankTransactionPage>;

  /** Ends the connection at the provider, not only here. */
  disconnect(credentials: BankCredentials, accessToken: string): Promise<void>;

  pay?(
    credentials: BankCredentials,
    accessToken: string,
    request: PaymentRequest,
  ): Promise<PaymentResult>;

  payRepeatedly?(
    credentials: BankCredentials,
    accessToken: string,
    request: PaymentRequest,
  ): Promise<PaymentResult>;
}
