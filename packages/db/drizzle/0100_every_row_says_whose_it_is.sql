-- Every business table now says which organization owns its rows.
--
-- 191 tables carried `organization_id` and two had a foreign key for it,
-- both of those Better Auth's own. So deleting an organization left its
-- rows behind in 189 tables — invisible to the product, because every
-- query filters by organization, and invisible to the business, because
-- nothing lists them. They were found by the sweeps that walk every row
-- regardless: 1,615 stale scheduling settings turned a four-second test
-- suite into a fifty-second one, because the reminder job loops each one.
--
-- With the constraint in place, `DELETE FROM organizations` is the whole
-- of removing a business from an instance, and it reaches module schemas
-- whether or not that module's code is loaded — which nothing else could
-- do.
--
-- The orphans have to go first, because the constraint will not be created
-- while a row violates it. This deletes only rows whose organization does
-- not exist: no query in the product can reach them, no screen lists them,
-- and no backup taken before this migration loses them.

DELETE FROM "accounts" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "accounts"."organization_id");--> statement-breakpoint
DELETE FROM "activities" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "activities"."organization_id");--> statement-breakpoint
DELETE FROM "archive_runs" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "archive_runs"."organization_id");--> statement-breakpoint
DELETE FROM "bank_connections" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bank_connections"."organization_id");--> statement-breakpoint
DELETE FROM "bank_imports" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bank_imports"."organization_id");--> statement-breakpoint
DELETE FROM "bank_payment_schedules" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bank_payment_schedules"."organization_id");--> statement-breakpoint
DELETE FROM "bank_payments" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bank_payments"."organization_id");--> statement-breakpoint
DELETE FROM "bank_provider_accounts" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bank_provider_accounts"."organization_id");--> statement-breakpoint
DELETE FROM "bank_reconciliations" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bank_reconciliations"."organization_id");--> statement-breakpoint
DELETE FROM "bank_rules" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bank_rules"."organization_id");--> statement-breakpoint
DELETE FROM "bank_transactions" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bank_transactions"."organization_id");--> statement-breakpoint
DELETE FROM "bill_payments" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bill_payments"."organization_id");--> statement-breakpoint
DELETE FROM "billable_items" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "billable_items"."organization_id");--> statement-breakpoint
DELETE FROM "bills" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "bills"."organization_id");--> statement-breakpoint
DELETE FROM "budgets" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "budgets"."organization_id");--> statement-breakpoint
DELETE FROM "companies" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "companies"."organization_id");--> statement-breakpoint
DELETE FROM "compliance_settings" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "compliance_settings"."organization_id");--> statement-breakpoint
DELETE FROM "consent_records" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "consent_records"."organization_id");--> statement-breakpoint
DELETE FROM "contact_duplicate_dismissals" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "contact_duplicate_dismissals"."organization_id");--> statement-breakpoint
DELETE FROM "contact_merges" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "contact_merges"."organization_id");--> statement-breakpoint
DELETE FROM "contacts" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "contacts"."organization_id");--> statement-breakpoint
DELETE FROM "contractor_tax_details" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "contractor_tax_details"."organization_id");--> statement-breakpoint
DELETE FROM "crm_settings" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "crm_settings"."organization_id");--> statement-breakpoint
DELETE FROM "crm_webhook_deliveries" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "crm_webhook_deliveries"."organization_id");--> statement-breakpoint
DELETE FROM "crm_webhooks" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "crm_webhooks"."organization_id");--> statement-breakpoint
DELETE FROM "customer_credits" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "customer_credits"."organization_id");--> statement-breakpoint
DELETE FROM "deals" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "deals"."organization_id");--> statement-breakpoint
DELETE FROM "dimensions" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "dimensions"."organization_id");--> statement-breakpoint
DELETE FROM "document_counters" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "document_counters"."organization_id");--> statement-breakpoint
DELETE FROM "document_taxes" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "document_taxes"."organization_id");--> statement-breakpoint
DELETE FROM "document_templates" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "document_templates"."organization_id");--> statement-breakpoint
DELETE FROM "exchange_rates" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "exchange_rates"."organization_id");--> statement-breakpoint
DELETE FROM "exemption_certificates" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "exemption_certificates"."organization_id");--> statement-breakpoint
DELETE FROM "expenses" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "expenses"."organization_id");--> statement-breakpoint
DELETE FROM "fixed_assets" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "fixed_assets"."organization_id");--> statement-breakpoint
DELETE FROM "form_submissions" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "form_submissions"."organization_id");--> statement-breakpoint
DELETE FROM "forms" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "forms"."organization_id");--> statement-breakpoint
DELETE FROM "invoices" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "invoices"."organization_id");--> statement-breakpoint
DELETE FROM "invoicing_settings" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "invoicing_settings"."organization_id");--> statement-breakpoint
DELETE FROM "journal_entries" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "journal_entries"."organization_id");--> statement-breakpoint
DELETE FROM "ledger_settings" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "ledger_settings"."organization_id");--> statement-breakpoint
DELETE FROM "module_state" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "module_state"."organization_id");--> statement-breakpoint
DELETE FROM "mtd_connections" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "mtd_connections"."organization_id");--> statement-breakpoint
DELETE FROM "notes" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "notes"."organization_id");--> statement-breakpoint
DELETE FROM "onboarding_dismissals" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "onboarding_dismissals"."organization_id");--> statement-breakpoint
DELETE FROM "organization_preferences" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "organization_preferences"."organization_id");--> statement-breakpoint
DELETE FROM "organization_role" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "organization_role"."organization_id");--> statement-breakpoint
DELETE FROM "payees" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "payees"."organization_id");--> statement-breakpoint
DELETE FROM "payment_accounts" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "payment_accounts"."organization_id");--> statement-breakpoint
DELETE FROM "payment_webhook_events" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "payment_webhook_events"."organization_id");--> statement-breakpoint
DELETE FROM "payments" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "payments"."organization_id");--> statement-breakpoint
DELETE FROM "peppol_connections" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "peppol_connections"."organization_id");--> statement-breakpoint
DELETE FROM "peppol_submissions" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "peppol_submissions"."organization_id");--> statement-breakpoint
DELETE FROM "quotes" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "quotes"."organization_id");--> statement-breakpoint
DELETE FROM "record_events" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "record_events"."organization_id");--> statement-breakpoint
DELETE FROM "recurring_bills" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "recurring_bills"."organization_id");--> statement-breakpoint
DELETE FROM "recurring_periods" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "recurring_periods"."organization_id");--> statement-breakpoint
DELETE FROM "recurring_profiles" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "recurring_profiles"."organization_id");--> statement-breakpoint
DELETE FROM "reminder_log" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "reminder_log"."organization_id");--> statement-breakpoint
DELETE FROM "reminder_rules" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "reminder_rules"."organization_id");--> statement-breakpoint
DELETE FROM "sale_places" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "sale_places"."organization_id");--> statement-breakpoint
DELETE FROM "saved_views" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "saved_views"."organization_id");--> statement-breakpoint
DELETE FROM "security_events" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "security_events"."organization_id");--> statement-breakpoint
DELETE FROM "security_policy" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "security_policy"."organization_id");--> statement-breakpoint
DELETE FROM "tags" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "tags"."organization_id");--> statement-breakpoint
DELETE FROM "tasks" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "tasks"."organization_id");--> statement-breakpoint
DELETE FROM "tax_definitions" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "tax_definitions"."organization_id");--> statement-breakpoint
DELETE FROM "transactions" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "transactions"."organization_id");--> statement-breakpoint
DELETE FROM "user_group_members" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "user_group_members"."organization_id");--> statement-breakpoint
DELETE FROM "user_groups" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "user_groups"."organization_id");--> statement-breakpoint
DELETE FROM "user_preferences" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "user_preferences"."organization_id");--> statement-breakpoint
DELETE FROM "vendor_credit_applications" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "vendor_credit_applications"."organization_id");--> statement-breakpoint
DELETE FROM "vendor_credits" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "vendor_credits"."organization_id");--> statement-breakpoint

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_runs" ADD CONSTRAINT "archive_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_imports" ADD CONSTRAINT "bank_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_payment_schedules" ADD CONSTRAINT "bank_payment_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_payments" ADD CONSTRAINT "bank_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_provider_accounts" ADD CONSTRAINT "bank_provider_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billable_items" ADD CONSTRAINT "billable_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_settings" ADD CONSTRAINT "compliance_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissals" ADD CONSTRAINT "contact_duplicate_dismissals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_tax_details" ADD CONSTRAINT "contractor_tax_details_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD CONSTRAINT "crm_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_webhook_deliveries" ADD CONSTRAINT "crm_webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_webhooks" ADD CONSTRAINT "crm_webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_taxes" ADD CONSTRAINT "document_taxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemption_certificates" ADD CONSTRAINT "exemption_certificates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD CONSTRAINT "invoicing_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_settings" ADD CONSTRAINT "ledger_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_state" ADD CONSTRAINT "module_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mtd_connections" ADD CONSTRAINT "mtd_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_dismissals" ADD CONSTRAINT "onboarding_dismissals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_preferences" ADD CONSTRAINT "organization_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_role" ADD CONSTRAINT "organization_role_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peppol_connections" ADD CONSTRAINT "peppol_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peppol_submissions" ADD CONSTRAINT "peppol_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_events" ADD CONSTRAINT "record_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_periods" ADD CONSTRAINT "recurring_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD CONSTRAINT "recurring_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_rules" ADD CONSTRAINT "reminder_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_places" ADD CONSTRAINT "sale_places_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_policy" ADD CONSTRAINT "security_policy_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_definitions" ADD CONSTRAINT "tax_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_applications" ADD CONSTRAINT "vendor_credit_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;