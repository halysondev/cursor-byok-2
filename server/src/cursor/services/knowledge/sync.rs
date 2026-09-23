//! Replays the offline journal to upstream and mirrors upstream list state.
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, Method, Request},
};
use prost::Message;

use crate::{api::cursor::proxy, cursor::protocol::connect, Result};

use super::{
    store::{JournalOp, RuleRecord, RuleStore},
    KnowledgeBaseAddRequest, KnowledgeBaseAddResponse, KnowledgeBaseListItem,
    KnowledgeBaseRemoveRequest, KnowledgeBaseRemoveResponse, KnowledgeBaseUpdateRequest,
    KnowledgeBaseUpdateResponse,
};

const ADD_PATH: &str = "/aiserver.v1.AiService/KnowledgeBaseAdd";
const UPDATE_PATH: &str = "/aiserver.v1.AiService/KnowledgeBaseUpdate";
const REMOVE_PATH: &str = "/aiserver.v1.AiService/KnowledgeBaseRemove";

/// Upper bound of explicit upstream rejections for one entry; beyond it the entry is dropped (dead-lettered) so it cannot wedge the rest of the log.
const MAX_REPLAY_REJECTIONS: u32 = 8;

/// Pushes the offline log upstream entry by entry. Returns true when the log is fully
/// drained (upstream is reachable); false when upstream is unreachable, in which case the
/// remaining log is kept and the caller should fall back to local.
pub async fn replay(
    upstream: &proxy::CursorProxy,
    headers: &HeaderMap,
    store: &RuleStore,
) -> Result<bool> {
    while let Some(entry) = store.journal_front()? {
        let outcome = match entry.op {
            JournalOp::Add => replay_add(upstream, headers, store, &entry.id).await?,
            JournalOp::Update => replay_update(upstream, headers, store, &entry.id).await?,
            JournalOp::Remove => replay_remove(upstream, headers, store, &entry.id).await?,
        };
        match outcome {
            ReplayOutcome::Advanced => {}
            ReplayOutcome::Unreachable => return Ok(false),
            ReplayOutcome::Rejected => {
                let attempts = store.record_rejection()?;
                if attempts < MAX_REPLAY_REJECTIONS {
                    tracing::warn!(
                        id = entry.id,
                        op = ?entry.op,
                        attempts,
                        "rules upstream declined replayed entry; retaining journal entry"
                    );
                    return Ok(false);
                }
                tracing::error!(
                    id = entry.id,
                    op = ?entry.op,
                    attempts,
                    "rules journal entry permanently rejected by upstream; dropping it"
                );
                store.pop_journal()?;
            }
        }
    }
    Ok(true)
}

/// Overwrite the local mirror with the complete list returned upstream. Only call once the log has been drained.
pub fn mirror(store: &RuleStore, items: Vec<KnowledgeBaseListItem>) -> Result<()> {
    let records = items
        .into_iter()
        .map(|item| RuleRecord {
            id: item.id,
            knowledge: item.knowledge,
            title: item.title,
            created_at: item.created_at,
            is_generated: item.is_generated,
            git_origin: String::new(),
        })
        .collect::<Vec<_>>();
    store.replace_all(&records)
}

/// Replay result of a single log entry.
enum ReplayOutcome {
    /// Synced: pop the entry and continue with the rest of the log.
    Advanced,
    /// Upstream unreachable or response unreadable: keep the log and stop this round.
    Unreachable,
    /// Explicitly rejected upstream: count the rejection; drop the entry once the cap is reached.
    Rejected,
}

