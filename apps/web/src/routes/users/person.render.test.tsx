import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationProvider } from "../../lib/navigation";
import { PersonDetail } from "./person";

/**
 * The person record, rendered rather than only reasoned about (Ruling 43).
 *
 * `person.test.ts` covers `tabFromSearch` — the extracted decision, Ruling
 * 39's half — and nothing covered the markup, on the screen with the most
 * states worth getting wrong: a suspended account, a locked one, and the
 * self-suspension guard. The branch's finishing review proved the gap by
 * inverting the enabled/disabled label and watching the whole suite stay
 * green. These are what fail now when it does.
 */

const base = {
  memberId: "m1",
  userId: "u1",
  name: "Dana Reyes",
  email: "dana@local.test",
  role: "staff",
  baseRole: "staff",
  groups: [] as string[],
  twoFactorEnabled: false,
  twoFactorRequired: false,
  lastSeenAt: null,
  you: false,
  disabledAt: null as string | null,
  emailVerified: true,
  joinedAt: "2026-08-22T00:00:00.000Z",
  locked: false,
  lockedUntil: null as string | null,
  failedAttempts: 0,
};

/**
 * `renderToStaticMarkup` needs no DOM, but `NavigationProvider` reads
 * `window.location` for the view it starts on and `person.tsx` reads
 * `window.location.search` for its tab. Neither runs an effect during a
 * server render, so this is the whole surface: two strings. Stubbed here
 * rather than pulling in jsdom for them.
 */
function withLocation(search: string) {
  (globalThis as { window?: unknown }).window = {
    location: { pathname: "/users/u1", search },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
}

function render(person: Record<string, unknown>, search = ""): string {
  withLocation(search);
  const qc = new QueryClient();
  qc.setQueryData(["person", "u1"], { person });
  qc.setQueryData(["users-policies"], {
    roles: [
      { role: "admins", kind: "user" },
      { role: "staff", kind: "user" },
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <NavigationProvider
        initial={{ moduleId: "users", recordId: "u1", title: "Dana Reyes" }}
      >
        <PersonDetail />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

test("an enabled account says so, and offers the way to suspend it", () => {
  const html = render(base);
  expect(html).toContain("Enabled");
  expect(html).toContain("Disable");
  expect(html).not.toContain("Disabled ");
});

test("a suspended account does not render as enabled", () => {
  // The inversion the finishing review proved nothing caught: an account
  // somebody has suspended showing as "Enabled" is the screen telling an
  // administrator the opposite of the truth about access they removed.
  const html = render({ ...base, disabledAt: "2026-08-30T00:00:00.000Z" });
  expect(html).toContain("Disabled");
  // The button offers the way back, and is the primary action rather than the
  // danger one it is on an account that is still active.
  expect(html).toContain(">Enable<");
  expect(html).not.toContain(">Disable<");
});

test("you cannot suspend yourself, and the screen says why instead of offering it", () => {
  const html = render({ ...base, you: true });
  expect(html).toContain("cannot disable your own account");
  expect(html).not.toContain(">Disable<");
});

test("a locked account says how many attempts and when it lifts", () => {
  // Only rendered when there is something to say — an account nobody has
  // failed to sign into does not need a card telling it so.
  const html = render(
    {
      ...base,
      locked: true,
      failedAttempts: 5,
      lockedUntil: "2026-09-02T21:00:10.000Z",
    },
    "?tab=credentials",
  );
  expect(html).toContain("Locked");
  expect(html).toContain("5 failed attempts");
  expect(html).toContain("Unlock");
});

test("an account nobody has failed to sign into shows no lock card at all", () => {
  const html = render(base, "?tab=credentials");
  expect(html).not.toContain("Unlock");
  expect(html).not.toContain("failed attempts");
});

/**
 * What this person may do, on the tab an administrator opens first.
 *
 * Details showed a name, an email, when they joined and when they last signed
 * in. Somebody opening a person to answer "what can they do" got none of it,
 * and had to go back to the list to change it — which is the one screen this
 * record exists to save them from.
 */
test("the details tab names their policy and offers to change it", () => {
  const html = render({ ...base, baseRole: "staff", role: "staff" });

  expect(html).toContain("Policy");
  expect(html).toContain("Staff");
  // Changeable from here, not only from the list.
  expect(html).toContain("<select");
  expect(html).toContain('value="staff"');
});

test("the details tab names their groups, and what those add", () => {
  const html = render({
    ...base,
    baseRole: "staff",
    role: "staff,sales",
    groups: ["Sales"],
  });

  expect(html).toContain("Groups");
  expect(html).toContain("Sales");
  expect(html).toContain("and through them");
});

/** Your own policy is stated, never offered — the last administrator out. */
test("you cannot change your own policy from your own record", () => {
  const html = render({ ...base, you: true, baseRole: "admins" });

  expect(html).toContain("Admins");
  expect(html).not.toContain("<select");
});
