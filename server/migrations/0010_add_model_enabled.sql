-- Whether the model is published to Cursor's model catalog: the group switch toggles this
-- flag in bulk; a disabled model remains usable by conversations already using it.
ALTER TABLE model_configs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
