CREATE TABLE IF NOT EXISTS "player_avatars" (
	"player_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_avatars_kind_check" CHECK ("player_avatars"."kind" in ('library', 'upload'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_avatars" ADD CONSTRAINT "player_avatars_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
