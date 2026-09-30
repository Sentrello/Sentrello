<!--
  Privacy Policy.

  Copied from the marketing site's own source — src/pages/legal/privacy.md — which
  is what sentrello.com serves and what governs. Kept here so the repository
  carries it too: an AGPL project whose license talk lives only on a marketing
  site is asking to be taken at its word.

  If the two ever disagree, the website is right and this is stale.
-->

# Privacy Policy

**Effective Date: October 1, 2026**

Sentrello LLC ("Sentrello", "we", "us") is the controller of the personal data
described below. We are a limited liability company registered in Colorado,
United States.

Privacy requests: **privacy@sentrello.com**
Everything else: **support@sentrello.com**

This policy covers `sentrello.com`, the account area, the license server, and
the email we send you. It applies to the personal data of the people who buy,
evaluate and support Sentrello — not to the data inside your own instance.

---

## 1. The part most policies do not have to say

Sentrello runs on infrastructure you control. Your contacts, invoices, payroll,
documents, bookings and ledger are written to your database, on your server,
and **none of it is transmitted to us**. We cannot read it, we do not hold a
copy, and no support request gives us access to it.

For the data inside your instance, **you are the controller and we are not a
processor**. There is no data processing agreement to sign with us for it,
because there is no processing by us to agree about. Where you connect your
instance to a third party — a payment provider, a mail server, a search-data
provider — that relationship is between you and them.

Two deliberate exceptions, both of which you switch on yourself:

- **Sentrello SEO Cloud**, if you use it. Keyword and domain lookups you ask
  for are sent to our service and on to our data provider. See section 4.
- **Usage reporting**, if you opt in at install time. See section 3.

---

## 2. What we collect, and why

### A. Your account and your purchase

Collected when you buy a subscription or create an account on `sentrello.com`.

| Data | Why | Lawful basis (EU/UK) |
|---|---|---|
| Name, email address | To create the account, send the license key, and reach you about it | Performance of a contract |
| Billing address, country, tax identifiers | To charge the right tax and issue a compliant invoice | Legal obligation |
| Payment card details | Taken and stored by Stripe. We receive the last four digits, the brand and the expiry, never the full number | Performance of a contract |
| Subscription and invoice history | To run the subscription, and to keep our own books | Legal obligation |
| Support correspondence | To answer you, and to find the same fault for the next person | Legitimate interests |

### B. Visiting the website

Every request to `sentrello.com` is logged by our infrastructure with an IP
address, a timestamp, the page requested and a user-agent string. That is how a
web server works, and it is how we investigate abuse. Those logs are kept for
30 days.

Analytics is separate and is not always on. See section 5.

### C. Your instance checking its license

An instance running Pro or a paid module asks our license server for a fresh
token **once an hour**. Each request carries:

- the license key,
- the instance identifier generated at install,
- on first registration, a hardware fingerprint and the processor
  architecture.

That is the whole request. It carries no business data, no user names, no
record counts and no file contents. We keep a record of the tokens issued —
which license, which instance, which tier, when — for **90 days**, because
"what does that instance think it has" is the first question of every license
support conversation.

A Free instance with no license key makes no license request at all.

### D. Usage reporting, if you opt in

The installer asks once, and the answer is **no** unless you change it.
Switching it on sends us, once a day: the version you run, whether it is Free
or Pro, which modules are installed, and how many people use it **as a band**
("2–5", "6–10") rather than a number. Nothing else — no customer data, no
names, nothing about what any of it contains. You can turn it off again in
Settings at any time.

---

## 3. Who processes what

We use seven providers. Your own instance's data reaches none of them unless
you connect them yourself.

| Provider | What it does for us | Where |
|---|---|---|
| DigitalOcean | Hosting for `sentrello.com`, the license server, and their backups | United States |
| Stripe | Payments, subscriptions, invoices, tax calculation | United States, Ireland |
| Resend | Transactional email — license keys, receipts, password resets | United States |
| Cloudflare | DNS, proxy and edge protection for our domains | Global network |
| Google | Tag Manager and Analytics on `sentrello.com` only, with consent where consent is required | United States |
| GitHub | Public source code, release artifacts, issue and pull-request discussion | United States |
| DataForSEO | Search and domain data, for Sentrello SEO Cloud customers only | United States |

Each is engaged under terms that restrict them to processing on our
instruction. We do not sell personal data, and we do not share it for
cross-context behavioral advertising.

---

## 4. Sentrello SEO Cloud

SEO Cloud is the one part of the product where a request leaves your instance
carrying something you typed. When you ask for a keyword, a ranking or a domain
overview, that query is sent to our service, which asks our data provider and
returns the answer.

We keep a metered record of each lookup — which license, which operation, when,
and what it cost — because that is how the allowance is counted and billed. The
keyword itself is stored with that record so a repeat question can be answered
from cache instead of being bought twice. No contact, customer or financial data
from your instance is involved.

---

## 5. Cookies and analytics

`sentrello.com` sets a session cookie when you sign in to the account area, and
a small cookie recording your choice of light or dark theme. Neither is optional
and neither is used for advertising.

Analytics is different. We load Google Tag Manager, which loads Google
Analytics, to see which pages help somebody decide and which do not.

- **If you are in the EU, the UK or California**, nothing analytical loads until
  you accept it. Decline, and no analytics or advertising cookie is set.
- **Everywhere else**, analytics loads on arrival, and you can decline it at any
  time from the banner or by using your browser's Global Privacy Control
  signal, which we honor.

Analytics runs on the public website only. It is not in the product, not on the
staging site, and not on your instance.

---

## 6. How long we keep things

| What | How long |
|---|---|
| Account and subscription records | While the account exists, and for as long after as tax and accounting law requires |
| Invoices and payment records | Seven years, as United States tax law requires |
| License token records | 90 days |
| Payment webhook payloads | Emptied after 30 days; the record that it happened is kept for two years |
| Web server logs | 30 days |
| Support correspondence | Two years from the last message |
| Usage reports (if opted in) | 13 months |

---

## 7. Your rights

Wherever you live, you can ask us to show you what we hold about you, correct
it, delete it, or send it to you in a portable file. Write to
**privacy@sentrello.com** and we will answer within 30 days.

If you are in the EU or UK, [the GDPR page](/legal/gdpr/) sets out your rights
and our lawful bases in full. If you are in California, [the CCPA
page](/legal/ccpa/) does the same for yours.

Two limits worth stating plainly. We cannot delete an invoice we are required
to keep for tax, and we cannot delete data inside your own instance — that
one is in your hands, and the product has a Privacy screen that does it.

---

## 8. Children

Sentrello is sold to businesses. We do not knowingly collect personal data from
anybody under 16. If you believe we have, write to privacy@sentrello.com and we
will delete it.

---

## 9. Security

The account area and the license server run on hardened, patched Linux hosts
behind Cloudflare. Credentials are hashed, secrets are encrypted at rest, and
the license signing key is held offline. [The security page](/security/)
describes how, in more detail than a policy should.

No system is perfect. If you find something, **security@sentrello.com** — and
please give us a chance to fix it before you publish.

---

## 10. Changes

When this policy changes materially we will change the effective date at the
top and, for anyone with an account, say so by email. The previous version is
available on request.
