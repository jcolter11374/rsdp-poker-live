CREATE TABLE IF NOT EXISTS "player_notes" (
	"owner_player_id" text NOT NULL,
	"target_player_id" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_notes_owner_player_id_target_player_id_pk" PRIMARY KEY("owner_player_id","target_player_id"),
	CONSTRAINT "player_notes_color_check" CHECK ("player_notes"."color" in ('none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_notes" ADD CONSTRAINT "player_notes_owner_player_id_players_id_fk" FOREIGN KEY ("owner_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
