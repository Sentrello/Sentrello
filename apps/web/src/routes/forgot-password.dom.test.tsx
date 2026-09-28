import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Captured before happy-dom touches anything: happy-dom's `register()` below
// replaces `globalThis.fetch` with its own implementation, and this is the
// one call in the file that needs the real thing underneath it, to actually
// reach the network for whatever this file itself does not care about.
const nativeFetch = globalThis.fetch;

// A real origin, not the default `about:blank`: `pushState` below moves
// between `/reset-password` and its variants, and happy-dom refuses a
// history entry whose URL does not share the document's own origin.
GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * `authClient.resetPassword`/`requestPasswordReset` are replaced module-wide,
 * before the component under test is ever imported: each is set per test to a
 * stand-in that resolves the way the real endpoint would for the case under
 * test, so nothing here makes a real network call. Monkey-patching
 * `globalThis.fetch` cannot reach these — better-auth's client captures
 * `fetch` into its own config once, at import time, well before a test gets
 * a chance to swap it.
 *
 * `bun test` has no per-file module registry by default (that needs
 * `--isolate`, which this suite does not run with) — `mock.module` here
 * replaces "../lib/auth" for every file that imports it for the rest of the
 * run, not only this one. Spreading the real module's exports underneath the
 * two stand-ins is what keeps that survivable: any other screen's `useSession`,
 * `signIn`, `roleApi` and so on stay the genuine ones: only the two methods
 * this file actually exercises are swapped.
 */
const real = await import("../lib/auth");

let resetPasswordImpl: (args: {
  token: string;
  newPassword: string;
}) => Promise<{ error?: { message?: string; status?: number } }> = () => {
  throw new Error("resetPassword not stubbed for this test");
};
let requestResetImpl: (args: {
  email: string;
}) => Promise<{ error?: { message?: string; status?: number } }> = () => {
  throw new Error("requestPasswordReset not stubbed for this test");
};

mock.module("../lib/auth", () => ({
  ...real,
  authClient: {
    ...real.authClient,
    resetPassword: (args: { token: string; newPassword: string }) =>
      resetPasswordImpl(args),
    requestPasswordReset: (args: { email: string }) => requestResetImpl(args),
  },
}));

const { ForgotPassword, ResetPassword } = await import("./forgot-password");

// The one cleanup this file needs: `unregister()` restores every global
// happy-dom touched — `fetch` included — to the exact descriptor it captured
// at `register()` time, unconditionally. A second, separate restore for
// `fetch` here would race it: whichever `afterAll` runs last wins, and if it
// were this file's own restore, it would leak happy-dom's `fetch` into every
// test that runs after this file for the rest of the process.
afterAll(() => GlobalRegistrator.unregister());

// `ForgotPassword` asks `/api/_signin` directly (not through `authClient`) to
// learn whether this instance can mail a link at all. There is no server
// here to answer, so a plain, always-mail-configured stand-in takes its
// place — the no-mail screen has nothing to do with the recovery paths these
// tests are about.
//
// Everything else falls through to the real `fetch` — captured above, before
// happy-dom replaced it — never throws. `bun test` does not wall this file
// off from the rest of the suite in time: a test elsewhere that is mid
// network call while this file's module scope is evaluating would have had
// that call caught and killed by a stricter stand-in here, for a request this
// file never made and has no business judging.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("/api/_signin")) {
    return new Response(JSON.stringify({ mailConfigured: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return nativeFetch(input, init);
}) as typeof fetch;

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode): HTMLElement {
  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  act(() => {
    createRoot(mountPoint).render(node);
  });
  return mountPoint;
}

function setUrl(path: string) {
  window.history.pushState({}, "", `http://localhost${path}`);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function submitForm(host: HTMLElement) {
  const form = host.querySelector("form");
  if (!form) throw new Error("no form to submit");
  act(() => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * A dead link — expired or already used — used to leave the customer with an
 * error and no way forward. The server-refused case now offers the same
 * "get a new one" recovery the missing-token case does below, which is the
 * same form the sign-in screen's "forgot your password" link shows.
 */
test("a link the server refuses offers a way to get a new one", async () => {
  setUrl("/reset-password?token=stale-token");
  resetPasswordImpl = async () => ({
    error: { status: 400, message: "Invalid or expired reset password token." },
  });

  const host = mount(<ResetPassword />);
  const password = host.querySelector(
    "input[type=password]",
  ) as HTMLInputElement;
  type(password, "a-perfectly-fine-password");
  submitForm(host);
  await flush();

  expect(host.textContent).toContain(
    "Invalid or expired reset password token.",
  );
  const retry = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Get a new link",
  );
  expect(retry).toBeDefined();

  act(() => retry?.click());
  await flush();
  expect(host.querySelector("h1")?.textContent).toBe("Reset your password");
});

/** A link with no token at all gets the same recovery, not a dead form. */
test("a link missing its token also offers a way to get a new one", async () => {
  setUrl("/reset-password");
  const host = mount(<ResetPassword />);

  expect(host.textContent).toContain("This link is missing its token");
  const retry = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Get a new link",
  );
  expect(retry).toBeDefined();

  act(() => retry?.click());
  await flush();
  expect(host.querySelector("h1")?.textContent).toBe("Reset your password");
});

/**
 * The success screen no longer just points at a bare "/" and hopes: the copy
 * says where signing in leads either way, since this screen has no session
 * and genuinely cannot tell a billing-only account from an ordinary one —
 * that call belongs to the shell, once there is a session to ask.
 */
test("a successful reset explains where signing in leads, and the link stays safe for both kinds of account", async () => {
  setUrl("/reset-password?token=good-token");
  resetPasswordImpl = async () => ({});

  const host = mount(<ResetPassword />);
  const password = host.querySelector(
    "input[type=password]",
  ) as HTMLInputElement;
  type(password, "a-perfectly-fine-password");
  submitForm(host);
  await flush();

  expect(host.textContent).toContain("Done.");
  const signIn = host.querySelector("a") as HTMLAnchorElement;
  expect(signIn.getAttribute("href")).toBe("/");
});

/** The new password field matches the server's actual 12-character floor. */
test("the password field asks for what the server will accept", () => {
  setUrl("/reset-password?token=good-token");
  const host = mount(<ResetPassword />);
  const password = host.querySelector(
    "input[type=password]",
  ) as HTMLInputElement;
  expect(password.minLength).toBe(12);
});

/**
 * Whether or not an address has an account here is not this screen's to
 * reveal. A 404 — no such account — and a success both end on the same
 * "a link is on its way" message, so watching the response would tell a
 * visitor nothing an account holder's inbox would not.
 */
test("asking for a reset link says the same thing whether or not the address has an account", async () => {
  requestResetImpl = async () => ({ error: { status: 404 } });

  const host = mount(<ForgotPassword onBack={() => {}} />);
  await flush();

  const email = host.querySelector("input[type=email]") as HTMLInputElement;
  type(email, "nobody@example.com");
  submitForm(host);
  await flush();

  expect(host.textContent).toContain("a link is on its way");
  expect(host.textContent).not.toMatch(/no account|not found|no such/i);
});
