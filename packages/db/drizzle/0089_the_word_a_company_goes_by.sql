-- Companies and activities went onto the change feed under words nobody
-- offers: "companie" and "activitie", the resource name with its last letter
-- taken off. Every subscription and every automation says "company" and
-- "activity", so anything built on either was a rule that could never fire.
--
-- The rows are rewritten rather than matched both ways at read time. Nothing
-- was ever subscribed to the broken words — no screen offered them — so no
-- endpoint and no automation loses an event it was already receiving, and one
-- history that reads correctly beats every future reader having to know about
-- a spelling that existed for one release.
--
-- What it costs: an endpoint already subscribed to companies, whose cursor sits
-- behind one of these rows, is now told about a change it was silently never
-- told about. That is the delivery arriving late rather than a new one being
-- invented, and it is the outcome the business asked for.
UPDATE "record_events" SET "entity" = 'company' WHERE "entity" = 'companie';--> statement-breakpoint
UPDATE "record_events" SET "entity" = 'activity' WHERE "entity" = 'activitie';
