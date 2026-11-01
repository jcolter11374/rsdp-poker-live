CREATE TABLE "table_log" (
	"n" bigserial PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"item" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "table_log" ADD CONSTRAINT "table_log_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "table_log_table_idx" ON "table_log" USING btree ("table_id","n");