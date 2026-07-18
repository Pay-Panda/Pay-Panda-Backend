-- Google Sign-In: passwordHash becomes optional (Google-only accounts have none),
-- googleId links a User to their Google account for auto-linking by verified email.
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
