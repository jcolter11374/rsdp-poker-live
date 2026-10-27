CREATE TABLE IF NOT EXISTS "practice_resets" (
	"player_id" text PRIMARY KEY NOT NULL,
	"reset_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "practice_resets" ADD CONSTRAINT "practice_resets_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
