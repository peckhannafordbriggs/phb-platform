-- CreateTable
CREATE TABLE "bas_report_deliveries" (
    "delivery_id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "email" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "graph_request_id" TEXT,
    "sent_at" TIMESTAMPTZ,
    "requested_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_report_deliveries_pkey" PRIMARY KEY ("delivery_id")
);

-- CreateIndex
CREATE INDEX "bas_report_deliveries_status_next_attempt_at_idx" ON "bas_report_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "bas_report_deliveries_run_id_email_key" ON "bas_report_deliveries"("run_id", "email");

-- AddForeignKey
ALTER TABLE "bas_report_deliveries" ADD CONSTRAINT "bas_report_deliveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "bas_report_runs"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_deliveries" ADD CONSTRAINT "bas_report_deliveries_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against a database at head on 2026-11-17).
-- Everything below was written by hand, because Prisma cannot express it.
--
--   Section 1  Why: Reports, Phase 4, the email half - one row per address
--              per run.
--   Section 2  CHECK constraints.
--   Section 3  bas_v_data_dictionary excludes the new table.
--   Section 4  COMMENT ON.
--   Section 5  A defensive REVOKE, as add_bas_report_runs did.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- docs/bas-reports-tab-plan.md §D5. When a run has finished (succeeded or
-- partial) and its PDF is ready, the worker writes one row here for the
-- report's OWNER - from the employee record, never from a recipient row -
-- and one for each of the report's recipient rows, then sends one message
-- per row from the BAS mailbox through the phb-platform-bas-mail app
-- registration. The unique key on (run_id, email) is the idempotency the plan
-- asks for: a worker that writes the rows twice writes them once, and a row
-- already sent is not taken again.
--
-- status:
--   pending    waiting for the worker - queued now, or after a failed attempt
--              until next_attempt_at, or leased by an attempt in flight
--   sent       Graph accepted the sendMail call (202); sent_at says when
--   failed     three attempts failed, or a failure no retry can fix (not
--              configured; a non-company address outside production);
--              Resend queues it again
--   not_sent   the send gate (BAS_REPORTS_ALLOW_SEND) was closed when the
--              worker reached it, so nothing left the platform. Resend does
--              not touch it; Send to me makes a new attempt for one address
--
-- graph_request_id, not a message id: the app holds Mail.Send only (Request
-- 7), so it sends with sendMail, which answers 202 with no body and no
-- message id. Graph's request-id header for that call is what Microsoft
-- support asks for; the message itself carries X-PHB-Report-Delivery with
-- this row's id, which a message trace can find.
--
-- Platform-side, like every report table: email addresses and send state,
-- not building data. Withheld from bas_analyze and bas_collector, excluded
-- from the data dictionary, not moved by the Azure migration script.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - CHECK constraints
-- =============================================================================

ALTER TABLE bas_report_deliveries
  ADD CONSTRAINT bas_report_deliveries_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'not_sent')),
  ADD CONSTRAINT bas_report_deliveries_source_check
    CHECK (source IN ('owner', 'recipient', 'requested')),
  -- The same shape bas_report_recipients enforces, and lower-cased for the
  -- same reason: the unique key on (run_id, email) means what it says.
  ADD CONSTRAINT bas_report_deliveries_email_shape
    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  ADD CONSTRAINT bas_report_deliveries_email_lower
    CHECK (email = lower(email)),
  -- Three attempts, the plan's number (lib/modules/bas/reports/deliveries.ts,
  -- MAX_DELIVERY_ATTEMPTS).
  ADD CONSTRAINT bas_report_deliveries_attempts_range
    CHECK (attempts BETWEEN 0 AND 3),
  ADD CONSTRAINT bas_report_deliveries_position_check
    CHECK (position >= 0),
  -- sent_at is set exactly when the row is sent.
  ADD CONSTRAINT bas_report_deliveries_sent_at_when_sent
    CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  -- A failed or unsent row always says why.
  ADD CONSTRAINT bas_report_deliveries_reason_when_not_sent
    CHECK (status NOT IN ('failed', 'not_sent') OR last_error IS NOT NULL);


-- =============================================================================
-- SECTION 3 - bas_v_data_dictionary excludes the new table
--
-- The same decision as add_bas_reports, Section 3: addresses and send state
-- are platform data, not building data, and the model is refused them.
-- =============================================================================

