ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "reset_code_hash" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "reset_code_expires_at" timestamp with time zone;