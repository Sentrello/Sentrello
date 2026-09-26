/**
 * Storecove, as an access point the business owns rather than one we do.
 *
 * Storecove is a Peppol aggregator: one API, one account, and they carry the
 * membership of the network itself. Their pricing is per document on top of
 * a subscription, which is exactly why this is a bring-your-own-key
 * integration — the customer signs up, the customer is billed, and Sentrello
 * never has an account to be charged for somebody else's invoices.
 *
 * **There is no key in this repository and no build ships one.** Everything
 * below takes credentials as an argument, read from the row the business
 * filled in on its own settings screen.
 *
 * Written against the v2 API. The sandbox is the same endpoint with a
 * sandbox key, which is Storecove's own design: a test key cannot reach the
 * live network, so `sandbox` on the connection is about telling the person
 * which one they pasted rather than about routing.
 */
import type {
  EInvoiceTransport,
  LookupResult,
  PeppolAddress,
  SendResult,
  TransportCredentials,
} from "./einvoice-transport";

const BASE = "https://api.storecove.com/api/v2";

/**
 * Their error, in their words, with ours around it.
 *
 * A failed submission is read by somebody who has just pressed Send on a
 * real invoice, and "request failed" tells them nothing about whether to
 * try again, fix an address, or ring their access point. Storecove answers
 * with a JSON body naming the field; this keeps it.
 */
async function refuse(what: string, response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  let said = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const detail =
      (parsed.message as string) ??
      (parsed.error as string) ??
      JSON.stringify(parsed.errors ?? parsed);
    if (detail) said = String(detail).slice(0, 400);
  } catch {
    // Not JSON. The text is what we have.
  }
  /*
   * A 401 from Storecove carries no body at all, so the sentence has to
   * stand on its own — "refused the key (401):" with nothing after the
   * colon reads like the message was cut off. Measured against the real
   * service with a key that was never valid.
   */
  const because = said ? `: ${said}` : ".";
  throw new Error(
    response.status === 401 || response.status === 403
      ? `Storecove refused the key (${response.status}). Check it is the key for this account, and that it is the live key if this connection is live${because}`
      : `Storecove could not ${what} (${response.status})${because}`,
  );
}

function headers(credentials: TransportCredentials): HeadersInit {
  return {
    authorization: `Bearer ${credentials.apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

export const storecove: EInvoiceTransport = {
  id: "storecove",
  label: "Storecove",

  async check(credentials, http = fetch) {
    const response = await http(
      `${BASE}/legal_entities/${encodeURIComponent(credentials.legalEntityId)}`,
      { headers: headers(credentials) },
    );
    if (!response.ok) await refuse("read the legal entity", response);
    const entity = (await response.json()) as { party_name?: string };
    /*
     * The name is the point of this call, not a nicety. A key and a legal
     * entity id are two long strings from two different pages of somebody's
     * dashboard, and pasting the wrong pair is the ordinary mistake —
     * showing the business its own name back is how they know they got it
     * right.
     */
    return { name: entity.party_name ?? "" };
  },

  async lookup(address, credentials, http = fetch) {
    const response = await http(`${BASE}/discovery/receives`, {
      method: "POST",
      headers: headers(credentials),
      body: JSON.stringify({
        network: "peppol",
        scheme: `${address.scheme}`,
        identifier: address.identifier,
      }),
    });
    if (!response.ok) await refuse("look the receiver up", response);
    const found = (await response.json()) as {
      code?: string;
      party_name?: string;
    };
    /*
     * `code: "ok"` means the network has them. Anything else is a business
     * that is not reachable this way, which is not an error — it is the
     * answer, and the invoice goes by email instead.
     */
    const result: LookupResult = { reachable: found.code === "ok" };
    if (found.party_name) result.name = found.party_name;
    return result;
  },

  async send(document, credentials, http = fetch) {
    const response = await http(`${BASE}/document_submissions`, {
      method: "POST",
      headers: headers(credentials),
      body: JSON.stringify({
        legalEntityId: credentials.legalEntityId,
        routing: {
          eIdentifiers: [
            { scheme: document.to.scheme, id: document.to.identifier },
          ],
        },
        document: {
          documentType: "invoice",
          /*
           * The document we already build, handed over whole.
           *
           * Storecove will also assemble an invoice from JSON, and taking
           * that route would mean two descriptions of the same invoice —
           * ours, which is validated against EN 16931 and refuses to be
           * wrong, and theirs. `rawDocumentData` sends the UBL that passed
           * our own rules, so what is on the network is what the business
           * downloaded and what the ledger says.
           */
          rawDocumentData: {
            document: Buffer.from(document.ubl, "utf8").toString("base64"),
            parse: false,
            parseStrategy: "ubl",
          },
        },
      }),
    });
    if (!response.ok) await refuse("send the invoice", response);
    const made = (await response.json()) as { guid?: string; id?: string };
    const reference = made.guid ?? made.id;
    if (!reference) {
      throw new Error(
        "Storecove accepted the invoice and did not say what it called it, so there is nothing to follow up with.",
      );
    }
    return { reference } satisfies SendResult;
  },
};

/**
 * The address a Peppol identifier is written as on an invoice: `0088:123…`.
 *
 * Both halves matter and the colon is the whole of the separation, so this
 * refuses anything else rather than guessing — an identifier sent under the
 * wrong scheme reaches nobody, or worse, somebody else.
 */
export function peppolAddress(value: string): PeppolAddress | null {
  const match = /^(\d{4}):(.+)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  return { scheme: match[1], identifier: match[2].trim() };
}
