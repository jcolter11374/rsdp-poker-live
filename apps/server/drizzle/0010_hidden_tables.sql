CREATE TABLE IF NOT EXISTS "hidden_tables" (
	"player_id" text NOT NULL,
	"table_id" text NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hidden_tables_player_id_table_id_pk" PRIMARY KEY("player_id","table_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hidden_tables" ADD CONSTRAINT "hidden_tables_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hidden_tables" ADD CONSTRAINT "hidden_tables_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hidden_tables_table_idx" ON "hidden_tables" USING btree ("table_id");
