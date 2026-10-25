CREATE TABLE IF NOT EXISTS "shared_hands" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"hand_number" integer NOT NULL,
	"created_by" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shared_hands" ADD CONSTRAINT "shared_hands_created_by_players_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_hands_created_by_idx" ON "shared_hands" USING btree ("created_by");