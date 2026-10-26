CREATE TABLE IF NOT EXISTS "audit_log" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"data" jsonb NOT NULL,
	"prev" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_subject_idx" ON "audit_log" USING btree ("subject","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_kind_idx" ON "audit_log" USING btree ("kind","seq");
--> statement-breakpoint
-- Append-only like the chip ledger. Whoever runs the database can still drop this, which is why the hashes are copied to GitHub.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
