ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "google_sub" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "has_password" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_google_sub_idx" ON "accounts" USING btree ("google_sub");