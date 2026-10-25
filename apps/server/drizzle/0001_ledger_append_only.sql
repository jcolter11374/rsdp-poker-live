-- The chip ledger is append-only: corrections are new movements, never edits.
CREATE OR REPLACE FUNCTION chip_movements_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chip_movements is append-only (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS chip_movements_append_only ON chip_movements;
--> statement-breakpoint
CREATE TRIGGER chip_movements_append_only
  BEFORE UPDATE OR DELETE ON chip_movements
  FOR EACH ROW EXECUTE FUNCTION chip_movements_append_only();
