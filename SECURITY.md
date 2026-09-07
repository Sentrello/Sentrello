# Security

Sentrello holds a business's customer list, its invoices and its books, on a
server that business owns. Getting this wrong costs somebody their company, not
their weekend. Reports are read by a person, quickly, and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.**

Email **security@sentrello.com** with what you found and how to reproduce it. A
proof of concept, a curl command, or a failing test all help; so does telling us
what you think the impact is, even roughly.

You can expect:

| | |
|---|---|
| First reply | Within 3 working days |
| Assessment and severity | Within 7 days of the first reply |
| Fix released | As fast as severity warrants — a remote hole in a released version is a same-week patch |
| Credit | Named in the release notes, if you want to be |

If you don't hear back within a week, please chase — a report that fell into a
spam folder is our failure, not yours.

## Scope

**In scope** — this repository, the published container image
(`ghcr.io/sentrello/core`), the installer at `https://get.sentrello.com`, and
`sentrello.com`.

Findings we particularly want:

- Anything that reads or writes another organisation's data. Every business
  table is `organizationId`-scoped and that boundary is the one that must never
  leak.
- Authentication and session handling — sign-in, invitations, the first-run
  claim, password reset, two-factor, session revocation.
- Licence verification. Tokens are Ed25519-signed and verified offline; a way
  to forge one, or to make verification crash rather than fall back to Free, is
  a real finding.
- The public form endpoints. They are internet-facing by design and carry an
  origin allow-list, rate limiting and a honeypot.
- Anything that lets a lower-privileged role act as a higher one, or reach a
  route its permissions do not cover.

**Out of scope** — findings against a third party we merely integrate with;
reports produced by a scanner with no demonstrated impact; missing headers or
weak TLS on somebody's own self-hosted instance, which is theirs to configure;
social engineering; and denial of service by simply sending a great deal of
traffic.

Please don't test against an instance you don't own. If you need a target, the
installer will give you your own in a few minutes.

## What the design already assumes

Worth knowing if you are reading the code rather than probing a server:

- **Sign-up is closed by default.** A fresh instance is claimed once by its
  owner using a setup token written into the server's own environment; after
  that, people join by invitation. Open registration is opt-in.
- **Every business query is scoped by organisation at the data layer**, not by
  the route remembering to. Platform-wide tests assert this rather than
  trusting it.
- **Paid features are gated twice.** The loader refuses to register a module
  the licence doesn't cover, and each route checks permissions independently.
  Neither gate is allowed to be the only one.
- **Licence verification fails safe.** A missing, expired or malformed token
  downgrades the instance to Free. It never crashes the application and never
  grants more than the token says.
- **Money is integer cents and the ledger is double-entry.** Every financial
  event posts a balanced journal entry or throws. A bug that lets an unbalanced
  entry through is a security bug in our book, not a rounding complaint.
- **Signature comparison is constant-time**, everywhere it happens.
- **An instance phones home very little.** A paid instance sends one daily
  licence check — a key and an instance id. A Free instance need never contact
  us at all. Customer records never leave the server.

## Supported versions

Sentrello is in early access and moves quickly. Security fixes land on the
**latest release**, and `sentrello update` is the supported way to take them.
There is no long-term-support branch yet; when there is, it will be described
here.

## Hardening your own instance

[Running it yourself](docs/self-hosting.md) covers TLS, backups, updates and
what an instance does and does not send anywhere. Two things are worth doing on
day one whatever else you skip: put a reverse proxy with a real certificate in
front of it, and check that your backups restore.
