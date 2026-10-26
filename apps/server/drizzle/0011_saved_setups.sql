CREATE TABLE IF NOT EXISTS "saved_setups" (
	"player_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"json" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_setups_player_id_kind_name_pk" PRIMARY KEY("player_id","kind","name"),
	CONSTRAINT "saved_setups_kind_check" CHECK ("saved_setups"."kind" in ('table', 'tournament'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_setups" ADD CONSTRAINT "saved_setups_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
