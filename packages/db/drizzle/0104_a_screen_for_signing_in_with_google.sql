CREATE TABLE "auth_providers" (
	"provider" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
