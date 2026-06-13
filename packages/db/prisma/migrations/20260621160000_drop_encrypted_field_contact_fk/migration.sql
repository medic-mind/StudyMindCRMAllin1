-- EncryptedField.contactId is a POLYMORPHIC owner id (Contact for safeguarding
-- fields, but a User id for the Gmail/Trengo OAuth refresh tokens — ADR 0012).
-- The foreign key to Contact made every Gmail/Trengo connect (ownerId = User id)
-- violate it and 500 at the encryption step. Drop the constraint; the AAD binds
-- each row to its real owner, so referential safety is preserved at the crypto
-- layer. The column + unique index are kept.
ALTER TABLE "EncryptedField" DROP CONSTRAINT IF EXISTS "EncryptedField_contactId_fkey";
