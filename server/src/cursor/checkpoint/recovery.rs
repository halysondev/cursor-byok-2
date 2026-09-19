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
        for (ordinal, raw_id) in state.root_prompt_messages_json.iter().enumerate() {
            let id = BlobId::from_bytes(raw_id)?;
            let Some(data) = self.sync.get(&id).await? else {
                return Err(Error::Protocol(format!(
                    "missing message Blob {}",
                    id.to_base64()
                )));
            };
            messages.push(messages::decode(
                &data,
                format!("cursor-root:{}:{ordinal}", id.to_base64()),
            )?);
        }
        Ok(messages)
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