async fn replay_add(
    upstream: &proxy::CursorProxy,
    headers: &HeaderMap,
    store: &RuleStore,
    id: &str,
) -> Result<ReplayOutcome> {
    let Some(record) = store.get(id)? else {
        // The rule file no longer exists (deleted by hand, etc.), so the log entry is void.
        store.pop_journal()?;
        return Ok(ReplayOutcome::Advanced);
    };
    let message = KnowledgeBaseAddRequest {
        knowledge: record.knowledge,
        title: record.title,
        git_origin: record.git_origin,
        composer_id: None,
    };
    let body = match send(upstream, headers, ADD_PATH, &message).await {
        SendOutcome::Ok(body) => body,
        SendOutcome::Rejected => return Ok(ReplayOutcome::Rejected),
        SendOutcome::Unreachable => return Ok(ReplayOutcome::Unreachable),
    };
    let Ok(reply) = connect::decode_unary::<KnowledgeBaseAddResponse>(&body) else {
        return Ok(ReplayOutcome::Unreachable);
    };
    if !reply.success || reply.id.is_empty() {
        return Ok(ReplayOutcome::Rejected);
    }
    store.promote_and_pop(id, &reply.id)?;
    tracing::info!(
        local_id = id,
        upstream_id = reply.id,
        "replayed offline rule add to upstream"
    );
    Ok(ReplayOutcome::Advanced)
}

async fn replay_update(
    upstream: &proxy::CursorProxy,
    headers: &HeaderMap,
    store: &RuleStore,
    id: &str,
) -> Result<ReplayOutcome> {
    let Some(record) = store.get(id)? else {
        store.pop_journal()?;
        return Ok(ReplayOutcome::Advanced);
    };
    let message = KnowledgeBaseUpdateRequest {
        id: id.into(),
        knowledge: record.knowledge,
        title: record.title,
    };
    let body = match send(upstream, headers, UPDATE_PATH, &message).await {
        SendOutcome::Ok(body) => body,
        SendOutcome::Rejected => return Ok(ReplayOutcome::Rejected),
        SendOutcome::Unreachable => return Ok(ReplayOutcome::Unreachable),
    };
    let Ok(reply) = connect::decode_unary::<KnowledgeBaseUpdateResponse>(&body) else {
        return Ok(ReplayOutcome::Unreachable);
    };
    if !reply.success {
        return Ok(ReplayOutcome::Rejected);
    }
    store.pop_journal()?;
    Ok(ReplayOutcome::Advanced)
}

async fn replay_remove(
    upstream: &proxy::CursorProxy,
    headers: &HeaderMap,
    store: &RuleStore,
    id: &str,
) -> Result<ReplayOutcome> {
    let message = KnowledgeBaseRemoveRequest { id: id.into() };
    let body = match send(upstream, headers, REMOVE_PATH, &message).await {
        SendOutcome::Ok(body) => body,
        SendOutcome::Rejected => return Ok(ReplayOutcome::Rejected),
        SendOutcome::Unreachable => return Ok(ReplayOutcome::Unreachable),
    };
    let Ok(reply) = connect::decode_unary::<KnowledgeBaseRemoveResponse>(&body) else {
        return Ok(ReplayOutcome::Unreachable);
    };
    if !reply.success {
        return Ok(ReplayOutcome::Rejected);
    }
    store.pop_journal()?;
    Ok(ReplayOutcome::Advanced)
}

enum SendOutcome {
    Ok(Bytes),
    Rejected,
    Unreachable,
}

