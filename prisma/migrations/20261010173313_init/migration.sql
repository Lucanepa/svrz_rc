-- CreateTable
CREATE TABLE "games" (
    "id" VARCHAR(15) NOT NULL,
    "match_no" TEXT NOT NULL DEFAULT '',
    "league" TEXT NOT NULL DEFAULT '',
    "match_date" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "home_team" TEXT NOT NULL DEFAULT '',
    "away_team" TEXT NOT NULL DEFAULT '',
    "first_referee" TEXT NOT NULL DEFAULT '',
    "second_referee" TEXT NOT NULL DEFAULT '',
    "first_line_judge" TEXT NOT NULL DEFAULT '',
    "second_line_judge" TEXT NOT NULL DEFAULT '',
    "assigned_rc" TEXT NOT NULL DEFAULT '',
    "feedback_closed_roles" JSON,
    "source_payload" JSON,
    "game_result" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "is_rsv_game" BOOLEAN NOT NULL DEFAULT false,
    "is_rd_game" BOOLEAN NOT NULL DEFAULT false,
    "is_ld_game" BOOLEAN NOT NULL DEFAULT false,
    "maps_url" TEXT NOT NULL DEFAULT '',
    "external_id" TEXT NOT NULL DEFAULT '',
    "assigned_rc_id" TEXT NOT NULL DEFAULT '',
    "first_referee_id" TEXT NOT NULL DEFAULT '',
    "second_referee_id" TEXT NOT NULL DEFAULT '',
    "assigned_at" TEXT NOT NULL DEFAULT '',
    "assigned_via" TEXT NOT NULL DEFAULT '',
    "handed_over" JSON,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coachees" (
    "id" VARCHAR(15) NOT NULL,
    "full_name" TEXT NOT NULL DEFAULT '',
    "first_name" TEXT NOT NULL DEFAULT '',
    "last_name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "referee_level" TEXT NOT NULL DEFAULT '',
    "stage" TEXT NOT NULL DEFAULT '',
    "groups" TEXT NOT NULL DEFAULT '',
    "feedback_entries" JSON,
    "last_feedback_at" TEXT NOT NULL DEFAULT '',
    "season" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT NOT NULL DEFAULT '',
    "referee_id" TEXT NOT NULL DEFAULT '',
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "coachees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referee_coaches" (
    "id" VARCHAR(15) NOT NULL,
    "first_name" TEXT NOT NULL DEFAULT '',
    "last_name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "pin_hash" TEXT NOT NULL DEFAULT '',
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_rc_president" BOOLEAN NOT NULL DEFAULT false,
    "sv_number" TEXT NOT NULL DEFAULT '',
    "name_aliases" TEXT NOT NULL DEFAULT '',
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "referee_coaches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referee_coach_feedbacks" (
    "id" VARCHAR(15) NOT NULL,
    "game" VARCHAR(15),
    "coachee" VARCHAR(15),
    "rc_name" TEXT NOT NULL DEFAULT '',
    "role_assessed" TEXT NOT NULL DEFAULT '',
    "feedback_json" JSON,
    "submitted_at" TEXT NOT NULL DEFAULT '',
    "pdf_file" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "rc_id" TEXT NOT NULL DEFAULT '',
    "submission_key" TEXT NOT NULL DEFAULT '',
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "referee_coach_feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observations" (
    "id" VARCHAR(15) NOT NULL,
    "coachee" VARCHAR(15),
    "referee_coach" VARCHAR(15),
    "game" VARCHAR(15),
    "coachee_function" TEXT NOT NULL DEFAULT '',
    "grades" JSON,
    "game_level" TEXT NOT NULL DEFAULT '',
    "promotion" TEXT NOT NULL DEFAULT '',
    "motivation" TEXT NOT NULL DEFAULT '',
    "sr_goal" TEXT NOT NULL DEFAULT '',
    "game_result" TEXT NOT NULL DEFAULT '',
    "remarks" TEXT NOT NULL DEFAULT '',
    "second_observation" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" VARCHAR(15) NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL DEFAULT '',
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signatures" (
    "id" VARCHAR(15) NOT NULL,
    "slug" TEXT NOT NULL DEFAULT '',
    "context" TEXT NOT NULL DEFAULT '',
    "signer" TEXT NOT NULL DEFAULT '',
    "data" TEXT NOT NULL DEFAULT '',
    "signed" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rc_visit_feedback" (
    "id" VARCHAR(15) NOT NULL,
    "token" TEXT NOT NULL DEFAULT '',
    "referee_name" TEXT NOT NULL DEFAULT '',
    "match_date" TEXT NOT NULL DEFAULT '',
    "match_no" TEXT NOT NULL DEFAULT '',
    "rc_name" TEXT NOT NULL DEFAULT '',
    "lang" TEXT NOT NULL DEFAULT '',
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "answers" JSON,
    "submitted" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "rc_visit_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referees" (
    "id" VARCHAR(15) NOT NULL,
    "sv_number" TEXT NOT NULL DEFAULT '',
    "first_name" TEXT NOT NULL DEFAULT '',
    "last_name" TEXT NOT NULL DEFAULT '',
    "full_name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "gender" TEXT NOT NULL DEFAULT '',
    "level" TEXT NOT NULL DEFAULT '',
    "stage" TEXT NOT NULL DEFAULT '',
    "lr_level" TEXT NOT NULL DEFAULT '',
    "license_association" TEXT NOT NULL DEFAULT '',
    "license_active" BOOLEAN NOT NULL DEFAULT false,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "dispensed" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT NOT NULL DEFAULT '',
    "imported_at" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "referees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parked_drafts" (
    "id" VARCHAR(15) NOT NULL,
    "owner_id" TEXT NOT NULL DEFAULT '',
    "game_id" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL DEFAULT '',
    "schema" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payload" JSON,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "parked_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rc_game_notes" (
    "id" VARCHAR(15) NOT NULL,
    "game" VARCHAR(15),
    "game_id" TEXT NOT NULL DEFAULT '',
    "rc_name" TEXT NOT NULL DEFAULT '',
    "rc_id" TEXT NOT NULL DEFAULT '',
    "rc_role" TEXT NOT NULL DEFAULT '',
    "coachee_name" TEXT NOT NULL DEFAULT '',
    "coachee_id" TEXT NOT NULL DEFAULT '',
    "coachee_role" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "submitted_at" TEXT NOT NULL DEFAULT '',
    "season" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "submission_key" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "roles_swapped" BOOLEAN NOT NULL DEFAULT false,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "rc_game_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boerse_offers" (
    "id" VARCHAR(15) NOT NULL,
    "vm_offer_id" TEXT NOT NULL DEFAULT '',
    "match_no" TEXT NOT NULL DEFAULT '',
    "game_starts_at" TEXT NOT NULL DEFAULT '',
    "referee_position" TEXT NOT NULL DEFAULT '',
    "slot" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT '',
    "slot_person_name" TEXT NOT NULL DEFAULT '',
    "slot_person_sv" TEXT NOT NULL DEFAULT '',
    "slot_person_vm_id" TEXT NOT NULL DEFAULT '',
    "submitted_by_name" TEXT NOT NULL DEFAULT '',
    "submitted_by_sv" TEXT NOT NULL DEFAULT '',
    "submitting_type" TEXT NOT NULL DEFAULT '',
    "submitted_at" TEXT NOT NULL DEFAULT '',
    "applied_by_name" TEXT NOT NULL DEFAULT '',
    "applied_by_sv" TEXT NOT NULL DEFAULT '',
    "applied_at" TEXT NOT NULL DEFAULT '',
    "join_via" TEXT NOT NULL DEFAULT '',
    "first_seen" TEXT NOT NULL DEFAULT '',
    "last_seen" TEXT NOT NULL DEFAULT '',
    "withdrawn_at" TEXT NOT NULL DEFAULT '',
    "raw" JSON,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "alerted_at" TEXT NOT NULL DEFAULT '',
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "boerse_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rc_notebook" (
    "id" VARCHAR(15) NOT NULL,
    "owner_id" TEXT NOT NULL DEFAULT '',
    "page_id" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT '',
    "created_at" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL DEFAULT '',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "schema" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payload" JSON,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "rc_notebook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rc_switch_requests" (
    "id" VARCHAR(15) NOT NULL,
    "coachee_id" TEXT NOT NULL DEFAULT '',
    "coachee_name" TEXT NOT NULL DEFAULT '',
    "to_game" TEXT NOT NULL DEFAULT '',
    "to_match_no" TEXT NOT NULL DEFAULT '',
    "from_game" TEXT NOT NULL DEFAULT '',
    "from_match_no" TEXT NOT NULL DEFAULT '',
    "requester_id" TEXT NOT NULL DEFAULT '',
    "requester_name" TEXT NOT NULL DEFAULT '',
    "holder_id" TEXT NOT NULL DEFAULT '',
    "holder_name" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT '',
    "expires_at" TEXT NOT NULL DEFAULT '',
    "decided_at" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "rc_switch_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" VARCHAR(15) NOT NULL,
    "rc_id" TEXT NOT NULL DEFAULT '',
    "rc_name" TEXT NOT NULL DEFAULT '',
    "endpoint" TEXT NOT NULL DEFAULT '',
    "keys" JSON,
    "ua" TEXT NOT NULL DEFAULT '',
    "last_ok" TEXT NOT NULL DEFAULT '',
    "failures" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "games_match_no_idx" ON "games"("match_no");

-- CreateIndex
CREATE INDEX "games_external_id_idx" ON "games"("external_id");

-- CreateIndex
CREATE INDEX "games_match_date_idx" ON "games"("match_date");

-- CreateIndex
CREATE INDEX "games_assigned_rc_id_idx" ON "games"("assigned_rc_id");

-- CreateIndex
CREATE INDEX "coachees_full_name_idx" ON "coachees"("full_name");

-- CreateIndex
CREATE INDEX "coachees_referee_id_idx" ON "coachees"("referee_id");

-- CreateIndex
CREATE INDEX "coachees_season_idx" ON "coachees"("season");

-- CreateIndex
CREATE INDEX "referee_coach_feedbacks_game_idx" ON "referee_coach_feedbacks"("game");

-- CreateIndex
CREATE INDEX "referee_coach_feedbacks_coachee_idx" ON "referee_coach_feedbacks"("coachee");

-- CreateIndex
CREATE INDEX "referee_coach_feedbacks_submitted_at_idx" ON "referee_coach_feedbacks"("submitted_at");

-- CreateIndex
CREATE INDEX "referee_coach_feedbacks_submission_key_idx" ON "referee_coach_feedbacks"("submission_key");

-- CreateIndex
CREATE INDEX "observations_game_idx" ON "observations"("game");

-- CreateIndex
CREATE INDEX "observations_coachee_idx" ON "observations"("coachee");

-- CreateIndex
CREATE INDEX "observations_referee_coach_idx" ON "observations"("referee_coach");

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_key_key" ON "app_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "signatures_slug_key" ON "signatures"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "rc_visit_feedback_token_key" ON "rc_visit_feedback"("token");

-- CreateIndex
CREATE INDEX "referees_sv_number_idx" ON "referees"("sv_number");

-- CreateIndex
CREATE INDEX "parked_drafts_owner_id_idx" ON "parked_drafts"("owner_id");

-- CreateIndex
CREATE INDEX "rc_game_notes_game_idx" ON "rc_game_notes"("game");

-- CreateIndex
CREATE INDEX "rc_game_notes_game_id_idx" ON "rc_game_notes"("game_id");

-- CreateIndex
CREATE INDEX "rc_game_notes_submission_key_idx" ON "rc_game_notes"("submission_key");

-- CreateIndex
CREATE INDEX "boerse_offers_match_no_idx" ON "boerse_offers"("match_no");

-- CreateIndex
CREATE UNIQUE INDEX "boerse_offers_vm_offer_id_key" ON "boerse_offers"("vm_offer_id");

-- CreateIndex
CREATE INDEX "rc_notebook_owner_id_idx" ON "rc_notebook"("owner_id");

-- CreateIndex
CREATE INDEX "rc_switch_requests_status_idx" ON "rc_switch_requests"("status");

-- CreateIndex
CREATE INDEX "rc_switch_requests_coachee_id_idx" ON "rc_switch_requests"("coachee_id");

-- CreateIndex
CREATE INDEX "push_subscriptions_rc_id_idx" ON "push_subscriptions"("rc_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- AddForeignKey
ALTER TABLE "referee_coach_feedbacks" ADD CONSTRAINT "referee_coach_feedbacks_game_fkey" FOREIGN KEY ("game") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referee_coach_feedbacks" ADD CONSTRAINT "referee_coach_feedbacks_coachee_fkey" FOREIGN KEY ("coachee") REFERENCES "coachees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_coachee_fkey" FOREIGN KEY ("coachee") REFERENCES "coachees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_referee_coach_fkey" FOREIGN KEY ("referee_coach") REFERENCES "referee_coaches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_game_fkey" FOREIGN KEY ("game") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rc_game_notes" ADD CONSTRAINT "rc_game_notes_game_fkey" FOREIGN KEY ("game") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
