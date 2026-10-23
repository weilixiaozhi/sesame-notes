ALTER TABLE recurring_transactions ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recurring_transactions ADD COLUMN time_zone VARCHAR(100) NOT NULL DEFAULT 'UTC';
ALTER TABLE transactions ADD COLUMN occurrence_date VARCHAR(10);
CREATE UNIQUE INDEX transactions_recurring_id_occurrence_date_key ON transactions(recurring_id, occurrence_date);
