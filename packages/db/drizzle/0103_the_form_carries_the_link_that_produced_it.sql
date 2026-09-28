-- The form carries the link that produced it.
--
-- The Links module mints a click id on every redirect and puts it on the
-- destination URL as `sr_id`. What it could not do was hear about a lead: the
-- only way to report one was an API a business's *external* back end had to
-- call with a tracking key — so the one form the platform controls, embedded
-- on the customer's own site, was the one that could not answer "which link
-- produced this contact". The Links post's whole argument rests on that join.
--
-- Opaque here. Core knows nothing about the Links module and must not; it
-- stores the string the embed sent back, and the module that minted it is the
-- one that can resolve it. A submission that arrived by any other route keeps
-- a null, which is the honest answer rather than the nearest link.
ALTER TABLE "form_submissions" ADD COLUMN "click_id" text;--> statement-breakpoint
CREATE INDEX "form_submissions_click_idx" ON "form_submissions" USING btree ("organization_id","click_id");
