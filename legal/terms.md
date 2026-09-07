<!--
  The terms that govern using Sentrello, the website and the paid tiers.

  Copied from the marketing site's source — websentrello,
  src/pages/terms.md — which is what sentrello.com serves and what
  governs. Kept here so the repository carries it too: an AGPL project
  whose licence talk lives only on a marketing site is asking to be
  taken at its word.

  If the two ever disagree, the website is right and this is stale.
-->

# Terms and Conditions

**Last Updated:** August 17, 2026

Please read these Terms and Conditions ("Terms") carefully before using the Sentrello platform, including the open-source Sentrello Core, Sentrello Pro, Pro Modules, and the website located at sentrello.com (collectively, the "Services"), operated by Sentrello LLC ("Company," "we," "us," or "our").

---

## 1. Acceptance of Terms
By accessing or using sentrello.com, installing or hosting Sentrello Core or Sentrello Pro, or purchasing a subscription to Sentrello Pro or Pro Modules, you agree to be bound by these Terms and our Privacy Policy. If you do not agree to all of these Terms, do not access or use the Services.

---

## 2. Software Licensing & Distribution

### Sentrello Core
Sentrello Core is distributed as open-source software under the GNU Affero General Public License v3.0 (AGPLv3). You may inspect, modify, and self-host Sentrello Core in accordance with the terms of the AGPLv3 license available in the open-source code repository at `github.com/Sentrello/Sentrello`.

* **Module Linking Exception:** An additional permission under section 7 of the AGPLv3, published at the top of the `LICENSE` file in that repository, permits a module that interacts with Sentrello Core solely through the published `@sentrello/module-sdk` interfaces to be conveyed under terms of its author's choosing. Sentrello Core itself, and any modification to it, remains subject to the AGPLv3 in full.

### Sentrello Pro & Pro Modules
Sentrello Pro and its associated Pro Modules are commercial, proprietary software add-ons and binary/Docker images provided under a commercial license subscription, distinct from the AGPLv3 open-source license.
* **License Validation:** Sentrello Pro requires an active subscription license key. Self-hosted instances running Sentrello Pro communicate ("phone home") back to sentrello.com once daily to validate subscription key status.
* **Code Add-ons:** Pro Modules are delivered as code/software add-ons to extend base functionality.

---

## 3. Subscriptions, Billing, and Grace Periods

### Billing & Payments
Commercial subscriptions for Sentrello Pro and Pro Modules are billed on a recurring monthly or annual basis via Stripe. By subscribing, you authorize automatic recurring charges to your payment method at the beginning of each billing cycle.

### Cancellations, Expirations & 14-Day Grace Period
* **Auto-Renewal:** Subscriptions automatically renew until explicitly canceled through your sentrello.com account portal.
* **Grace Period & Reversion:** Upon cancellation or subscription expiration, you will retain access to Sentrello Pro features and Pro Modules for a fourteen (14) day grace period.
* **Access Lockout:** Following the 14-day grace period, access to Sentrello Pro platform features and Pro Modules will be locked out and cease operating, and software updates for Pro features will stop. The system will automatically revert to Sentrello Core functionality.
* **Data Retention:** All underlying database content and application data created while using Pro features remain intact on your self-hosted infrastructure. Reactivating a valid subscription restores access to Pro features and data immediately.

### Refund Policy
**All sales are final**. We do not offer refunds, pro-rated returns, or credits for partial subscription terms. Your access to paid functionality continues through the end of your paid billing period plus the 14-day grace period.

---

## 4. Self-Hosting, Liability & Disclaimers

### Self-Hosted Responsibility
Sentrello Core and Sentrello Pro are designed to be deployed on server infrastructure managed and controlled entirely by you ("User"). You assume full and sole responsibility for:
1. Server security, network firewalls, OS patching, and access control.
2. Implementing regular, routine database and system backups.
3. System availability, uptime, hardware resources, and data storage maintenance.

### Disclaimer of Warranties
THE SERVICES AND SOFTWARE (INCLUDING CORE, PRO, AND PRO MODULES) ARE PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, OR NON-INFRINGEMENT.

### Limitation of Liability
TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL SENTRELLO LLC, ITS OFFICERS, DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING WITHOUT LIMITATION LOSS OF PROFITS, LOSS OF DATA, LOSS OF USE, GOODWILL, SERVER DOWNTIME, MISCONFIGURATIONS, OR SECURITY BREACHES ARISING OUT OF OR IN CONNECTION WITH YOUR SELF-HOSTED ENVIRONMENT OR USE OF THE SOFTWARE.

---

## 5. Governing Law and Jurisdiction
These Terms shall be governed by and construed in accordance with the laws of the **State of Colorado**, United States, without regard to its conflict of law principles. Any legal action or proceeding arising under these Terms shall be brought exclusively in the state or federal courts located in Colorado.