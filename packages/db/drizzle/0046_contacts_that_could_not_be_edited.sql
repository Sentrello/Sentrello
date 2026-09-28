-- Contacts stored with a display name and no parts.
--
-- The edit form is built from `first_name` and `last_name` and its Save button
-- is guarded on one of them being present, so a contact carrying only `name`
-- opened with two empty boxes and could never be saved — not even to change
-- its status. Six of the eighteen contacts on the demo were in that state, and
-- any business that imported its book or took enquiries through an older form
-- will have its own share.
--
-- The form now falls back to the display name, so this is not what fixes the
-- bug. It is what stops the two columns disagreeing with the third, which is
-- the thing that caused it.
--
-- Split on the first run of whitespace: everything after it is the surname,
-- because "van der Berg" is one surname and not three. A row with a single
-- word gets a forename and no surname, which is what "Cher" is.
--
-- Only rows where both parts are empty, so a contact somebody deliberately
-- recorded as a surname alone is left as they wrote it, and running this twice
-- changes nothing.
-- The surname only exists when there is a space to split on. Without the CASE,
-- `position(' ' in 'Cher')` is 0, the substring returns the whole string, and a
-- one-word name lands in both columns as "Cher Cher". Caught by running this
-- against the awkward cases rather than by reading it.
UPDATE "contacts"
SET "first_name" = split_part(btrim("name"), ' ', 1),
    "last_name"  = CASE
      WHEN position(' ' in btrim("name")) > 0 THEN NULLIF(
        btrim(substring(btrim("name") from position(' ' in btrim("name")) + 1)),
        ''
      )
      ELSE NULL
    END
WHERE COALESCE(btrim("first_name"), '') = ''
  AND COALESCE(btrim("last_name"), '') = ''
  AND COALESCE(btrim("name"), '') <> '';
