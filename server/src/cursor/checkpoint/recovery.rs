//! Restores Conversation Messages and pending Tool state from a checkpoint.
use crate::{
    cursor::{checkpoint::messages, protocol::proto::agent::v1 as pb},
    model::CanonicalMessage,
    store::BlobId,
    Error, Result,
};

use super::CheckpointBuilder;

impl CheckpointBuilder {
    pub async fn import_prefetched(&self, blobs: &[pb::PreFetchedBlob]) -> Result<()> {
        for blob in blobs {
            match classify_prefetched(blob)? {
                Some(Prefetched::Verified(expected, value)) => {
                    let actual = self.store.put_blob(value, &[]).await?;
                    if expected != actual {
                        return Err(Error::Protocol(format!(
                            "prefetched Blob hash mismatch: {}",
                            expected.to_base64()
                        )));
                    }
                }
                Some(Prefetched::Raw(payload)) => {
                    // Stored by content address; the conversation state
                    // references blobs by content address either way.
                    self.store.put_blob(payload, &[]).await?;
                    tracing::debug!(
                        id_len = blob.id.len(),
                        value_len = blob.value.len(),
                        "prefetched Blob carried no 32-byte digest; stored by content address"
                    );
                }
                None => continue,
            }
        }
        Ok(())
    }

    pub async fn hydrate_messages(
        &self,
        state: Option<&pb::ConversationStateStructure>,
    ) -> Result<Vec<CanonicalMessage>> {
        let mut messages = Vec::new();
        let Some(state) = state else {
            return Ok(messages);
        };
        for (ordinal, raw) in state.root_prompt_messages_json.iter().enumerate() {
            // Server-built checkpoints echo back as 32-byte blob ids; states
            // built by the client itself (the review agent) carry the encoded
            // message inline — and normalization turns those into refs whose
            // blobs hold the original bytes. One tolerant decoder covers both:
            // newline-delimited JSON splits into one message per line, and
            // chunks that do not decode (binary client formats) are skipped
            // rather than failing the whole run.
            let (data, source) = match classify_state_entry(raw)? {
                StateEntry::Reference(id) => {
                    let data = self.sync.get(&id).await?.ok_or_else(|| {
                        Error::Protocol(format!("missing message Blob {}", id.to_base64()))
                    })?;
                    (data, id.to_base64())
                }
                StateEntry::Inline => (raw.to_vec(), "inline".to_owned()),
            };
            for (line, chunk) in inline_json_lines(&data).into_iter().enumerate() {
                match messages::decode(&chunk, format!("cursor-root:{source}:{ordinal}:{line}")) {
                    Ok(message) => messages.push(message),
                    Err(error) => {
                        tracing::debug!(
                            source = %source,
                            ordinal,
                            line,
                            len = chunk.len(),
                            %error,
                            "skipping unparseable conversation entry"
                        );
                    }
                }
            }
        }
        Ok(messages)
    }
}

/// Splits inline conversation-state bytes into individual JSON messages.
/// A single JSON value is returned whole; newline-delimited JSON (several
/// objects, one per line) is split per line. Empty lines never produce
/// entries. JSON strings escape internal newlines, so a raw newline byte can
/// only sit between two top-level values.
fn inline_json_lines(data: &[u8]) -> Vec<Vec<u8>> {
    let trimmed = trim_ascii_whitespace(data);
    if trimmed.is_empty() {
        return Vec::new();
    }
    if serde_json::from_slice::<serde_json::Value>(trimmed).is_ok() {
        return vec![trimmed.to_vec()];
    }
    trimmed
        .split(|byte| *byte == b'\n')
        .filter(|line| !trim_ascii_whitespace(line).is_empty())
        .map(|line| trim_ascii_whitespace(line).to_vec())
        .collect()
}

fn trim_ascii_whitespace(data: &[u8]) -> &[u8] {
    let start = data
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(data.len());
    let end = data
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(start, |position| position + 1);
    &data[start..end]
}