/// Issues one unary RPC upstream using the current request's headers as the template.
async fn send(
    upstream: &proxy::CursorProxy,
    template: &HeaderMap,
    path: &str,
    message: &impl Message,
) -> SendOutcome {
    let mut headers = template.clone();
    // The upstream URL header in the template points at the original RPC path; it must be removed to hit the replay path.
    headers.remove(proxy::UPSTREAM_URL_HEADER);
    headers.remove(header::CONTENT_LENGTH);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/proto"),
    );
    let mut request = Request::new(Body::from(message.encode_to_vec()));
    *request.method_mut() = Method::POST;
    *request.uri_mut() = path.parse().expect("replay path is a valid URI");
    *request.headers_mut() = headers;

    match proxy::forward_buffered(upstream, request).await {
        Ok(response) if response.status.is_success() => SendOutcome::Ok(response.body),
        Ok(response) => {
            tracing::warn!(path, status = %response.status, "rules journal replay rejected by upstream");
            SendOutcome::Rejected
        }
        Err(error) => {
            tracing::warn!(path, %error, "rules journal replay cannot reach upstream");
            SendOutcome::Unreachable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{network::NetworkClients, store::Store};
    use axum::{http::Response, routing::post, Router};

    async fn proxy_with_reply(path: &'static str, body: Vec<u8>) -> proxy::CursorProxy {
        let app = Router::new().route(
            path,
            post(move || {
                let body = body.clone();
                async move { Response::new(Body::from(body)) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let store = Store::connect("sqlite::memory:").await.unwrap();
        proxy::CursorProxy::for_test(NetworkClients::new(store), format!("http://{address}"))
    }

    fn record(id: &str) -> RuleRecord {
        RuleRecord {
            id: id.into(),
            knowledge: "knowledge".into(),
            title: "title".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            is_generated: false,
            git_origin: String::new(),
        }
    }

    #[tokio::test]
    async fn rejected_add_is_retained() {
        let root = tempfile::tempdir().unwrap();
        let store = RuleStore::open(root.path().join("rules")).unwrap();
        store.upsert_and_record_add(&record("local-a")).unwrap();
        let upstream = proxy_with_reply(
            ADD_PATH,
            KnowledgeBaseAddResponse {
                success: false,
                id: String::new(),
            }
            .encode_to_vec(),
        )
        .await;

        assert!(!replay(&upstream, &HeaderMap::new(), &store).await.unwrap());
        let front = store.journal_front().unwrap().unwrap();
        assert_eq!(front.op, JournalOp::Add);
        assert_eq!(front.attempts, 1);
    }

    #[tokio::test]
    async fn rejected_update_is_retained() {
        let root = tempfile::tempdir().unwrap();
        let store = RuleStore::open(root.path().join("rules")).unwrap();
        store.upsert_and_record_update(&record("42")).unwrap();
        let upstream = proxy_with_reply(
            UPDATE_PATH,
            KnowledgeBaseUpdateResponse { success: false }.encode_to_vec(),
        )
        .await;

        assert!(!replay(&upstream, &HeaderMap::new(), &store).await.unwrap());
        assert_eq!(
            store.journal_front().unwrap().unwrap().op,
            JournalOp::Update
        );
    }

    #[tokio::test]
    async fn rejected_remove_is_retained() {
        let root = tempfile::tempdir().unwrap();
        let store = RuleStore::open(root.path().join("rules")).unwrap();
        store.upsert(&record("42")).unwrap();
        store.remove_and_record("42").unwrap();
        let upstream = proxy_with_reply(
            REMOVE_PATH,
            KnowledgeBaseRemoveResponse { success: false }.encode_to_vec(),
        )
        .await;

        assert!(!replay(&upstream, &HeaderMap::new(), &store).await.unwrap());
        assert_eq!(
            store.journal_front().unwrap().unwrap().op,
            JournalOp::Remove
        );
    }

    #[tokio::test]
    async fn permanently_rejected_entry_is_dropped_after_the_retry_cap() {
        let root = tempfile::tempdir().unwrap();
        let store = RuleStore::open(root.path().join("rules")).unwrap();
        store.upsert_and_record_add(&record("local-a")).unwrap();
        store.upsert_and_record_add(&record("local-b")).unwrap();
        let add_rejection = proxy_with_reply(
            ADD_PATH,
            KnowledgeBaseAddResponse {
                success: false,
                id: String::new(),
            }
            .encode_to_vec(),
        )
        .await;

        for attempt in 1..MAX_REPLAY_REJECTIONS {
            assert!(!replay(&add_rejection, &HeaderMap::new(), &store)
                .await
                .unwrap());
            assert_eq!(
                store.journal_front().unwrap().unwrap().attempts,
                attempt,
                "attempt {attempt} must be retained"
            );
        }
        // Cap reached: the head entry is dropped and replay continues with the following entries.
        assert!(!replay(&add_rejection, &HeaderMap::new(), &store)
            .await
            .unwrap());
        let front = store.journal_front().unwrap().unwrap();
        assert_eq!(front.id, "local-b");
        assert_eq!(front.attempts, 1);
    }
}
