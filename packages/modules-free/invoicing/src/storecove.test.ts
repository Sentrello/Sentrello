import { describe, expect, test } from "bun:test";
import { peppolAddress, storecove } from "./storecove";

/**
 * The access point, answered for.
 *
 * Every one of these is a request to somebody else's service, and there is
 * no sandbox key yet — Storecove had not granted one when this was written.
 * So the network is a function: it asserts what we send and decides what
 * comes back, which is the half of the integration we are responsible for.
 * The live check is one key away and is the only thing left.
 */
const CREDENTIALS = {
  apiKey: "test-key",
  legalEntityId: "12345",
  sandbox: true,
};

function answering(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { http: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { http, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("checking the connection", () => {
  test("asks for the legal entity and hands back its name", async () => {
    const { http, calls } = answering(() => json({ party_name: "Rivet & Co" }));
    const result = await storecove.check(CREDENTIALS, http);

    expect(result.name).toBe("Rivet & Co");
    expect(calls[0]?.url).toBe(
      "https://api.storecove.com/api/v2/legal_entities/12345",
    );
    const sent = calls[0]?.init?.headers as Record<string, string>;
    expect(sent.authorization).toBe("Bearer test-key");
  });

  /**
   * The commonest real failure, and the one whose message has to be useful:
   * a key and an entity id are two long strings from two pages of a
   * dashboard, and pasting a live key into a sandbox connection reads as
   * "unauthorised" with no hint about which half is wrong.
   */
  test("a refused key says which half to look at", async () => {
    const { http } = answering(() => json({ message: "Invalid token" }, 401));
    await expect(storecove.check(CREDENTIALS, http)).rejects.toThrow(
      /refused the key \(401\).*live key if this connection is live.*Invalid token/s,
    );
  });

  test("their words survive, whatever shape the body is", async () => {
    const { http } = answering(
      () => new Response("upstream is down", { status: 502 }),
    );
    await expect(storecove.check(CREDENTIALS, http)).rejects.toThrow(
      /could not read the legal entity \(502\): upstream is down/,
    );
  });

  /**
   * And when they say nothing, the sentence still ends.
   *
   * Storecove's own 401 has an empty body — measured against the live
   * service with a key that was never valid — and "refused the key (401):"
   * with nothing after the colon reads like the message was truncated.
   */
  test("a refusal with no body is still a sentence", async () => {
    const { http } = answering(() => new Response("", { status: 401 }));
    await expect(storecove.check(CREDENTIALS, http)).rejects.toThrow(
      /live key if this connection is live\.$/,
    );
  });
});

describe("looking a receiver up", () => {
  test("a business on the network is reachable", async () => {
    const { http, calls } = answering(() =>
      json({ code: "ok", party_name: "Kolding Byg" }),
    );
    const found = await storecove.lookup(
      { scheme: "0088", identifier: "5790000435951" },
      CREDENTIALS,
      http,
    );
    expect(found).toEqual({ reachable: true, name: "Kolding Byg" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      network: "peppol",
      scheme: "0088",
      identifier: "5790000435951",
    });
  });

  // Not an error: it is the answer. The invoice goes by email instead.
  test("a business that is not on it is simply not", async () => {
    const { http } = answering(() => json({ code: "not_found" }));
    const found = await storecove.lookup(
      { scheme: "0208", identifier: "0123456789" },
      CREDENTIALS,
      http,
    );
    expect(found.reachable).toBe(false);
  });
});

describe("sending", () => {
  test("the document that goes is the one we validated", async () => {
    const ubl = '<?xml version="1.0"?><Invoice>…</Invoice>';
    const { http, calls } = answering(() => json({ guid: "sub-9" }));

    const sent = await storecove.send(
      { ubl, to: { scheme: "0088", identifier: "5790000435951" } },
      CREDENTIALS,
      http,
    );

    expect(sent.reference).toBe("sub-9");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.legalEntityId).toBe("12345");
    expect(body.routing.eIdentifiers).toEqual([
      { scheme: "0088", id: "5790000435951" },
    ]);
    /*
     * Handed over whole, rather than described again as JSON for them to
     * assemble. Two descriptions of one invoice is two things to be wrong,
     * and ours is the one that passed EN 16931.
     */
    expect(
      Buffer.from(body.document.rawDocumentData.document, "base64").toString(
        "utf8",
      ),
    ).toBe(ubl);
    expect(body.document.rawDocumentData.parse).toBe(false);
  });

  test("accepted with no reference is not accepted", async () => {
    const { http } = answering(() => json({}));
    await expect(
      storecove.send(
        { ubl: "<Invoice/>", to: { scheme: "0088", identifier: "1" } },
        CREDENTIALS,
        http,
      ),
    ).rejects.toThrow(/nothing to follow up with/);
  });

  test("a rejection names the rule it broke", async () => {
    const { http } = answering(() =>
      json({ errors: { document: ["BR-CO-10: sum of line amounts"] } }, 422),
    );
    await expect(
      storecove.send(
        { ubl: "<Invoice/>", to: { scheme: "0088", identifier: "1" } },
        CREDENTIALS,
        http,
      ),
    ).rejects.toThrow(/BR-CO-10/);
  });
});

describe("an address is a scheme and an identifier", () => {
  test("both halves, or nothing", () => {
    expect(peppolAddress("0088:5790000435951")).toEqual({
      scheme: "0088",
      identifier: "5790000435951",
    });
    expect(peppolAddress("  0208:0123456789  ")).toEqual({
      scheme: "0208",
      identifier: "0123456789",
    });
    // The digits alone are meaningless: the same number is a different
    // company under another scheme, so a missing scheme is refused rather
    // than guessed at.
    expect(peppolAddress("5790000435951")).toBeNull();
    expect(peppolAddress("GLN:5790000435951")).toBeNull();
    expect(peppolAddress("0088:")).toBeNull();
  });
});
