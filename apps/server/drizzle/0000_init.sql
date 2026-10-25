CREATE TABLE IF NOT EXISTS "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"primary_player_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chip_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "chip_movements_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"table_id" text NOT NULL,
	"seat_session_id" text,
	"player_id" text,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"stack_before" bigint,
	"stack_after" bigint,
	"actor_player_id" text,
	"hand_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chip_movements_kind_check" CHECK ("chip_movements"."kind" in ('buy-in', 'rebuy', 'add-on', 'host-add', 'host-remove', 'host-set', 'cash-out', 'escrow-in', 'escrow-out', 'bounty', 'rake')),
	CONSTRAINT "chip_movements_player_check" CHECK ("chip_movements"."kind" = 'rake'
        or ("chip_movements"."player_id" is not null and "chip_movements"."stack_before" is not null and "chip_movements"."stack_after" is not null)),
	CONSTRAINT "chip_movements_stack_check" CHECK (("chip_movements"."stack_before" is null and "chip_movements"."stack_after" is null)
        or ("chip_movements"."stack_before" is not null and "chip_movements"."stack_after" is not null
          and "chip_movements"."stack_before" >= 0 and "chip_movements"."stack_after" >= 0 and "chip_movements"."stack_after" = "chip_movements"."stack_before" + "chip_movements"."amount"))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hands" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"number" integer NOT NULL,
	"game_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"header" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"results" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('pending', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "players" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"player_id" text NOT NULL,
	"seat" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "seat_sessions_seat_check" CHECK ("seat_sessions"."seat" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"actor_player_id" text,
	"changes" jsonb NOT NULL,
	"effective_hand" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_snapshots" (
	"table_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"state" jsonb NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tables" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_player_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"mode" text DEFAULT 'cash' NOT NULL,
	"tournament_id" text,
	"club_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tables_status_check" CHECK ("tables"."status" in ('open', 'paused', 'stopped', 'archived')),
	CONSTRAINT "tables_mode_check" CHECK ("tables"."mode" in ('cash', 'tournament'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_primary_player_id_players_id_fk" FOREIGN KEY ("primary_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chip_movements" ADD CONSTRAINT "chip_movements_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chip_movements" ADD CONSTRAINT "chip_movements_seat_session_id_seat_sessions_id_fk" FOREIGN KEY ("seat_session_id") REFERENCES "public"."seat_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chip_movements" ADD CONSTRAINT "chip_movements_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chip_movements" ADD CONSTRAINT "chip_movements_actor_player_id_players_id_fk" FOREIGN KEY ("actor_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hands" ADD CONSTRAINT "hands_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_tokens" ADD CONSTRAINT "player_tokens_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "players" ADD CONSTRAINT "players_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seat_sessions" ADD CONSTRAINT "seat_sessions_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seat_sessions" ADD CONSTRAINT "seat_sessions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "settings_changes" ADD CONSTRAINT "settings_changes_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "settings_changes" ADD CONSTRAINT "settings_changes_actor_player_id_players_id_fk" FOREIGN KEY ("actor_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "table_snapshots" ADD CONSTRAINT "table_snapshots_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tables" ADD CONSTRAINT "tables_owner_player_id_players_id_fk" FOREIGN KEY ("owner_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_username_lower_idx" ON "accounts" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chip_movements_table_idx" ON "chip_movements" USING btree ("table_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chip_movements_player_idx" ON "chip_movements" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hands_table_number_idx" ON "hands" USING btree ("table_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_dedupe_key_idx" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_run_at_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_tokens_player_id_idx" ON "player_tokens" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "players_account_id_idx" ON "players" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seat_sessions_table_idx" ON "seat_sessions" USING btree ("table_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seat_sessions_open_seat_idx" ON "seat_sessions" USING btree ("table_id","seat") WHERE "seat_sessions"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seat_sessions_open_player_idx" ON "seat_sessions" USING btree ("table_id","player_id") WHERE "seat_sessions"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_account_id_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settings_changes_table_idx" ON "settings_changes" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tables_status_activity_idx" ON "tables" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tables_owner_idx" ON "tables" USING btree ("owner_player_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tables_tournament_idx" ON "tables" USING btree ("tournament_id");