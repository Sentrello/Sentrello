<!--
  Terms of Service.

  Copied from the marketing site's own source — src/pages/legal/service-terms.md — which
  is what sentrello.com serves and what governs. Kept here so the repository
  carries it too: an AGPL project whose license talk lives only on a marketing
  site is asking to be taken at its word.

  If the two ever disagree, the website is right and this is stale.
-->

# Terms of Service

**Effective Date: October 1, 2026**

These Terms of Service ("Terms") are an agreement between you and **Sentrello
LLC**, a Colorado limited liability company ("Sentrello", "we", "us"). They
govern `sentrello.com`, the account area, the license service, and your use of
Sentrello Core, Sentrello Pro, modules and plugins (together, the "Software").

Two documents sit beside these Terms and form part of the same agreement: the
[Terms of Sale](/legal/sales-terms/), which govern buying and renewing, and the
[Software License Agreement](/legal/sla/), which governs what you may do with
the code. Where they conflict on a commercial question, the Terms of Sale win;
on a licensing question, the Software License Agreement wins.

---

## 1. Accepting these Terms

You accept these Terms by checking the box presented at checkout, by purchasing
a subscription, or by using the Software. If you are accepting on behalf of a
company, you confirm you are authorized to bind it, and "you" means that
company.

If you do not accept them, do not buy a subscription and do not run the
Software.

---

## 2. What we provide, and what we do not

**We provide:** the Software as published; a license key and the service that
verifies it; the published documentation; release artifacts at the versions we
publish them; and email support at the level your subscription includes.

**We do not provide:** hosting, uptime, backups, monitoring, disaster recovery,
security operations, data migration, or any form of service level commitment.
Sentrello is self-hosted software. Nothing in these Terms is a promise that the
Software will be available, because the server it runs on is not ours.

There is no Service Level Agreement and we make none. If you need one, you need
a managed host, and we are not one.

---

## 3. Your account

You are responsible for your account credentials and for everything done with
them. Tell us at **support@sentrello.com** if you believe your account or your
license key has been compromised, and we will retire the key and issue another.

One account may hold one license. A license key may be activated on **two
installs at a time** — enough to build a new server while the old one is still
running, not enough to run a second business on one subscription. Sharing or
publishing a license key terminates it.

---

## 4. Your responsibilities, because the server is yours

You are solely responsible for:

1. **Backups.** The product takes a nightly database dump and keeps fourteen,
   and the update command takes one before it touches anything. Keeping a copy
   off that machine is yours to do, and nobody else can do it for you.
2. **Security of the host.** Operating system patching, the firewall, SSH
   access, TLS certificates, the reverse proxy, and who can reach the machine.
3. **Availability.** Hardware, disk space, memory, power and network.
4. **Your data.** What you put in, what you export, what you delete, and the
   legal obligations that attach to it — including your own obligations as a
   data controller to the people whose records you hold.
5. **Your integrations.** Any payment provider, mail server, tax service or
   other third party you connect to your instance, and the terms of those
   services.
6. **Updating.** We publish releases; applying them is your decision and your
   act. Running an old version is allowed and unsupported.

---

## 5. Acceptable use

You may not use the Software or our services to:

- break the law, or help somebody else break it;
- send unsolicited bulk email, or use the Newsletter module in a way that
  breaches CAN-SPAM, PECR, the GDPR or Canada's anti-spam law;
- infringe anybody's intellectual property;
- attack, overload or probe our license service or website, beyond good-faith
  security research reported to security@sentrello.com;
- resell, sublicense or host the Software for third parties, except under a
  signed [Partner Agreement](/legal/partners/);
- remove, disable or work around license verification, or run paid features
  without a subscription that covers them;
- use the Sentrello name or marks outside [the trademark
  guidelines](/legal/trademark/).

We may suspend a license key that is being used this way. For anything short of
abuse we will write to you first.

---

## 6. The license service, and what happens when it cannot be reached

A paid instance asks our license service for a fresh token once an hour. The
token it already holds keeps working, so an instance with no internet, or one
we have taken offline for maintenance, keeps running until the token expires.

If a subscription lapses, a paid instance falls back to Sentrello Core. Paid
features stop; **nothing is deleted**, and the data those features created stays
in your database. Restoring the subscription restores the features.

We aim to keep the license service available and we do not guarantee it. A
failure of that service does not entitle you to a refund — see the Terms of
Sale.

---

## 7. Support

Email support at **support@sentrello.com**, in English, during United States
business hours. We answer questions about the Software as published and about
your license. We do not administer your server, write your configuration,
migrate your data or debug code you have modified.

Support is not a warranty, and an unanswered question is not a breach of these
Terms.

---

## 8. Third-party services

The product can connect to payment providers, mail servers, search-data
providers and tax services. Those are your relationships, on their terms, at
their prices. We are not responsible for their acts, their outages, their fees
or their handling of your data.

---

## 9. Warranties: there are none

THE SOFTWARE AND ALL SERVICES ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT
WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. WE SPECIFICALLY DISCLAIM THE IMPLIED
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, QUIET
ENJOYMENT AND NON-INFRINGEMENT.

