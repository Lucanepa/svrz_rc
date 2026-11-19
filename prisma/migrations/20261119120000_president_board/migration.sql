-- The chair's working layer over the RC notes (19.11.2026): a "read" tick per
-- note, and her own tags and memo per referee. Both read and written only
-- behind the chair's password (requireSurveyReader).

-- CreateTable
CREATE TABLE "president_note_reads" (
    "id" VARCHAR(15) NOT NULL,
    "ref" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "president_note_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "president_note_reads_ref_key" ON "president_note_reads"("ref");

-- CreateTable
CREATE TABLE "president_referee_marks" (
    "id" VARCHAR(15) NOT NULL,
    "referee_key" TEXT NOT NULL DEFAULT '',
    "referee_name" TEXT NOT NULL DEFAULT '',
    "tags" JSON,
    "memo" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "president_referee_marks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "president_referee_marks_referee_key_key" ON "president_referee_marks"("referee_key");
