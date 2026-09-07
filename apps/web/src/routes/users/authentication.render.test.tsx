import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Authentication } from "./authentication";

/**
 * The Authentication screen, actually rendered (Ruling 43) — especially its
 * warnings, since a warning that does not appear is the whole failure mode
 * §8 exists to close. `singleAdministratorNoMail` being correct
 * (`authentication.test.ts`) is not enough by itself: this proves the markup
 * around it actually draws the sentence when the condition is true, and
 * stays quiet when it is not.
 */

const policy = {
  requireTwoFactorFor: [],
  minPasswordLength: 8,
  sessionDays: null,
};
const roles = [{ role: "admin", builtIn: true, allows: {} }];

function renderWith(diagnostics: {
  ipHeader: string;
  resolvedIp: string;
  baseUrl: string;
  https: boolean;
  mailConfigured: boolean;
  administrators: number;
}): string {
  const qc = new QueryClient();
  qc.setQueryData(["user-policy"], { policy });
  qc.setQueryData(["user-roles"], { roles });
  qc.setQueryData(["users-diagnostics"], diagnostics);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Authentication />
    </QueryClientProvider>,
  );
}

test("the trusted header and what this request resolved to are always shown", () => {
  const html = renderWith({
    ipHeader: "x-real-ip",
    resolvedIp: "203.0.113.7",
    baseUrl: "https://business.example.com",
    https: true,
    mailConfigured: true,
    administrators: 2,
  });
  expect(html).toContain("x-real-ip");
  expect(html).toContain("203.0.113.7");
});

test("https with mail configured and two administrators: neither warning appears", () => {
  const html = renderWith({
    ipHeader: "x-real-ip",
    resolvedIp: "203.0.113.7",
    baseUrl: "https://business.example.com",
    https: true,
    mailConfigured: true,
    administrators: 2,
  });
  expect(html).not.toContain("is not https");
  expect(html).not.toContain("sentrello reset-password");
});

test("a plain-http base URL gets the Secure-cookie warning", () => {
  const html = renderWith({
    ipHeader: "x-real-ip",
    resolvedIp: "203.0.113.7",
    baseUrl: "http://192.168.1.20:3000",
    https: false,
    mailConfigured: true,
    administrators: 2,
  });
  expect(html).toContain("is not https");
  expect(html).toContain("appear to succeed");
});

test("one administrator with no mail configured gets the host-side way back in, named", () => {
  const html = renderWith({
    ipHeader: "x-real-ip",
    resolvedIp: "203.0.113.7",
    baseUrl: "https://business.example.com",
    https: true,
    mailConfigured: false,
    administrators: 1,
  });
  expect(html).toContain("One administrator");
  expect(html).toContain("sentrello reset-password");
  expect(html).toContain("sentrello unlock");
});

test("one administrator with mail configured gets no lockout warning", () => {
  const html = renderWith({
    ipHeader: "x-real-ip",
    resolvedIp: "203.0.113.7",
    baseUrl: "https://business.example.com",
    https: true,
    mailConfigured: true,
    administrators: 1,
  });
  expect(html).not.toContain("sentrello reset-password");
});
