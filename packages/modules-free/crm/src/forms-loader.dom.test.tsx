import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://example.test/" });

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { embedScript } from "./forms-loader";

afterAll(() => GlobalRegistrator.unregister());

/**
 * The embed script, run rather than read.
 *
 * Every other test of this file inspects the script as a string, which proves
 * the source says something and not that a browser does it. This one puts the
 * script through a DOM with a stubbed answer from the instance, then clicks
 * the thing a visitor clicks. It is the only test that would have failed on
 * the dropdown that submitted whitespace-collapsed text.
 */
const FORM = {
  key: "frm_test",
  name: "Contact",
  kind: "enquiry",
  honeypot: "_sentrello_hp",
  redirectUrl: null,
  style: null,
  fields: [
    {
      name: "why",
      label: "What brings you here?",
      type: "radio",
      required: true,
      options: ["Talk to us", "Get support"],
      info: {
        "Get support": {
          title: "Also consider",
          body: "Setup, the API, and what to try first.",
          href: "https://docs.sentrello.com/",
          hrefLabel: "Docs",
        },
        "Talk to us": { href: "javascript:alert(1)", hrefLabel: "Nope" },
      },
    },
    {
      name: "where",
      label: "Where did you hear about us?",
      type: "select",
      options: ["A search engine", "Somebody told me"],
    },
  ],
};

async function run(form: unknown = FORM) {
  document.body.innerHTML = "";
  // A stand-in rather than a real <script>: attaching one with a src makes
  // the DOM try to go and fetch it, and the script only ever reads the tag's
  // src, its attribute, and where it sits.
  const tag = document.createElement("div") as HTMLDivElement & { src: string };
  tag.src = "https://bmp.sentrello.com/embed.js";
  tag.setAttribute("data-sentrello-form", "frm_test");
  document.body.appendChild(tag);
  // The script reads document.currentScript to find its own tag, which only
  // a real parser sets. Standing one in is the whole of the harness.
  Object.defineProperty(document, "currentScript", {
    value: tag,
    configurable: true,
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(form), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  new Function(embedScript())();
  // Two turns: one for the response, one for the body.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

test("every choice is drawn, multiple words and all", async () => {
  await run();
  const radios = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ];
  expect(radios.map((r) => r.value)).toEqual(["Talk to us", "Get support"]);
  expect(radios.some((r) => r.checked)).toBe(false);
});

/**
 * An <option> with no value submits its text content with whitespace
 * collapsed, so a multi-word choice arrived as a string the form never
 * offered. The value is written out now; this is what proves it.
 */
test("a dropdown submits the choice it was given, word for word", async () => {
  await run();
  const options = [
    ...document.querySelectorAll<HTMLOptionElement>("select option"),
  ];
  expect(options.map((o) => o.value)).toEqual([
    "",
    "A search engine",
    "Somebody told me",
  ]);
});

test("choosing an answer opens its panel, and only its panel", async () => {
  await run();
  const panels = [...document.querySelectorAll<HTMLElement>(".sentrello-info")];
  expect(panels.every((p) => p.hidden)).toBe(true);

  const support = document.querySelector<HTMLInputElement>(
    'input[value="Get support"]',
  );
  if (!support) throw new Error("the support option was not drawn");
  support.checked = true;
  support.dispatchEvent(new Event("change", { bubbles: true }));

  const open = panels.filter((p) => !p.hidden);
  expect(open).toHaveLength(1);
  expect(open[0]?.getAttribute("data-for")).toBe("Get support");
  expect(open[0]?.textContent).toContain("Also consider");
  expect(open[0]?.querySelector("a")?.getAttribute("href")).toBe(
    "https://docs.sentrello.com/",
  );
});

/**
 * The link is typed by the business, but it renders on somebody else's site,
 * so a "javascript:" href would be their incident to explain.
 */
test("a link that is not http is not drawn at all", async () => {
  await run();
  const talk = document.querySelector<HTMLElement>(
    '.sentrello-info[data-for="Talk to us"]',
  );
  expect(talk?.querySelector("a")).toBeNull();
});

/** A choice field with no panels should add no region to the page. */
test("plain radios stay plain", async () => {
  await run({
    ...FORM,
    fields: [{ ...FORM.fields[0], info: undefined }],
  });
  expect(document.querySelector(".sentrello-infos")).toBeNull();
  expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);
});

/**
 * One form, four pages.
 *
 * The careers pages each embed the same application form and tell it which
 * role the visitor is reading. Without this every role needs its own form,
 * and the fourth one is the one nobody remembers to update.
 */
test("an answer the page already knows is filled in and locked", async () => {
  document.body.innerHTML = "";
  const tag = document.createElement("div") as HTMLDivElement & { src: string };
  tag.src = "https://bmp.sentrello.com/embed.js";
  tag.setAttribute("data-sentrello-form", "frm_test");
  tag.setAttribute("data-sentrello-role", "Account Executive");
  tag.setAttribute("data-sentrello-where", "Somebody told me");
  document.body.appendChild(tag);
  Object.defineProperty(document, "currentScript", {
    value: tag,
    configurable: true,
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ...FORM,
        fields: [
          { name: "role", label: "Role", type: "text", required: true },
          FORM.fields[1],
        ],
      }),
      { headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  new Function(embedScript())();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const role = document.querySelector<HTMLInputElement>('input[name="role"]');
  expect(role?.value).toBe("Account Executive");
  expect(role?.readOnly).toBe(true);

  // A dropdown told its answer opens on it, with no blank option to fall back
  // through — the page has already answered the question.
  const where = document.querySelector<HTMLSelectElement>(
    'select[name="where"]',
  );
  expect(where?.value).toBe("Somebody told me");
  expect(where?.querySelector('option[value=""]')).toBeNull();
});

/** The key is not an answer, and a field called "form" must not eat it. */
test("the form's own attribute is never treated as a prefill", async () => {
  expect(embedScript()).toContain('if (!name || name === "form") return null;');
});
