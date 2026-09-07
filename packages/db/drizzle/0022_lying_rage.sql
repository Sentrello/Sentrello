ALTER TABLE "document_templates" ALTER COLUMN "html" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "document_templates" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "document_templates" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "document_templates" ADD COLUMN "header_note" text;--> statement-breakpoint
ALTER TABLE "document_templates" ADD COLUMN "footer_note" text;--> statement-breakpoint
ALTER TABLE "document_templates" ADD COLUMN "paper_size" text DEFAULT 'letter' NOT NULL;