CREATE OR REPLACE VIEW bas_v_data_dictionary AS
SELECT
    c.relname AS object_name,
    CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' ELSE c.relkind::text END AS object_type,
    a.attname                            AS column_name,
    format_type(a.atttypid, a.atttypmod) AS data_type,
    NOT a.attnotnull                     AS is_nullable,
    col_description(c.oid, a.attnum)     AS column_description,
    obj_description(c.oid, 'pg_class')   AS object_description
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = 'public'
  AND c.relname LIKE 'bas\_%'
  AND c.relname <> 'bas_station_credentials'
  AND c.relname NOT IN (
        'bas_report_definitions',
        'bas_report_questions',
        'bas_report_recipients',
        'bas_library_questions',
        'bas_personal_questions',
        'bas_report_runs',
        'bas_report_findings',
        'bas_report_settings',
        'bas_report_deliveries'
      )
  AND c.relkind IN ('r','v')
ORDER BY c.relkind DESC, c.relname, a.attnum;

COMMENT ON VIEW bas_v_data_dictionary IS
  'The entire annotated BAS schema in one query. Intended to be selected and pasted into an '
  'LLM prompt as context, so the model writes SQL against documented columns rather than '
  'guessing from names. Scoped to bas_-prefixed objects: the platform''s own employee and '
  'audit tables are deliberately NOT exposed here; bas_station_credentials is excluded by '
  'name, and so are the nine report tables (bas_report_definitions, bas_report_questions, '
  'bas_report_recipients, bas_library_questions, bas_personal_questions, bas_report_runs, '
  'bas_report_findings, bas_report_settings, bas_report_deliveries) - configuration people '
  'typed, documents the platform wrote and the addresses it sent them to, not building data, '
  'and the model is refused them. Keep the COMMENT ON statements current - they are not '
  'decoration, they are the model''s only description of what the data means.';


-- =============================================================================
-- SECTION 4 - COMMENT ON, for a person reading the catalog
-- =============================================================================

COMMENT ON TABLE bas_report_deliveries IS
  'One email of one report run to one address (Reports, Phase 4, the email half, 2026-11-17). '
  'Written by the worker when a run has finished and its PDF is ready: the owner from the '
  'employee record (never a recipient row), then each recipient row; unique on (run_id, email), '
  'so a retried worker sends once. Sent from the BAS mailbox by the worker job only, behind '
  'BAS_REPORTS_ALLOW_SEND. Platform data, not building data: excluded from '
  'bas_v_data_dictionary and withheld from bas_analyze and bas_collector.';
COMMENT ON COLUMN bas_report_deliveries.source IS
  'owner (the report owner''s employee email, added at send time), recipient (a '
  'bas_report_recipients row), requested (Send to me).';
COMMENT ON COLUMN bas_report_deliveries.status IS
  'pending, sent, failed (Resend queues it again) or not_sent (the send gate was closed; '
  'nothing left the platform).';
COMMENT ON COLUMN bas_report_deliveries.attempts IS
  'Attempts made, at most three; a claim counts before the Graph call is made, so a worker '
  'that dies mid-send has used one.';
COMMENT ON COLUMN bas_report_deliveries.next_attempt_at IS
  'When the worker may take the row: now when queued, after a backoff when an attempt failed, '
  'and a lease while an attempt is in flight. The worker job''s scaler counts pending rows '
  'whose time has come.';
COMMENT ON COLUMN bas_report_deliveries.last_error IS
  'Why the last attempt failed, that one started and has not finished, or why nothing was '
  'sent. Status, code and request id only: never the message body.';
COMMENT ON COLUMN bas_report_deliveries.graph_request_id IS
  'Graph''s request-id for the sendMail call it accepted. sendMail answers 202 with no body, '
  'so there is no message id; this is what Microsoft support asks for.';


-- =============================================================================
-- SECTION 5 - a defensive REVOKE, as add_bas_report_runs did
-- =============================================================================

DO $revoke$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['bas_readonly_platform', 'bas_analyze', 'bas_collector'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.bas_report_deliveries FROM %I', r);
        END IF;
    END LOOP;
END
$revoke$;
