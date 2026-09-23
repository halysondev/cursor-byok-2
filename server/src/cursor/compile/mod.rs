//! Compiles Cursor requests and actions into provider-independent Run inputs.

mod action;
mod break_messages;
mod context;
mod images;
mod insert_messages;
mod model;
mod run;

pub use action::*;
pub(crate) use break_messages::{compile_injection, compile_user_message_action, RuntimeAction};
pub use run::*;

/// Test entry point: projects a batch of background completion notifications and returns whether any completion items remain to project.
#[cfg(test)]
pub(crate) fn project_background_completion_for_test(
    action: &crate::cursor::protocol::proto::agent::v1::BackgroundTaskCompletionAction,
    suppressed: &std::collections::HashSet<String>,
) -> crate::Result<bool> {
    let projection = insert_messages::project(
        action,
        crate::cursor::protocol::proto::agent::v1::AgentMode::Agent as i32,
        suppressed,
    )?;
    Ok(projection.is_some())
}
