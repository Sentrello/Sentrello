<!--
  How to report a vulnerability, and what we do with it.

  The marketing site's security page is a component rather than markdown,
  so this is converted from what it renders. The website is the version
  that governs; if the two disagree, this is the stale one.
-->

# Where the data goes, and where it doesn't

The database runs on the customer's own server. Business data stays there. The mechanisms below are described, not asserted — the code implementing them is public.

Never leaves the instance

## Business data stays put

-

Customer records, invoices, ledger entries and everything else entered into the instance
- User logs and system content
- Anything a Free instance holds — a Free instance never has to contact Sentrello at all
The one daily check

## What a paid instance sends

- A licence key and instance id — nothing else
- Runs once a day, only on a paid instance
- A missing or expired result degrades that instance to Free rather than breaking it
Licensing

## Licence checks verify offline

Licences are Ed25519-signed tokens, verified against a public key embedded in the repository.

Verification happens on the instance itself, so it keeps working without reaching the internet. A missing or expired token degrades the instance to Free rather than breaking it.

Access control

## How access to the instance is limited

-

### Sign-up is closed by default

A fresh instance is claimed once by its owner using a setup token from the server’s own .env file. After that, people join by invitation only.

-

### Every query is scoped to an organisation

Organisation scoping is enforced at the data layer, not left to each page to remember to filter by.

-

### Roles limit what each login can see

Admin, Accounting and Staff, plus an external Customer role that only ever sees its own invoices — and custom roles for anything those four do not fit.

-

### Two-factor authentication and a device list

Each account can turn on two-factor authentication and see every device it is currently signed in on.

-

### Public form endpoints are hardened

Contact and quote forms are internet-facing by design, so they enforce an origin allow-list, rate limiting and a honeypot.

Open source

## AGPLv3 and public — read it instead of taking it on faith

The code implementing everything on this page is public under the AGPLv3. Anything stated here can be checked directly rather than trusted.

[View the source on GitHub](https://github.com/Sentrello/Sentrello) Found a problem?

## Report a vulnerability

Email [security@sentrello.com](mailto:security@sentrello.com) with what was found and how to reproduce it. Please don't open a public issue for a vulnerability report.

For how personal and billing data is collected and handled, see the [privacy policy](privacy.md).
