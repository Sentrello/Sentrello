import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Policies } from "./policy-ui";

/**
 * The one branch this task added to a table `users.tsx` already had: `onOpen`,
 * which turns a policy's name into a link to its own record.
 *
 * It is the part worth watching. `users.tsx`'s own guard hides the Edit
 * button for a built-in policy (Admin, Customer) — unchanged by this task —
 * so until `onOpen` existed there was no way at all to open Admin's record
 * and see who holds it. Ruling 43: rendered, not only reasoned about.
 *
 * Unlike `access-matrix.render.test.tsx`'s subject, `Policies` fetches its
 * own rows with `useQuery` rather than taking them as a prop, so this seeds
 * the cache with `QueryClient.setQueryData` ahead of the render instead of a
 * network call happening — the standard way to render a `useQuery` consumer
 * without a live server behind it.
 */

const rows = [
  {
    role: "admin",
    builtIn: true,
    kind: "user" as const,
    allows: { settings: ["update"] },
  },
  {
    role: "staff",
    builtIn: false,
    kind: "user" as const,
    allows: { crm: ["read"] },
  },
];

function renderTable(onOpen?: (role: string) => void): string {
  const qc = new QueryClient();
  qc.setQueryData(["users-policies"], { roles: rows });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Policies
        title="User policies"
        blurb=""
        kind="user"
        onOpen={onOpen}
        onCopy={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("with onOpen, every policy's name is a link — including the built-in one", () => {
  const html = renderTable(() => {});
  expect(
    (html.match(/<button type="button" class="link">/g) ?? []).length,
  ).toBe(2);
  expect(html).toContain('<button type="button" class="link">Admin</button>');
  expect(html).toContain('<button type="button" class="link">Staff</button>');
});

test("without onOpen, the name stays plain text — the old inline-edit page is unaffected", () => {
  const html = renderTable(undefined);
  expect(html).not.toContain('class="link">Admin');
  expect(html).toContain("Admin");
  expect(html).toContain("Staff");
});
