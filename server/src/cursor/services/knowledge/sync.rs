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

/// Pushes the offline log upstream entry by entry. Returns true when the log is fully
/// drained (upstream is reachable); false when upstream is unreachable, in which case the
/// remaining log is kept and the caller should fall back to local.
pub async fn replay(
    upstream: &proxy::CursorProxy,
    headers: &HeaderMap,
    store: &RuleStore,
) -> Result<bool> {
    while let Some(entry) = store.journal_front()? {
        let advanced = match entry.op {
            JournalOp::Add => replay_add(upstream, headers, store, &entry.id).await?,
            JournalOp::Update => replay_update(upstream, headers, store, &entry.id).await?,
            JournalOp::Remove => replay_remove(upstream, headers, store, &entry.id).await?,
        };
        if !advanced {
            return Ok(false);
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

async fn replay_add(
    upstream: &proxy::CursorProxy,
    headers: &HeaderMap,
    store: &RuleStore,
    id: &str,
) -> Result<bool> {
    let Some(record) = store.get(id)? else {
        // The rule file no longer exists (deleted by hand, etc.), so the log entry is void.
        store.pop_journal()?;
        return Ok(true);
    };
    let message = KnowledgeBaseAddRequest {
        knowledge: record.knowledge,
        title: record.title,
        git_origin: record.git_origin,
        composer_id: None,
    };
    let Some(body) = send(upstream, headers, ADD_PATH, &message).await else {
        return Ok(false);
    };
    let Ok(reply) = connect::decode_unary::<KnowledgeBaseAddResponse>(&body) else {
        return Ok(false);
    };
    if !reply.success || reply.id.is_empty() {
        tracing::warn!(
            id,
            "rules upstream declined replayed add; dropping journal entry"
        );
        store.pop_journal()?;
        return Ok(true);
    }
    store.promote(id, &reply.id)?;
    store.pop_journal()?;
    tracing::info!(
        local_id = id,
        upstream_id = reply.id,
        "replayed offline rule add to upstream"
    );
    Ok(true)
}

async fn replay_update(
    upstream: &proxy::CursorProxy,
    headers: &HeaderMap,
    store: &RuleStore,
    id: &str,
) -> Result<bool> {
    let Some(record) = store.get(id)? else {
        store.pop_journal()?;
        return Ok(true);
    };
    let message = KnowledgeBaseUpdateRequest {
        id: id.into(),
        knowledge: record.knowledge,
        title: record.title,
    };
    let Some(body) = send(upstream, headers, UPDATE_PATH, &message).await else {
        return Ok(false);
    };
    let Ok(reply) = connect::decode_unary::<KnowledgeBaseUpdateResponse>(&body) else {
        return Ok(false);
    };
    if !reply.success {
        tracing::warn!(
            id,
            "rules upstream declined replayed update; dropping journal entry"
        );
    }
    store.pop_journal()?;
    Ok(true)
}

async fn replay_remove(
    upstream: &proxy::CursorProxy,
    headers: &HeaderMap,
    store: &RuleStore,
    id: &str,
) -> Result<bool> {
    let message = KnowledgeBaseRemoveRequest { id: id.into() };
    let Some(body) = send(upstream, headers, REMOVE_PATH, &message).await else {
        return Ok(false);
    };
    let Ok(reply) = connect::decode_unary::<KnowledgeBaseRemoveResponse>(&body) else {
        return Ok(false);
    };
    if !reply.success {
        tracing::warn!(
            id,
            "rules upstream declined replayed remove; dropping journal entry"
        );
    }
    store.pop_journal()?;
    Ok(true)
}

/// Issues one unary RPC upstream using the current request's headers as the template.
/// Returns the response body on success (2xx); returns None when unreachable or rejected,
/// and the caller keeps the log.
async fn send(
    upstream: &proxy::CursorProxy,
    template: &HeaderMap,
    path: &str,
    message: &impl Message,
) -> Option<Bytes> {
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
        Ok(response) if response.status.is_success() => Some(response.body),
        Ok(response) => {
            tracing::warn!(path, status = %response.status, "rules journal replay rejected by upstream");
            None
        }
        Err(error) => {
            tracing::warn!(path, %error, "rules journal replay cannot reach upstream");
            None
        }
    }
}
