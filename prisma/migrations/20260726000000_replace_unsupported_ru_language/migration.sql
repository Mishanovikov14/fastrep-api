-- Keep existing users aligned with the supported API language contract.
UPDATE "User"
SET "language" = 'en'
WHERE "language" = 'ru';
