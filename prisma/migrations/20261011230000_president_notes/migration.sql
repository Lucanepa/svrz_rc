-- The coach's confidential notes to the RC chair: one row per observation,
-- instead of one app_settings row per season holding every note as JSON (a
-- shape PocketBase made cheap: a new collection meant a schema run).

-- CreateTable
CREATE TABLE "president_notes" (
    "id" VARCHAR(15) NOT NULL,
    "feedback" VARCHAR(15),
    "note" TEXT NOT NULL DEFAULT '',
    "author_name" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "president_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "president_notes_feedback_key" ON "president_notes"("feedback");

-- AddForeignKey
ALTER TABLE "president_notes" ADD CONSTRAINT "president_notes_feedback_fkey" FOREIGN KEY ("feedback") REFERENCES "referee_coach_feedbacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The notes move over, each onto its observation, keeping its words, its
-- author and when it was last written. The labels the season row carried
-- (teams, coachee, coach) are read live from the observation from now on.
-- Oldest first, so the order column follows the order they were written.
--
-- The season rows (app_settings key president_notes_<season>) are left where
-- they are: nothing reads them any more, and until the move is confirmed they
-- are the copy to compare against. A later migration removes them.
INSERT INTO "president_notes" ("id", "feedback", "note", "author_name", "created", "updated")
SELECT substr(md5(n.key || clock_timestamp()::text || random()::text), 1, 15),
       n.key,
       n.value ->> 'note',
       coalesce(n.value ->> 'authorName', ''),
       t.stamp, t.stamp
FROM "app_settings" s
CROSS JOIN LATERAL json_each(CASE WHEN pg_input_is_valid(s."value", 'json') AND json_typeof(s."value"::json) = 'object'
                                  THEN s."value"::json ELSE '{}'::json END) n
CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(n.value ->> 'updatedAt', 'timestamptz')
                                THEN (n.value ->> 'updatedAt')::timestamptz ELSE CURRENT_TIMESTAMP END AS stamp) t
WHERE s."key" LIKE 'president\_notes\_%'
  AND coalesce(n.value ->> 'note', '') <> ''
  AND EXISTS (SELECT 1 FROM "referee_coach_feedbacks" f WHERE f."id" = n.key)
ORDER BY t.stamp;

-- A note whose observation is gone could not move. Said out loud in the
-- migration log; it stays in its season row, so nothing is lost.
DO $$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
  FROM "app_settings" s
  CROSS JOIN LATERAL json_each(CASE WHEN pg_input_is_valid(s."value", 'json') AND json_typeof(s."value"::json) = 'object'
                                    THEN s."value"::json ELSE '{}'::json END) n
  WHERE s."key" LIKE 'president\_notes\_%'
    AND coalesce(n.value ->> 'note', '') <> ''
    AND NOT EXISTS (SELECT 1 FROM "president_notes" p WHERE p."feedback" = n.key);
  IF stranded > 0 THEN
    RAISE WARNING 'president notes: % note(s) have no observation and stay in their season row', stranded;
  END IF;
END $$;
