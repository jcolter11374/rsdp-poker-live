CREATE TABLE IF NOT EXISTS "tournament_log" (
	"n" bigserial PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"item_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"item" jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tournament_log" ADD CONSTRAINT "tournament_log_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tournament_log_tournament_idx" ON "tournament_log" USING btree ("tournament_id","n");
