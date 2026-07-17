ALTER TABLE "Business"
  ADD COLUMN "trialActivatedAt" TIMESTAMP(3),
  ADD COLUMN "trialEndsAt" TIMESTAMP(3);

CREATE INDEX "Business_trialEndsAt_idx" ON "Business"("trialEndsAt");
