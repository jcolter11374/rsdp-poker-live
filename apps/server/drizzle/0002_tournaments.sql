CREATE TABLE IF NOT EXISTS "tournaments" (
	"id" text PRIMARY KEY NOT NULL,
	"host_player_id" text NOT NULL,
	"status" text NOT NULL,
	"state" jsonb NOT NULL,
	"next_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournaments_status_check" CHECK ("tournaments"."status" in ('registering', 'seating', 'running', 'paused', 'finished', 'cancelled'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_host_player_id_players_id_fk" FOREIGN KEY ("host_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tournaments_status_idx" ON "tournaments" USING btree ("status");