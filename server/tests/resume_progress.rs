//! Verifies ResumeAction request-context consumption and the hidden
//! continuation prompt that keeps a resumed run making progress.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{sync::Arc, time::Duration};

use cursor_server::{
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        protocol::{connect, proto::agent::v1 as pb},
        TransportCommand, TransportRegistry,
    },
    model::{ContentPart, ProjectedContent, Role},
    provider::{FinishReason, ModelEvent},
};
use prost::Message;

#[tokio::test]
async fn resume_action_context_and_continuation_reach_the_next_model_call() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(text_response("model-initial", "initial response"));
    provider.push(text_response("model-resumed", "continued response"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );

    let first = registry.get_or_create("initial-run").await.unwrap();
    let mut first_output = first.subscribe();
    first
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(start_request()),
        })
        .await
        .unwrap();
    drive_to_end(&first, &mut first_output, &provider, 1).await;
    first.disconnect().await;

    // A text-only first run leaves no pending tool round, so the resume must
    // carry the hidden continuation prompt.
    let resumed = registry.get_or_create("resume-run").await.unwrap();
    let mut resumed_output = resumed.subscribe();
    resumed
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(resume_request()),
        })
        .await
        .unwrap();
    drive_to_end(&resumed, &mut resumed_output, &provider, 2).await;

    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let history = &requests[1].history;
    assert_eq!(
        history
            .iter()
            .filter(|message| message.message_id.starts_with("request-context:resume:"))
            .count(),
        1,
        "the changed ResumeAction context must be appended to history"
    );
    let texts = history
        .iter()
        .filter_map(projected_text)
        .collect::<Vec<_>>();
    assert!(
        texts.iter().any(|text| text.contains("Shell: pwsh")),
        "the resumed request context must be compiled into history"
    );
    let last = history.last().expect("resume history must not be empty");
    assert_eq!(last.role, Role::User);
    assert_eq!(last.message_id, "resume-prompt:resume-run");
    assert!(projected_text(last).as_deref().is_some_and(|text| {
        text.contains("<resume>") && text.contains("make concrete progress")
    }));
}

fn text_response(model_call_id: &str, text: &str) -> Vec<ModelEvent> {
    vec![
        ModelEvent::Start {
            model_call_id: model_call_id.into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta(text.into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]
}

fn start_request() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "perform the task".into(),
                                message_id: "user-1".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            request_context: Some(request_context("bash")),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("resume-progress-conversation".into()),
                run_id: Some("initial-wire-run".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

fn resume_request() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::ResumeAction(
                        pb::ResumeAction {
                            request_context: Some(request_context("pwsh")),
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("resume-progress-conversation".into()),
                run_id: Some("resume-wire-run".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

fn request_context(shell: &str) -> pb::RequestContext {
    pb::RequestContext {
        env: Some(pb::RequestContextEnv {
            os_version: "windows".into(),
            workspace_paths: vec!["C:/workspace".into()],
            shell: shell.into(),
            terminals_folder: "C:/terminals".into(),
            agent_transcripts_folder: "C:/transcripts".into(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn projected_text(message: &cursor_server::model::ProjectedMessage) -> Option<String> {
    let ProjectedContent::Parts(parts) = &message.content else {
        return None;
    };
    Some(
        parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Drain the output stream, acknowledging blob requests, until the expected
/// model call has been made and the follow-up traffic goes quiet.
async fn drive_to_end(
    handle: &cursor_server::cursor::TransportHandle,
    output: &mut tokio::sync::mpsc::UnboundedReceiver<bytes::Bytes>,
    provider: &fake_provider::FakeProvider,
    expected_requests: usize,
) {
    let mut seqno = 1;
    loop {
        let wait = if provider.requests().len() >= expected_requests {
            Duration::from_millis(300)
        } else {
            Duration::from_secs(10)
        };
        let frame = match tokio::time::timeout(wait, output.recv()).await {
            Ok(Some(frame)) => frame,
            _ => break,
        };
        let (_, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::KvServerMessage(kv)) = server.message {
            handle
                .command(TransportCommand::Append {
                    seqno,
                    message: Box::new(pb::AgentClientMessage {
                        message: Some(pb::agent_client_message::Message::KvClientMessage(
                            pb::KvClientMessage {
                                id: kv.id,
                                message: Some(pb::kv_client_message::Message::SetBlobResult(
                                    pb::SetBlobResult { error: None },
                                )),
                            },
                        )),
                    }),
                })
                .await
                .unwrap();
            seqno += 1;
        }
    }
}
