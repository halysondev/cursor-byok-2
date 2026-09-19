-- Consumption ledger for background completion notifications. Completion items
-- whose result the parent agent obtained synchronously via await/foreground
-- Resume are recorded here, so later at-least-once duplicate notifications are
-- suppressed by identity and never trigger a follow-up.
CREATE TABLE background_consumed (
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    task_identity TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    consumed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, kind, task_identity, tool_call_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);
