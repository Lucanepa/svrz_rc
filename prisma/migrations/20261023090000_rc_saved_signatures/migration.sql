-- The coach's own signature, kept for their next report (23.10.2026): once a
-- coach has signed a filed report, the next form already carries it, unless
-- they turned that off. One row per coach, in a table of its own so that no
-- endpoint handing out coach records can carry the image along. `opted_out`
-- is the "no" the next filing respects; the image goes with it.

-- CreateTable
CREATE TABLE "rc_saved_signatures" (
    "id" VARCHAR(15) NOT NULL,
    "rc_id" TEXT NOT NULL DEFAULT '',
    "data" TEXT NOT NULL DEFAULT '',
    "opted_out" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "rc_saved_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rc_saved_signatures_rc_id_key" ON "rc_saved_signatures"("rc_id");
