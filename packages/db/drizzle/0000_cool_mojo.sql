CREATE TABLE "license_cache" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token" text,
	"refreshed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
