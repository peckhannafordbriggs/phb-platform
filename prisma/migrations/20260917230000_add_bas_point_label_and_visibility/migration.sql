-- AlterTable
ALTER TABLE "bas_points" ADD COLUMN     "is_visible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "label" TEXT;


-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change. Everything below it was written by hand, because Prisma
-- cannot express it.
--
--   Section 1  Why: showing is not collecting, and two columns called
--              display_name that mean opposite things.
--   Section 2  A CHECK that a label is NULL or has content - the eighteenth
--              CHECK in this schema.
--   Section 3  COMMENT ON for the two new columns, and for the three existing
--              columns whose meaning the new ones are defined against.
--
-- No data migration. Every existing point takes is_visible = true from the
-- DEFAULT and label = NULL, which is how it behaves today: nothing reads either
-- column yet (B8.1 is schema only), and when B8.2 onwards do, a NULL label falls
-- back to display_name and is_visible = true shows everything. The six bas_v_*
-- views are deliberately untouched - label precedence on screen is B8.4's
-- decision, and a view that filtered on is_visible would violate the rule in
-- the is_visible comment below.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- On 2026-09-17 the office JACE was classified by hand: 26 points, about
-- thirty minutes, entirely in SQL, because the platform has no way to set a
-- role, rename a point or hide one. A project with ten JACEs and 600 points
-- would take a week and nobody would do it. B8 is the tool; this migration is
-- its schema, and nothing else - no screen, no API.
--
-- Two columns:
--
--   label       what a PERSON calls the point. NULL until somebody types one.
--   is_visible  whether the point APPEARS on the browsing screens. Defaults on.
--
-- THE DISTINCTION THAT MUST NOT BLUR
--
--   is_active   whether the collector FETCHES the point. Turning it off is
--               permanent in effect: the station overwrites its own history -
--               the office JACE holds about five days, and one status point
--               about two hours - so a point not collected on Tuesday cannot
--               be recovered on Friday.
--   is_visible  whether the point is SHOWN. Cosmetic. Reversible at any moment
--               at no cost, because the data kept arriving the whole time.
--
-- Users asked to "choose which points to pull". What they want is a shorter
-- list on screen. Those are different requests, and conflating them destroys
-- data that can never be fetched again. So: collect everything, filter what
-- you see. Both columns default to on, and the COMMENTs in Section 3 state
-- what each one costs when turned off - that comment is the main defence
-- against the next person confusing them.
--
-- Global, not per-user. Hiding is a property of the point, which is how it was
-- asked for; a per-user join table is a thing nobody wanted. The trade-off is
-- recorded on the column: one person's hide is everyone's.
--
-- THE NAMING TRAP, and why the column is called label
--
-- bas_stations.display_name is what a person calls the station -
-- niagara_station_name is Niagara's. bas_points.display_name is the reverse:
-- it is what NIAGARA reports (the oBIX <ref> displayName attribute, written by
-- the collector on every discover). Same column name, opposite meaning, on two
-- tables in one module. Renaming the point column to make the tables agree was
-- evaluated and declined: the collector in phb-bas reads and writes
-- bas_points.display_name in its point upsert, its active-points reader and
-- its sync path, so the rename is a two-repository change that has to land in
-- one breath, and between the halves every collector pass fails - against a
-- station whose shortest history holds two hours. The human value is a new
-- column, label, instead; the Prisma field for the Niagara value is named
-- niagaraDisplayName so TypeScript reads correctly; and both display_name
-- columns carry a COMMENT naming the other.
--
-- THE GUARANTEE
--
-- discover re-reads every point from the station on every run. It must NEVER
-- write label or is_visible. Its upsert names the columns it writes and lists
-- neither, on INSERT or on conflict, and phb-bas/bas-collector/
-- test_point_management.py proves it against this migration applied to a
-- throwaway database with the real collector code: a labelled, hidden point
-- comes out of a rediscovery unchanged while its Niagara name updates beside
-- it. A collector change that adds either column to that upsert fails that
-- test.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - "no label" has one spelling
--
-- The eighteenth CHECK in this schema. Prisma models neither a CHECK nor its
-- absence, which is what makes appending it here safe.
--
-- A label is NULL, or it has content. Without this, '' and '   ' would be
-- further spellings of "nobody named it", and a screen that falls back to the
-- Niagara name on NULL would render an empty row for them. The service layer
-- will normalise blank to NULL when it exists (B8.4); this is what makes that
-- normalisation true rather than merely usual.
-- =============================================================================

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_label_not_blank
  CHECK (label IS NULL OR btrim(label) <> '');


