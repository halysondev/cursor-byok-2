//! Consumption ledger for background completion notifications: completion
//! items whose result the parent agent already obtained synchronously via
//! await/foreground Resume. Readers match by exact projected event identity
//! (`{kind}:{task}:{tool_call}`).
use std::collections::HashSet;

use crate::{model::ConversationId, Result};

use super::{now_ms, Store};

impl Store {
    pub(crate) async fn record_consumed_background_completions(
        &self,
        conversation_id: &ConversationId,
        kind: &str,
        completions: &[(String, String)],
    ) -> Result<()> {
        if completions.is_empty() {
            return Ok(());
        }
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        for (task_identity, tool_call_id) in completions {
            sqlx::query(
                "INSERT OR IGNORE INTO background_consumed
                 (conversation_id, kind, task_identity, tool_call_id, consumed_at_ms)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(conversation_id.as_str())
            .bind(kind)
            .bind(task_identity)
            .bind(tool_call_id)
            .bind(now_ms())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Event identities of every consumed completion item in this
    /// conversation, matching the identity segment inside each per-item
    /// `background-completed:` event ID.
    pub(crate) async fn consumed_background_identities(
        &self,
        conversation_id: &ConversationId,
    ) -> Result<HashSet<String>> {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT kind, task_identity, tool_call_id
             FROM background_consumed
             WHERE conversation_id = ?",
        )
        .bind(conversation_id.as_str())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(kind, task_identity, tool_call_id)| {
                format!("{kind}:{task_identity}:{tool_call_id}")
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn consumed_completion_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();
        let conversation_id = ConversationId::new("conversation-1");
        store.ensure_conversation(&conversation_id).await.unwrap();

        assert!(store
            .consumed_background_identities(&conversation_id)
            .await
            .unwrap()
            .is_empty());
        store
            .record_consumed_background_completions(
                &conversation_id,
                "BACKGROUND_TASK_KIND_SUBAGENT",
                &[("agent-1".into(), "task-call-1".into())],
            )
            .await
            .unwrap();
        // Primary-key idempotent: a duplicate registration never creates a second row.
        store
            .record_consumed_background_completions(
                &conversation_id,
                "BACKGROUND_TASK_KIND_SUBAGENT",
                &[("agent-1".into(), "task-call-1".into())],
            )
            .await
            .unwrap();
        let identities = store
            .consumed_background_identities(&conversation_id)
            .await
            .unwrap();
        assert_eq!(
            identities.iter().collect::<Vec<_>>(),
            ["BACKGROUND_TASK_KIND_SUBAGENT:agent-1:task-call-1"]
        );
    }
}
