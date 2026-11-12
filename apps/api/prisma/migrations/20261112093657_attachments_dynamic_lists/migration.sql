-- CreateEnum
CREATE TYPE "ListKind" AS ENUM ('STATIC', 'DYNAMIC');

-- AlterTable
ALTER TABLE "LeadList" ADD COLUMN     "filters" JSONB,
ADD COLUMN     "kind" "ListKind" NOT NULL DEFAULT 'STATIC';

-- CreateTable
CREATE TABLE "LeadAttachment" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadAttachment_storageKey_key" ON "LeadAttachment"("storageKey");

-- CreateIndex
CREATE INDEX "LeadAttachment_leadId_createdAt_idx" ON "LeadAttachment"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadAttachment_organisationId_idx" ON "LeadAttachment"("organisationId");

-- AddForeignKey
ALTER TABLE "LeadAttachment" ADD CONSTRAINT "LeadAttachment_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAttachment" ADD CONSTRAINT "LeadAttachment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAttachment" ADD CONSTRAINT "LeadAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
