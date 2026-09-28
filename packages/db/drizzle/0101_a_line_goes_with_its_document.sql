-- A line now goes when the document it belongs to goes.
--
-- Seven child tables carry no `organization_id` of their own: an invoice's
-- lines belong to the invoice, which belongs to the organization. Yesterday's
-- migration keyed everything that *does* carry one, so deleting an
-- organization took its invoices, quotes, bills, budgets, journal entries and
-- tags — and left every line of every one of them behind. Those rows were
-- unreachable twice over: no query in the product can find a line whose
-- document does not exist, and no sweep can find it either, because it names
-- no organization to be swept by. This database held 32,181 of them.
--
-- The orphans go first, because a constraint will not be created while a row
-- violates it. Deleting them loses nothing that anything could read: each one
-- is a line, instalment or tag pairing whose parent row is already gone.
--
-- Only the owning parent gets `ON DELETE CASCADE`. These tables also hold
-- `account_id`, `tax_definition_id`, `billable_item_id`, `class_id`,
-- `location_id` and `invoice_id` — those are references, not owners, and a
-- cascade on any of them would delete accounting history the day somebody
-- tidied up a tax rate or a chart of accounts. They are deliberately left
-- without a key. `taggables.entity_id` is polymorphic — it names a row in
-- whichever table the tag was put on, told apart by `entity_type` — so it
-- cannot have a foreign key at all.

DELETE FROM "invoice_lines" WHERE NOT EXISTS (SELECT 1 FROM "invoices" p WHERE p.id = "invoice_lines"."invoice_id");--> statement-breakpoint
DELETE FROM "quote_lines" WHERE NOT EXISTS (SELECT 1 FROM "quotes" p WHERE p.id = "quote_lines"."quote_id");--> statement-breakpoint
DELETE FROM "quote_instalments" WHERE NOT EXISTS (SELECT 1 FROM "quotes" p WHERE p.id = "quote_instalments"."quote_id");--> statement-breakpoint
DELETE FROM "bill_lines" WHERE NOT EXISTS (SELECT 1 FROM "bills" p WHERE p.id = "bill_lines"."bill_id");--> statement-breakpoint
DELETE FROM "budget_lines" WHERE NOT EXISTS (SELECT 1 FROM "budgets" p WHERE p.id = "budget_lines"."budget_id");--> statement-breakpoint
DELETE FROM "journal_lines" WHERE NOT EXISTS (SELECT 1 FROM "journal_entries" p WHERE p.id = "journal_lines"."entry_id");--> statement-breakpoint
DELETE FROM "taggables" WHERE NOT EXISTS (SELECT 1 FROM "tags" p WHERE p.id = "taggables"."tag_id");--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_instalments" ADD CONSTRAINT "quote_instalments_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taggables" ADD CONSTRAINT "taggables_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;