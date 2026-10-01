<!--
  What leaves a Sentrello instance, what never does, how access is controlled,
  and how to report a vulnerability.

  The marketing site's security page is a component rather than markdown, so
  this is converted from what it renders. The website is the version that
  governs; if the two disagree, this is the stale one.

  Converted by hand on 1 October 2026, because the previous conversion had
  flattened every section label onto the end of the section above it, left six
  bare list markers behind, and dropped three sections — including the one
  exception to "nothing leaves your server", which is the section a prospect's
  lawyer reads first.
-->

# Where the data goes, and where it doesn't

The database runs on the customer's own server. Business data stays there. The
mechanisms below are described, not asserted — the code implementing them is
public.

## Business data stays put

Never leaves the instance:

- Customer records, invoices, ledger entries — everything anybody types into the instance
- User logs and system content
- Everything a free instance holds, which never has to phone home in the first place

## SEO Cloud, if you choose it

The one exception, and it is stated here rather than footnoted:

- Only if SEO Cloud is chosen instead of a provider account of your own
- What is sent is the domains and keywords being researched, under the license key
- Every other module runs entirely on the instance, with nothing leaving it

## What a paid instance sends

The hourly check:

- A license key and instance id, nothing else
- Runs once an hour, only on a paid instance
- A missing or expired result degrades that instance to Free rather than breaking it

## License checks verify offline

**Signed.** A license is an Ed25519-signed token, issued once when the
subscription starts.

**Verified offline.** Against a public key embedded in the repository, the
instance verifies the signature itself. No internet is involved in that, and a
verified license stays valid for 72 hours. So when sentrello.com goes down,
instances carry on; they were never calling it in order to work.

**Fails soft.** A missing or expired token degrades the instance to Free.
Nothing locks. No data is held hostage.

## How access to the instance is limited

**Sign-up is shut by default.** A fresh instance is claimed once, by whoever
holds the setup token in the server's own `.env` file. After that, the only way
in is an invitation.

**Every business query is scoped to one organization,** and a test suite fails
the build if a query is written without that filter. Being honest about the
mechanism: it is a rule the code is held to, not a wall in the database. There
is no row-level security behind it — what there is, is a guard that reads every
module's queries and refuses the build when one is missing its filter.

**Roles limit what each login can see.** Nine ship ready to use — Admin,
Executive, Manager, Staff, Sales, Marketing, Accounting, Customer Service and
Customer — and you can make your own for anything they do not fit, a permission
at a time, on a screen rather than in a file.

**Your customers get a link, not an account.** An invoice, a quote, a booking:
each reaches the person it is for through a link that opens that one document.
No password to forget, and nothing else behind it — because a login that is
supposed to show somebody only their own rows is a rule that has to hold on
every query written afterwards.

**Two-factor authentication and a device list.** Turn it on per account. Each
one can also see every device it is signed in on right now, and end any of
those sessions.

**Public form endpoints are hardened.** Contact and quote forms face the open
internet by design. So they enforce an origin allow-list, rate limiting and a
honeypot.

## Sentrello's own machines

Everything in this section is about sentrello.com and the license server — two
hosts. The customer's instance is the sections above, and the two are not the
same thing.

**TLS 1.2+, certificates that renew themselves.** Sentrello's hosts accept TLS
1.2 and 1.3 and nothing older; the operating system's crypto policy refuses the
rest, which was confirmed by trying to negotiate them rather than by reading a
config file and believing it. Certificates renew themselves, and the renewal
has been proved end to end.

**Control-plane backups, encrypted before they leave.** Sentrello holds one
database, the license database. It is dumped nightly, encrypted with AES-256
before it leaves the machine, and kept off-site for 30 days; a restore from the
encrypted file has been rehearsed rather than assumed. A failed backup raises an
alert. So does silence.

**Passwords hashed with scrypt.** Passwords on Sentrello's own services are
hashed with scrypt, by the auth library rather than by anything written here.
The commonest way a small vendor leaks credentials is rolling its own.

**Benchmarked against CIS Level 1.** Both servers are audited with OpenSCAP
against the CIS Level 1 Server benchmark. Every finding is either fixed or
declined in writing with the reason attached: IP forwarding stays on because
Docker needs it; there is no GRUB password because it would block the recovery
console. Hardened and scored are not the same thing.

There is no uptime percentage on this page, because the monitoring behind one
would be days old and the figure invented. The 72-hour offline license is the
real answer to "what happens when your site goes down".

## The tools to meet the framework — never the badge

Compliance is a property of a business, not of software: a regulator audits an
organization, its policies, its training and how it behaves, and no product
grants any of it. What Sentrello supplies is the controls, running on the
customer's own server, which is where an assessor expects to find them. The
site's [security page](https://sentrello.com/security/#compliance) lists them.

## AGPLv3 and public — read it instead of taking it on faith

The code implementing everything on this page is public under the AGPLv3.
Anything stated here can be checked directly rather than trusted.

[View the source on GitHub](https://github.com/Sentrello/Sentrello)

## Report a vulnerability

Two private routes, either is fine: open a
[draft security advisory](https://github.com/Sentrello/Sentrello/security/advisories/new)
on this repository, or email
[security@sentrello.com](mailto:security@sentrello.com) with what was found and
how to reproduce it. [SECURITY.md](../SECURITY.md) sets out what happens next
and how quickly.

Please don't open a public issue for a vulnerability — a public report is a
public exploit for everyone who has not updated yet.

For how personal and billing data is collected and handled, see the
[privacy policy](privacy.md).