-- =============================================================================
-- SECTION 3 - COMMENT ON
--
-- All five columns are in bas_v_data_dictionary, which feeds an LLM prompt, so
-- each needs a description or the model guesses from the name - and for these
-- five the name is exactly what misleads. tests/bas-schema.test.ts asserts each
-- is described and spot-checks the wording.
--
-- The two display_name comments replace earlier wording (bas_stations: from
-- add_station_tls_and_display_name; bas_points: had none). COMMENT ON is
-- idempotent, so re-running this is harmless.
-- =============================================================================

COMMENT ON COLUMN bas_points.label IS
  'What a PERSON calls this point. NULL means nobody has named it, and a screen falls back to '
  'display_name (Niagara''s name for it). Written only by the platform: the collector''s '
  'discover neither inserts nor updates this column, so a label survives every rediscovery. '
  'A blank string is refused by bas_points_label_not_blank so that "no label" is spelled NULL '
  'and nothing else. Free text and unstructured - once a point has a point_role and an '
  'equipment_id, a screen can render "VAV-8 - Zone Temperature" from structure alone, and a '
  'label is the exception rather than the chore.';

COMMENT ON COLUMN bas_points.is_visible IS
  'Whether this point APPEARS on the browsing screens. COSMETIC and REVERSIBLE: a hidden point '
  'is still collected, still checked for completeness, and must still be counted in every '
  'risk figure - a hidden point that starts losing history and says nothing is the 28 August '
  'failure again. Compare is_active, which controls whether the point is FETCHED at all and '
  'whose cost is permanent. To shorten a list, hide; never deactivate. Global rather than '
  'per-user, so one person''s hide is everyone''s - that is the trade-off for not building a '
  'join table nobody asked for. Never written by the collector.';

COMMENT ON COLUMN bas_points.is_active IS
  'Whether the collector FETCHES this point. Turning it off is PERMANENT in effect: the station '
  'overwrites its own history - the office JACE holds about five days, and one status point '
  'about two hours - so a point not collected on Tuesday cannot be recovered on Friday. To take '
  'a point off a screen use is_visible instead; it costs nothing. discover sets this true for '
  'every history it finds and false for one the station no longer reports, except the four '
  'Niagara system logs (AuditHistory, LogHistory, SecurityHistory, Global_Alarm), which are '
  'registered inactive and thereafter left exactly as a human set them.';

COMMENT ON COLUMN bas_points.display_name IS
  'What NIAGARA calls this history: the oBIX <ref> displayName attribute, written by the '
  'collector on every discover, falling back to a local decode of the $-hex escapes in '
  'niagara_history_name when the station sends none. NOT what a person calls it - that is '
  'label. WARNING: bas_stations.display_name means the OPPOSITE (a person''s name for the '
  'station). Same column name, opposite meaning, one table apart; the Prisma field here is '
  'niagaraDisplayName for that reason. The column keeps this name because the collector in '
  'phb-bas writes it by this name.';

COMMENT ON COLUMN bas_stations.display_name IS
  'What a PERSON calls this station. Free text, and NOT the identifier - niagara_station_name is '
  'what Niagara answers to. NULL means nobody has named it, and the UI falls back to the Niagara '
  'name rather than inventing a prettier version of it. WARNING: bas_points.display_name means '
  'the OPPOSITE (Niagara''s name for the point; a person''s is bas_points.label). Same column '
  'name, opposite meaning, one table apart.';
