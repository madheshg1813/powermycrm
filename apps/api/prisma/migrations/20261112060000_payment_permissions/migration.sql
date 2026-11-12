-- Existing system roles learn the payment permissions introduced with the Payment model,
-- so workspaces created before this change are not locked out of the feature.
UPDATE "Role"
SET "permissions" = array_cat("permissions", ARRAY['payments.view', 'payments.manage'])
WHERE "systemKey" IN ('owner', 'admin', 'manager', 'agent')
  AND NOT ("permissions" @> ARRAY['payments.view']);
