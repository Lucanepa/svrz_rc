-- Sign-in with a passkey (02.11.2026): the coach's device holds a private key
-- that its fingerprint, face or PIN unlocks; this table holds the matching
-- PUBLIC key, one row per device key. `credential_id` is the name the device
-- gives the key (unique: one key, one row). `counter` is the device's
-- signature count, `last_used` an ISO time, `label` "iPhone · Safari".

-- CreateTable
CREATE TABLE "rc_passkeys" (
    "id" VARCHAR(15) NOT NULL,
    "rc_id" TEXT NOT NULL DEFAULT '',
    "credential_id" TEXT NOT NULL DEFAULT '',
    "public_key" TEXT NOT NULL DEFAULT '',
    "counter" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transports" JSON,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT NOT NULL DEFAULT '',
    "last_used" TEXT NOT NULL DEFAULT '',
    "created" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "_seq" SERIAL NOT NULL,

    CONSTRAINT "rc_passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rc_passkeys_credential_id_key" ON "rc_passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "rc_passkeys_rc_id_idx" ON "rc_passkeys"("rc_id");
