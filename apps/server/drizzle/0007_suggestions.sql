CREATE TABLE IF NOT EXISTS "suggestions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"reply" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestions_status_check" CHECK ("suggestions"."status" in ('new', 'approved', 'planned', 'in_progress', 'shipped', 'declined'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suggestions_status_idx" ON "suggestions" USING btree ("status");