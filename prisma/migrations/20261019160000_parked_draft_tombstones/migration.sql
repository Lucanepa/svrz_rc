-- A parked draft that was filed or discarded stays behind as a tombstone: the
-- payload goes, `deleted_at` says when. A coach's other devices still holding
-- an older copy learn from it that the work is finished, instead of showing it
-- as unsent or parking it straight back (server/parkSync.ts).
ALTER TABLE "parked_drafts" ADD COLUMN "deleted_at" TEXT NOT NULL DEFAULT '';
