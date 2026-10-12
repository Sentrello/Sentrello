-- Indexes a business with a few years of history needs: the columns the
-- dashboard, reminders, the chart of accounts and the contact pages look
-- things up by. IF NOT EXISTS, so an instance that added one by hand while
-- waiting is not stopped by it.
CREATE INDEX IF NOT EXISTS "bank_transactions_matched_entry_idx" ON "bank_transactions" USING btree ("matched_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_org_email_idx" ON "contacts" USING btree ("organization_id",lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_org_status_due_idx" ON "invoices" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_org_source_idx" ON "journal_entries" USING btree ("organization_id","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_lines_account_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotes_contact_idx" ON "quotes" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "taggables_tag_idx" ON "taggables" USING btree ("tag_id");