/// Converts a client-built conversation state into server form. Entries the
/// client carries inline (root messages, turns, todos, summaries — anything
/// that is not already a 32-byte digest) are persisted to the blob store and
/// replaced with their digests, so every checkpoint consumer (turns, roots,
/// summaries, publish) can treat them uniformly as references.
pub async fn normalize_client_state(
    state: &mut pb::ConversationStateStructure,
    store: &crate::store::Store,
) -> Result<()> {
    let repeated_fields: [&mut Vec<Vec<u8>>; 4] = [
        &mut state.root_prompt_messages_json,
        &mut state.turns,
        &mut state.todos,
        &mut state.summary_archives,
    ];
    for field in repeated_fields {
        for entry in field.iter_mut() {
            if entry.len() == 32 || entry.is_empty() {
                continue;
            }
            let id = store.put_blob(entry, &[]).await?;
            *entry = id.as_bytes().to_vec();
        }
    }
    for field in [
        &mut state.summary,
        &mut state.plan,
        &mut state.summary_archive,
    ] {
        if let Some(entry) = field.as_mut() {
            if entry.len() != 32 && !entry.is_empty() {
                let id = store.put_blob(entry, &[]).await?;
                *entry = id.as_bytes().to_vec();
            }
        }
    }
    Ok(())
}

/// One `repeated bytes` conversation-state entry: a 32-byte blob reference
/// on server-built checkpoints, or the encoded content inline on states the
/// client assembled itself.
enum StateEntry {
    Reference(BlobId),
    Inline,
}

fn classify_state_entry(raw: &[u8]) -> Result<StateEntry> {
    if raw.len() == 32 {
        Ok(StateEntry::Reference(BlobId::from_bytes(raw)?))
    } else {
        Ok(StateEntry::Inline)
    }
}

/// One prefetched blob, split by which side carries the digest. The captured
/// schema names field 1 `id` / field 2 `value`, but current clients send the
/// payload in field 1 and the digest in field 2; accept either order.
enum Prefetched<'a> {
    /// The 32-byte digest side and the payload side.
    Verified(BlobId, &'a [u8]),
    /// No digest side at all — only the payload.
    Raw(&'a [u8]),
}

fn classify_prefetched(blob: &pb::PreFetchedBlob) -> Result<Option<Prefetched<'_>>> {
    if blob.id.len() == 32 {
        Ok(Some(Prefetched::Verified(
            BlobId::from_bytes(&blob.id)?,
            &blob.value,
        )))
    } else if blob.value.len() == 32 {
        Ok(Some(Prefetched::Verified(
            BlobId::from_bytes(&blob.value)?,
            &blob.id,
        )))
    } else if blob.id.is_empty() && blob.value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Prefetched::Raw(if blob.value.is_empty() {
            &blob.id
        } else {
            &blob.value
        })))
    }
}

#[cfg(test)]
mod inline_lines_tests {
    use super::*;

    #[test]
    fn single_json_value_returns_one_entry() {
        let data = br#"  {"role":"user","content":"hi"}  "#;
        let lines = inline_json_lines(data);
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn newline_delimited_json_splits_per_line() {
        let data = b"{\"role\":\"user\",\"content\":\"one\"}\n{\"role\":\"assistant\",\"content\":\"two\"}\n\n";
        let lines = inline_json_lines(data);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with(b"{"));
        assert!(lines[1].starts_with(b"{"));
    }

    #[test]
    fn embedded_escaped_newlines_stay_inside_one_entry() {
        let data = b"{\"role\":\"user\",\"content\":\"line1\\nline2\"}";
        let lines = inline_json_lines(data);
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn empty_entry_returns_no_lines() {
        assert!(inline_json_lines(b"   \n  ").is_empty());
    }
}

#[cfg(test)]
mod normalize_state_tests {
    use super::*;

    async fn test_store() -> crate::store::Store {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        crate::store::Store::connect(&url).await.unwrap()
    }

