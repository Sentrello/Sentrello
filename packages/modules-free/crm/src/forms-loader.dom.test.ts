import { GlobalRegistrator } from "@happy-dom/global-registrator";

/*
 * The script tag this test plants carries a real `src`, because the script reads
 * it to learn which instance to talk to. happy-dom tries to fetch it and treats
 * a refusal as fatal, so file loading is told to pass quietly: nothing is meant
 * to load it here, the script under test is evaluated directly.
 */
GlobalRegistrator.register({
  url: "https://a-customer-site.test/contact",
  settings: {
    disableJavaScriptFileLoading: true,
    handleDisabledFileLoadingAsSuccess: true,
  },
});

import { afterAll, afterEach, expect, test } from "bun:test";
import { embedScript } from "./forms-loader";

afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

/**
 * The embed script, actually run.
 *
 * Every other test over this file reads its text, and that is why a bug lived in
 * it: the script built its request body with
 * `Array.prototype.reduce.call(formData.entries(), …)`, which hands back its
 * initial value and iterates nothing, because an iterator has no `length`. So
 * every form without a file on it posted `{}` and the instance answered
 * `400 name or email is required`. Reading the source finds a missing `esc(`.
 * It cannot find an empty object.
 *
 * So this one fills the form in and submits it, in a DOM, against a stubbed
 * instance — and asserts on what reaches the wire. It runs on somebody else's
 * website; what it sends is the whole product.
 */

/** A form definition shaped the way `/api/embed/forms/:key` answers. */
const DEFINITION = {
  key: "frm_test",
  name: "Contact",
  kind: "contact",
  fields: [
    { name: "name", type: "text", label: "Name", required: true },
    { name: "work_email", type: "email", label: "Work Email", required: true },
    { name: "company", type: "text", label: "Company", required: false },
    { name: "message", type: "textarea", label: "Message", required: true },
  ],
  honeypot: "_sentrello_hp",
  redirectUrl: null,
  style: null,
};

interface Sent {
  url: string;
  method: string;
  contentType: string | undefined;
  body: unknown;
}

/**
 * Loads the script the way a customer's page does: a tag with its own src and
 * data attribute, which is where it reads the instance's address from.
 */
async function runEmbed(definition: unknown = DEFINITION): Promise<Sent[]> {
  const sent: Sent[] = [];
  const stub = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(definition), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* left as the string it was */
      }
    } else if (body instanceof FormData) {
      body = Object.fromEntries(body.entries());
    }
    sent.push({ url, method, contentType: headers["content-type"], body });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: globalThis.fetch.preconnect,
  }) as typeof globalThis.fetch;

  const tag = document.createElement("script");
  tag.setAttribute("src", "https://an-instance.test/embed.js");
  tag.setAttribute("data-sentrello-form", "frm_test");
  document.body.append(tag);

  /*
   * `document.currentScript` is what the script reads to find its own tag, and
   * nothing sets it when a string is evaluated. Defined for the length of this
   * call, which is exactly what a browser does while a script runs.
   */
  Object.defineProperty(document, "currentScript", {
    value: tag,
    configurable: true,
  });
  new Function(embedScript())();
  // The definition fetch and the render it triggers.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return sent;
}

test("what it posts is what somebody typed in", async () => {
  const sent = await runEmbed();

  const form = document.querySelector("form");
  expect(form, "the form never rendered").not.toBeNull();

  const typed: Record<string, string> = {
    name: "Someone Real",
    work_email: "someone@a-customer.test",
    company: "A Customer",
    message: "Please get in touch.",
  };
  for (const [field, value] of Object.entries(typed)) {
    const input = form?.querySelector(
      `[name="${field}"]`,
    ) as HTMLInputElement | null;
    expect(input, `no field called ${field}`).not.toBeNull();
    if (input) input.value = value;
  }

  form?.dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  const post = sent.find((s) => s.method === "POST");
  expect(post, "nothing was posted at all").toBeDefined();
  expect(post?.contentType).toBe("application/json");

  /*
   * The assertion the old code failed: every field, with its value. It sent an
   * empty object, which is a request that looks perfectly well formed and
   * carries nothing.
   */
  const body = post?.body as Record<string, string>;
  expect(Object.keys(body).length).toBeGreaterThan(0);
  for (const [field, value] of Object.entries(typed)) {
    expect(body[field], `${field} did not reach the instance`).toBe(value);
  }
});

/**
 * And it goes to the instance the tag names, not to the page's own origin.
 *
 * The script runs on a customer's website, so a relative URL would post their
 * visitor's enquiry to their own server, where nothing is listening.
 */
test("it posts to the instance its own tag came from", async () => {
  const sent = await runEmbed();
  const form = document.querySelector("form");
  const name = form?.querySelector('[name="name"]') as HTMLInputElement | null;
  if (name) name.value = "Someone";
  form?.dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  const post = sent.find((s) => s.method === "POST");
  expect(post?.url).toBe("https://an-instance.test/api/embed/forms/frm_test");
});
