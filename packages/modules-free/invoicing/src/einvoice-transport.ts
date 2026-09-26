/**
 * Getting a finished e-invoice onto the network, through somebody else.
 *
 * The document is ours: `einvoice.ts` builds EN 16931 as UBL and refuses to
 * build one that would be rejected. Delivery is not. Peppol is a network you
 * join through an access point, an access point is a commercial relationship
 * with per-document pricing, and standing in the middle of that would mean
 * holding one account for every customer's invoices and re-billing them for
 * something we only forwarded.
 *
 * So the business brings its own account and this is the shape every access
 * point is asked to fit. Two methods, because two questions come up before
 * an invoice can be sent to somebody: can this provider reach them, and did
 * the document go.
 *
 * **Nothing here holds a key.** Credentials are passed in per call, read from
 * the connection the business made in its own settings. No build of Sentrello
 * carries an account with anybody.
 */

/** Who a document is addressed to on the network. */
export interface PeppolAddress {
  /**
   * The scheme, as four digits: `0088` is GLN, `0208` a Belgian company
   * number, `9930` a German VAT id. A Peppol identifier is meaningless
   * without it — the same digits are a different company under another
   * scheme.
   */
  scheme: string;
  /** The identifier itself, as registered. */
  identifier: string;
}

export interface SendResult {
  /** What the access point calls this submission, for support and for polling. */
  reference: string;
}

export interface LookupResult {
  /** Whether the network can deliver to this address at all. */
  reachable: boolean;
  /** The receiver's registered name, when the provider knows it. */
  name?: string;
}

export interface TransportCredentials {
  apiKey: string;
  legalEntityId: string;
  sandbox: boolean;
}

/**
 * What a provider must be able to do.
 *
 * `fetch` is a parameter rather than a global so a test can answer for the
 * network. Every one of these methods is a request to somebody else's
 * service, which means every one of them is a thing that fails — the caller
 * gets an exception with the provider's own words in it, because "sending
 * failed" is not something a business can act on and "the receiver
 * 0088:123 is not registered" is.
 */
export interface EInvoiceTransport {
  /** Which access point this is, as stored on the connection. */
  readonly id: string;
  /** What to call it on screen. */
  readonly label: string;

  /**
   * Prove the credentials work, without sending anything.
   *
   * A key that has been revoked answers 401 and nothing else changes, so
   * without this the first sign is an invoice that did not arrive. Returns
   * the legal entity's own name, which is also the check that the id pasted
   * in belongs to the key pasted in.
   */
  check(
    credentials: TransportCredentials,
    http?: typeof fetch,
  ): Promise<{ name: string }>;

  /** Whether the network can deliver to an address. */
  lookup(
    address: PeppolAddress,
    credentials: TransportCredentials,
    http?: typeof fetch,
  ): Promise<LookupResult>;

  /** Put a document on the network. */
  send(
    document: { ubl: string; to: PeppolAddress },
    credentials: TransportCredentials,
    http?: typeof fetch,
  ): Promise<SendResult>;
}

/**
 * The providers this build knows about.
 *
 * A registry rather than a switch, so a module — or a business with one
 * developer and a country-specific network — can add one without editing
 * invoicing.
 */
const PROVIDERS = new Map<string, EInvoiceTransport>();

export function registerTransport(provider: EInvoiceTransport): void {
  PROVIDERS.set(provider.id, provider);
}

export function transportFor(id: string): EInvoiceTransport | null {
  return PROVIDERS.get(id) ?? null;
}

export function transports(): EInvoiceTransport[] {
  return [...PROVIDERS.values()];
}
