-- chip_movements and seat_sessions were made for a chip ledger that was never built: the site never wrote to them,
-- and the cash ledger lives in each table's saved state (table_snapshots.state.ledger). Each table is dropped only
-- if it is empty, so this never deletes a row: a table that has rows stays as it is, unused. chip_movements points
-- at seat_sessions, so seat_sessions goes only once chip_movements has gone. Safe to run twice. A backup that still
-- lists these tables restores too (RETIRED in apps/server/src/db/backup.ts runs this again after its rows).
DO $$ BEGIN
 IF to_regclass('public.chip_movements') IS NOT NULL THEN
  IF NOT EXISTS (SELECT 1 FROM "chip_movements") THEN
   DROP TABLE "chip_movements";
  END IF;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('public.chip_movements') IS NULL THEN
  DROP FUNCTION IF EXISTS chip_movements_append_only();
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('public.seat_sessions') IS NOT NULL AND to_regclass('public.chip_movements') IS NULL THEN
  IF NOT EXISTS (SELECT 1 FROM "seat_sessions") THEN
   DROP TABLE "seat_sessions";
  END IF;
 END IF;
END $$;
