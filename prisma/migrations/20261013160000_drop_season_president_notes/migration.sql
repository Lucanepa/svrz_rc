-- The season rows the 2026-10-11 move left behind (app_settings key
-- president_notes_<season>) as the copy to compare against. Compared on
-- production 2026-10-13: all 9 notes of president_notes_2026 are in
-- president_notes with identical text, and nothing reads the rows any more
-- (Luca: remove them). A dump of the row is in
-- backups/app_settings-president_notes_2026-2026-10-13.json.
--
-- A season row still holding a note that never moved — its observation was
-- gone at the move — is kept rather than deleted, and said in the log.
DELETE FROM "app_settings" s
WHERE s."key" LIKE 'president\_notes\_%'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(CASE WHEN pg_input_is_valid(s."value", 'json') AND json_typeof(s."value"::json) = 'object'
                        THEN s."value"::json ELSE '{}'::json END) n
    WHERE coalesce(n.value ->> 'note', '') <> ''
      AND NOT EXISTS (SELECT 1 FROM "president_notes" p WHERE p."feedback" = n.key)
  );

DO $$
DECLARE kept int;
BEGIN
  SELECT count(*) INTO kept FROM "app_settings" WHERE "key" LIKE 'president\_notes\_%';
  IF kept > 0 THEN
    RAISE NOTICE 'president notes: % season row(s) kept — they hold notes that never moved', kept;
  END IF;
END $$;
