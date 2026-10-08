CREATE TABLE "instance_claim" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"email" text NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL
);
