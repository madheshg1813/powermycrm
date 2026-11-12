-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'MISSED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'WAITING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "leadId" TEXT,
    "userId" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL DEFAULT 'OUTBOUND',
    "status" "CallStatus" NOT NULL DEFAULT 'COMPLETED',
    "phone" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationSec" INTEGER,
    "dispositionId" TEXT,
    "notes" TEXT,
    "provider" TEXT,
    "providerRef" TEXT,
    "recordingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallDisposition" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CallDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "leadId" TEXT,
    "eventId" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "step" INTEGER NOT NULL DEFAULT 0,
    "log" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumeAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Call_organisationId_startedAt_idx" ON "Call"("organisationId", "startedAt");

-- CreateIndex
CREATE INDEX "Call_organisationId_userId_startedAt_idx" ON "Call"("organisationId", "userId", "startedAt");

-- CreateIndex
CREATE INDEX "Call_leadId_startedAt_idx" ON "Call"("leadId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallDisposition_organisationId_name_key" ON "CallDisposition"("organisationId", "name");

-- CreateIndex
CREATE INDEX "Automation_organisationId_trigger_active_idx" ON "Automation"("organisationId", "trigger", "active");

-- CreateIndex
CREATE INDEX "AutomationRun_automationId_startedAt_idx" ON "AutomationRun"("automationId", "startedAt");

-- CreateIndex
CREATE INDEX "AutomationRun_organisationId_leadId_startedAt_idx" ON "AutomationRun"("organisationId", "leadId", "startedAt");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_dispositionId_fkey" FOREIGN KEY ("dispositionId") REFERENCES "CallDisposition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallDisposition" ADD CONSTRAINT "CallDisposition_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "OutboxEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing workspaces get the default call outcomes that new ones are seeded with.
INSERT INTO "CallDisposition" ("id", "organisationId", "name", "position")
SELECT md5(random()::text || o."id" || d.name), o."id", d.name, d.position
FROM "Organisation" o CROSS JOIN (VALUES ('Interested', 0), ('Not interested', 1), ('Call back later', 2), ('No answer', 3), ('Wrong number', 4), ('Already purchased', 5)) AS d(name, position);
