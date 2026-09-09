ALTER TABLE "contacts" ADD COLUMN "do_not_sell" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "do_not_sell_on" timestamp;