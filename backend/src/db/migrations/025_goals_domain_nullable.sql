-- domain was NOT NULL in the original schema but the app adds goals without one
ALTER TABLE goals ALTER COLUMN domain DROP NOT NULL;