    #[tokio::test]
    async fn inline_entries_become_digests_backed_by_the_store() {
        let store = test_store().await;
        let inline = br#"{"role":"user","content":"review context"}"#.to_vec();
        let digest = BlobId::digest(&inline).as_bytes().to_vec();
        let mut state = pb::ConversationStateStructure {
            root_prompt_messages_json: vec![inline.clone()],
            turns: vec![vec![9u8; 28_753]],
            todos: Vec::new(),
            summary: Some(b"summary-json".to_vec()),
            ..Default::default()
        };
        normalize_client_state(&mut state, &store).await.unwrap();
        assert_eq!(state.root_prompt_messages_json, vec![digest.clone()]);
        assert_eq!(state.turns[0].len(), 32);
        assert_eq!(state.summary.as_deref().map(<[u8]>::len), Some(32));
        // The store now backs every reference with the original content.
        let id = BlobId::from_bytes(&state.root_prompt_messages_json[0]).unwrap();
        assert_eq!(store.get_blob(&id).await.unwrap().unwrap(), inline);
    }

    #[tokio::test]
    async fn existing_references_and_empty_entries_are_untouched() {
        let store = test_store().await;
        let reference = BlobId::digest(b"already-stored").as_bytes().to_vec();
        let mut state = pb::ConversationStateStructure {
            root_prompt_messages_json: vec![reference.clone(), Vec::new()],
            ..Default::default()
        };
        normalize_client_state(&mut state, &store).await.unwrap();
        assert_eq!(state.root_prompt_messages_json, vec![reference, Vec::new()]);
    }
}

#[cfg(test)]
mod state_entry_tests {
    use super::*;

    #[test]
    fn thirty_two_byte_entry_is_a_blob_reference() {
        let digest = BlobId::digest(b"payload").as_bytes().to_vec();
        match classify_state_entry(&digest).unwrap() {
            StateEntry::Reference(id) => assert_eq!(id.as_bytes(), digest.as_slice()),
            StateEntry::Inline => panic!("expected Reference"),
        }
    }

    #[test]
    fn inline_json_entry_is_not_a_reference() {
        // Client-built states carry the encoded message directly.
        let inline = br#"{"role":"user","content":"review this diff"}"#;
        assert!(matches!(
            classify_state_entry(inline).unwrap(),
            StateEntry::Inline
        ));
        // The review agent ships multi-KB inline context the same way.
        let large = vec![b'{'; 28_753];
        assert!(matches!(
            classify_state_entry(&large).unwrap(),
            StateEntry::Inline
        ));
    }
}

#[cfg(test)]
mod prefetched_tests {
    use super::*;

    fn blob(id: Vec<u8>, value: Vec<u8>) -> pb::PreFetchedBlob {
        pb::PreFetchedBlob { id, value }
    }

    #[test]
    fn captured_field_order_verifies_against_the_digest() {
        let payload = b"review-diff-payload".to_vec();
        let digest = BlobId::digest(&payload).as_bytes().to_vec();
        match classify_prefetched(&blob(digest.clone(), payload.clone()))
            .unwrap()
            .unwrap()
        {
            Prefetched::Verified(expected, value) => {
                assert_eq!(expected, BlobId::digest(&payload));
                assert_eq!(value, payload.as_slice());
            }
            _ => panic!("expected Verified"),
        }
    }

    #[test]
    fn swapped_field_order_still_verifies() {
        // Current clients: payload in field 1, digest in field 2.
        let payload = vec![7u8; 28_753];
        let digest = BlobId::digest(&payload).as_bytes().to_vec();
        match classify_prefetched(&blob(payload.clone(), digest.clone()))
            .unwrap()
            .unwrap()
        {
            Prefetched::Verified(expected, value) => {
                assert_eq!(expected, BlobId::from_bytes(&digest).unwrap());
                assert_eq!(value, payload.as_slice());
            }
            _ => panic!("expected Verified"),
        }
    }

    #[test]
    fn payload_without_a_digest_side_is_stored_raw() {
        let payload = b"opaque-context".to_vec();
        match classify_prefetched(&blob(payload.clone(), Vec::new()))
            .unwrap()
            .unwrap()
        {
            Prefetched::Raw(value) => assert_eq!(value, payload.as_slice()),
            _ => panic!("expected Raw"),
        }
    }

    #[test]
    fn empty_blob_is_skipped() {
        assert!(classify_prefetched(&blob(Vec::new(), Vec::new()))
            .unwrap()
            .is_none());
    }
}