We do not warrant that the Software is free of defects, that it will meet your
requirements, that it will operate without interruption, that its calculations
suit your circumstances, or that it will make you compliant with any law or
accounting standard. **Sentrello is not an accountant, a bookkeeper, a tax
adviser or a lawyer, and the Software is not advice.** Figures it produces are
yours to check before you rely on them, file them or act on them.

Some jurisdictions do not allow the exclusion of implied warranties. Where that
is so, this section applies to the maximum extent permitted and the remaining
warranty is limited to the shortest period the law allows.

---

## 10. Limitation of liability

This section is the deal. Read it.

**(a) No liability.** TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL
AGGREGATE LIABILITY TO YOU FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THESE
TERMS, THE SOFTWARE OR ANY SERVICE IS **ZERO UNITED STATES DOLLARS ($0)**.

**(b) If (a) is unenforceable.** If a court or tribunal holds subsection (a)
unenforceable in whole or in part, our total aggregate liability is instead
limited to the total fees you actually paid us in the twelve months immediately
before the event giving rise to the claim.

**(c) If (b) is unenforceable.** If subsection (b) is also held unenforceable,
our total aggregate liability is limited to one hundred United States dollars
($100).

**(d) Excluded losses, in every case.** WE ARE NOT LIABLE FOR INDIRECT,
INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, NOR FOR LOST
PROFITS, LOST REVENUE, LOST BUSINESS, LOST GOODWILL, BUSINESS INTERRUPTION,
REGULATORY FINES, PROFESSIONAL FEES, THE COST OF SUBSTITUTE SOFTWARE, OR **LOST,
CORRUPTED OR UNRECOVERABLE DATA**, however caused and on any theory of
liability, whether or not we were advised such damages were possible.

**(e) In particular, and without limiting the above**, we are not liable for:
data loss on a server we do not control; a backup you did not keep; a backup
that did not restore; downtime; a security incident on your infrastructure; a
tax, VAT, GST or payroll figure you filed; an invoice a customer disputes; an
email that was not delivered; a payment a provider declined or reversed; a
migration that went wrong; or any consequence of your own modification of the
Software.

**(f) You accept the operational risk.** You agree that you, and not Sentrello,
bear the entire risk of operating the Software: its availability, the integrity
of your data, the accuracy of the figures you rely on, and your compliance with
the laws that apply to your business. You agree that the price of the Software
reflects this allocation of risk, and that we would not sell it on any other
basis.

**(g) The floor.** Nothing in these Terms excludes liability that cannot be
excluded by law — including liability for death or personal injury caused by
negligence, for fraud or fraudulent misrepresentation, or any liability that
applicable consumer law makes non-excludable for the buyer in question.

---

## 11. Indemnity

You will defend, indemnify and hold harmless Sentrello LLC and its owners,
officers and contractors against any claim, demand, loss or expense (including
reasonable legal fees) arising from: your use of the Software; your data; your
modifications; your integrations; your use of the Newsletter module; your
obligations to the people whose records you hold; or your breach of these Terms.

---

## 12. Suspension and termination

You may stop using the Software at any time. Canceling a subscription is
covered by the [Terms of Sale](/legal/sales-terms/).

We may suspend or terminate your license key, your account, or both, if you
breach these Terms, if a payment is not made, or if a license key is shared or
published. Where we can reasonably give notice first, we will.

On termination: sections 9, 10, 11 and 14 survive, the Free tier of the Software
remains yours under the AGPLv3, and paid features stop working at the end of the
grace period described in the Terms of Sale.

---

## 13. Changes to these Terms

We may change these Terms. The effective date at the top moves, and if the
change materially affects you and you have an account, we will email you. For an
existing subscription, a material change takes effect at your next renewal;
continuing to use the Software after that renewal is acceptance. The previous
version is available on request.

---

## 14. Governing law, venue, and how disputes are handled

These Terms are governed by the laws of the **State of Colorado**, United
States, without regard to conflict-of-law rules. The United Nations Convention
on Contracts for the International Sale of Goods does not apply.

Any dispute must be brought exclusively in the state or federal courts located
in Colorado, and you consent to their jurisdiction. **Each party waives any
right to a jury trial**, and neither party may bring a claim as a class action
or in a representative capacity.

If you are a consumer resident in the EU or UK, nothing here removes your right
to bring proceedings in your own courts, or the protection of the mandatory law
of your country of residence.

---

## 15. The rest

**Entire agreement.** These Terms, the Terms of Sale and the Software License
Agreement are the whole agreement between us about the Software, and replace
anything said before them.

**Severability.** If a provision is unenforceable, it is limited or severed to
the minimum extent necessary and the rest stands.

**No waiver.** A right we do not enforce immediately is not a right we have
given up.

**Assignment.** You may not assign these Terms without our written consent. We
may assign them to a successor in the business.

**Force majeure.** Neither party is liable for a failure caused by something
outside its reasonable control.

**Notices.** To you, by email to your account address. To us, by email to
**support@sentrello.com**.

**No agency.** Nothing here creates a partnership, agency, franchise or
employment relationship.
