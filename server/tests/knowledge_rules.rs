//! Verifies KnowledgeBase rules CRUD falls back to local markdown storage
//! when the Cursor upstream is unreachable or rejects the request.
mod support;

use axum::{
    body::{to_bytes, Body},
    extract::Extension,
    http::{header, Request, Response},
};
use cursor_server::{
    api::cursor::proxy::CursorProxy,
    cursor::services::knowledge::{self, KnowledgeService},
};
use prost::Message;
use support::temp_store;

// Test-side mirror message definitions that double as a wire-compatibility check.
#[derive(Clone, PartialEq, Message)]
struct AddRequest {
    #[prost(string, tag = "1")]
    knowledge: String,
    #[prost(string, tag = "2")]
    title: String,
    #[prost(string, tag = "3")]
    git_origin: String,
}

#[derive(Clone, PartialEq, Message)]
struct AddResponse {
    #[prost(bool, tag = "1")]
    success: bool,
    #[prost(string, tag = "2")]
    id: String,
}

#[derive(Clone, PartialEq, Message)]
struct ListRequest {
    #[prost(int32, optional, tag = "1")]
    limit: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
struct ListResponse {
    #[prost(bool, tag = "1")]
    success: bool,
    #[prost(message, repeated, tag = "2")]
    all_results: Vec<ListItem>,
}

#[derive(Clone, PartialEq, Message)]
struct ListItem {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    knowledge: String,
    #[prost(string, tag = "3")]
    title: String,
    #[prost(string, tag = "4")]
    created_at: String,
    #[prost(bool, tag = "5")]
    is_generated: bool,
}

#[derive(Clone, PartialEq, Message)]
struct UpdateRequest {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    knowledge: String,
    #[prost(string, tag = "3")]
    title: String,
}

#[derive(Clone, PartialEq, Message)]
struct UpdateResponse {
    #[prost(bool, tag = "1")]
    success: bool,
}

#[derive(Clone, PartialEq, Message)]
struct RemoveRequest {
    #[prost(string, tag = "1")]
    id: String,
}

#[derive(Clone, PartialEq, Message)]
struct RemoveResponse {
    #[prost(bool, tag = "1")]
    success: bool,
}

fn proto_request(message: &impl Message) -> Request<Body> {
    Request::post("/test")
        .header(header::CONTENT_TYPE, "application/proto")
        .body(Body::from(message.encode_to_vec()))
        .unwrap()
}

async fn decode<M: Message + Default>(response: Response<Body>) -> M {
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    M::decode(body.as_ref()).unwrap()
}

/// Requests without credentials always fail upstream (network error or 401), so all four
/// endpoints exercise the local fallback: md persistence, offline-log compaction, and CRUD.
#[tokio::test]
async fn offline_crud_round_trip_persists_markdown() {
    let (_store_dir, store) = temp_store().await;
    let upstream = CursorProxy::cursor(cursor_server::network::NetworkClients::new(store));
    let rules_dir = tempfile::tempdir().unwrap();
    let rules_root = rules_dir.path().join("rules");
    let service = KnowledgeService::with_root(rules_root.clone()).unwrap();

    // Add: returns a local temporary id and writes the md file to disk.
    let response = knowledge::add(
        Extension(upstream.clone()),
        Extension(service.clone()),
        proto_request(&AddRequest {
            knowledge: "always answer in haiku".into(),
            title: "haiku rule".into(),
            git_origin: String::new(),
        }),
    )
    .await
    .unwrap();
    let added: AddResponse = decode(response).await;
    assert!(added.success);
    assert!(
        added.id.starts_with("local-"),
        "offline add uses a local id"
    );
    let markdown = rules_root.join(format!("{}.md", added.id));
    assert_eq!(
        std::fs::read_to_string(&markdown).unwrap(),
        "always answer in haiku"
    );

    // List: the local cache returns the rule just written.
    let response = knowledge::list(
        Extension(upstream.clone()),
        Extension(service.clone()),
        proto_request(&ListRequest { limit: Some(100) }),
    )
    .await
    .unwrap();
    let listed: ListResponse = decode(response).await;
    assert!(listed.success);
    assert_eq!(listed.all_results.len(), 1);
    assert_eq!(listed.all_results[0].id, added.id);
    assert_eq!(listed.all_results[0].title, "haiku rule");

    // Update: content and title are updated in both the md file and metadata.
    let response = knowledge::update(
        Extension(upstream.clone()),
        Extension(service.clone()),
        proto_request(&UpdateRequest {
            id: added.id.clone(),
            knowledge: "always answer in sonnets".into(),
            title: "sonnet rule".into(),
        }),
    )
    .await
    .unwrap();
    let updated: UpdateResponse = decode(response).await;
    assert!(updated.success);
    assert_eq!(
        std::fs::read_to_string(&markdown).unwrap(),
        "always answer in sonnets"
    );

    // Remove: the file is deleted and the list is empty.
    let response = knowledge::remove(
        Extension(upstream.clone()),
        Extension(service.clone()),
        proto_request(&RemoveRequest {
            id: added.id.clone(),
        }),
    )
    .await
    .unwrap();
    let removed: RemoveResponse = decode(response).await;
    assert!(removed.success);
    assert!(!markdown.exists());

    let response = knowledge::list(
        Extension(upstream),
        Extension(service),
        proto_request(&ListRequest { limit: Some(100) }),
    )
    .await
    .unwrap();
    let listed: ListResponse = decode(response).await;
    assert!(listed.all_results.is_empty());
}

#[tokio::test]
async fn updating_missing_rule_reports_failure() {
    let (_store_dir, store) = temp_store().await;
    let upstream = CursorProxy::cursor(cursor_server::network::NetworkClients::new(store));
    let rules_dir = tempfile::tempdir().unwrap();
    let service = KnowledgeService::with_root(rules_dir.path().join("rules")).unwrap();

    let response = knowledge::update(
        Extension(upstream),
        Extension(service),
        proto_request(&UpdateRequest {
            id: "17353272".into(),
            knowledge: "anything".into(),
            title: "anything".into(),
        }),
    )
    .await
    .unwrap();
    let updated: UpdateResponse = decode(response).await;
    assert!(!updated.success);
}

#[derive(Clone, PartialEq, Message)]
struct FetchRelevantKnowledgeForConversationRequest {
    #[prost(string, tag = "1")]
    request_id: String,
    #[prost(int32, optional, tag = "4")]
    limit: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
struct FetchRelevantKnowledgeForConversationResponse {
    #[prost(message, repeated, tag = "1")]
    knowledge_items: Vec<KnowledgeItem>,
}

#[derive(Clone, PartialEq, Message)]
struct KnowledgeItem {
    #[prost(string, tag = "1")]
    title: String,
    #[prost(string, tag = "2")]
    knowledge: String,
    #[prost(string, tag = "3")]
    knowledge_id: String,
    #[prost(bool, tag = "4")]
    is_generated: bool,
}

/// Rules are global across git origins: whatever the request's git_origin is,
/// every stored rule is returned (subject to the requested limit).
#[tokio::test]
async fn relevant_knowledge_is_global_across_git_origins() {
    let (_store_dir, store) = temp_store().await;
    let upstream = CursorProxy::cursor(cursor_server::network::NetworkClients::new(store));
    let rules_dir = tempfile::tempdir().unwrap();
    let service = KnowledgeService::with_root(rules_dir.path().join("rules")).unwrap();

    for knowledge in ["always write tests", "keep modules small"] {
        let response = knowledge::add(
            Extension(upstream.clone()),
            Extension(service.clone()),
            proto_request(&AddRequest {
                knowledge: knowledge.into(),
                title: knowledge.into(),
                git_origin: String::new(),
            }),
        )
        .await
        .unwrap();
        let added: AddResponse = decode(response).await;
        assert!(added.success);
    }

    let response = knowledge::relevant(
        Extension(service.clone()),
        proto_request(&FetchRelevantKnowledgeForConversationRequest {
            request_id: "req-1".into(),
            limit: Some(10),
        }),
    )
    .await
    .unwrap();
    let relevant: FetchRelevantKnowledgeForConversationResponse = decode(response).await;
    let ids: Vec<_> = relevant
        .knowledge_items
        .iter()
        .map(|item| item.knowledge_id.as_str())
        .collect();
    assert_eq!(ids.len(), 2);
    // All items carry the same content the rules were added with.
    assert!(relevant
        .knowledge_items
        .iter()
        .any(|item| item.knowledge == "always write tests"));
    assert!(relevant
        .knowledge_items
        .iter()
        .any(|item| item.knowledge == "keep modules small"));

    // A non-negative limit truncates.
    let response = knowledge::relevant(
        Extension(service),
        proto_request(&FetchRelevantKnowledgeForConversationRequest {
            request_id: "req-2".into(),
            limit: Some(0),
        }),
    )
    .await
    .unwrap();
    let relevant: FetchRelevantKnowledgeForConversationResponse = decode(response).await;
    assert!(relevant.knowledge_items.is_empty());
}

/// The compiled prompt appends the stored global rules as a
/// `<shared_user_rules>` section; with no rules the prompt is unchanged.
#[tokio::test]
async fn prompt_compiler_appends_the_global_rules_section() {
    use cursor_server::cursor::prompting::{Mode, PromptAssets, PromptCompiler};

    let rules_dir = tempfile::tempdir().unwrap();
    let bare = PromptCompiler::new(PromptAssets::embedded().unwrap());
    let compiler = PromptCompiler::new(PromptAssets::embedded().unwrap())
        .with_global_rules_dir(rules_dir.path().join("global"));

    let (_store_dir, store) = temp_store().await;
    let upstream = CursorProxy::cursor(cursor_server::network::NetworkClients::new(store));
    // The global rules live in the rules service's `rules/global` subtree —
    // the same directory the compiler reads at prompt-compile time.
    let service = KnowledgeService::with_root(rules_dir.path().join("global")).unwrap();
    knowledge::add(
        Extension(upstream),
        Extension(service),
        proto_request(&AddRequest {
            knowledge: "always answer in haiku".into(),
            title: "haiku".into(),
            git_origin: String::new(),
        }),
    )
    .await
    .unwrap();

    let model = cursor_server::model::ModelSpec::new("test-model");
    let plain = bare.prompt_spec(Mode::Agent, &model, &[], false).unwrap();
    let with_rules = compiler
        .prompt_spec(Mode::Agent, &model, &[], false)
        .unwrap();

    assert!(!plain.instructions.contains("<shared_user_rules"));
    assert!(with_rules.instructions.contains("<shared_user_rules"));
    assert!(with_rules.instructions.contains("always answer in haiku"));
    assert!(with_rules
        .instructions
        .strip_prefix(plain.instructions.as_str())
        .is_some());
}
