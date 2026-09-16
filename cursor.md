
## Full directory tree

```text
server/
├── src/                                        # ≈36,000 lines; all server business code
│   ├── app.rs                                  # ≈180 lines; dependency assembly and service startup
│   ├── config.rs                               # ≈180 lines; process configuration
│   ├── error.rs                                # ≈150 lines; unified errors
│   ├── network.rs                              # ≈100 lines; shared network configuration
│   │
│   ├── bin/                                    # ≈100 lines; executable entry point
│   │   └── cursor-server.rs                    # ≈100 lines; starts the service
│   │
│   ├── api/                                    # ≈1,500 lines; HTTP/Connect API
│   │   ├── mod.rs                              # ≈20 lines; module exports
│   │   ├── router.rs                           # ≈100 lines; top-level router
│   │   └── cursor/                             # ≈1,350 lines; Cursor API
│   │       ├── mod.rs                          # ≈20 lines; Cursor routes
│   │       ├── bidi.rs                         # ≈250 lines; upstream requests
│   │       ├── run_sse.rs                      # ≈300 lines; downstream subscription
│   │       ├── handlers.rs                     # ≈450 lines; other Cursor APIs
│   │       └── proxy.rs                        # ≈330 lines; local/official service selection
│   │
│   ├── cursor/                                 # ≈18,000 lines; Cursor Agent adaptation layer
│   │   ├── mod.rs                              # ≈40 lines; public exports
│   │   │
│   │   ├── transport/                          # ≈800 lines; request_id bidirectional channel
│   │   │   ├── mod.rs                          # ≈20 lines; module exports
│   │   │   ├── registry.rs                     # ≈220 lines; request_id → TransportHandle
│   │   │   ├── handle.rs                       # ≈200 lines; input, subscription, and terminal states
│   │   │   ├── inbox.rs                        # ≈70 lines; append_seqno ordering
│   │   │   └── output.rs                       # ≈290 lines; cache, broadcast, replay, close
│   │   │
│   │   ├── conversation/                       # ≈1,600 lines; Conversation run coordination
│   │   │   ├── mod.rs                          # ≈30 lines; public types
│   │   │   ├── registry.rs                     # ≈220 lines; conversation_id → Runtime
│   │   │   ├── runtime.rs                      # ≈500 lines; sole owner of current_run
│   │   │   ├── command.rs                      # ≈120 lines; Start/Action/Cancel/Disconnect
│   │   │   ├── delivery.rs                     # ≈280 lines; Ignore/Insert/Break
│   │   │   ├── pending.rs                      # ≈150 lines; messages pending at Run boundaries
│   │   │   └── output.rs                       # ≈300 lines; RunEvent downstream and Step records
│   │   │
│   │   ├── compile/                            # ≈2,700 lines; Cursor input compilation
│   │   │   ├── mod.rs                          # ≈30 lines; unified entry
│   │   │   ├── run.rs                          # ≈650 lines; RunRequest → PreparedRun
│   │   │   ├── context.rs                      # ≈650 lines; rules/skills/MCP/environment
│   │   │   ├── action.rs                       # ≈250 lines; Action classification and routing
│   │   │   ├── insert_messages.rs              # ≈400 lines; non-interrupting messages
│   │   │   ├── break_messages.rs               # ≈400 lines; messages that interrupt the current cycle
│   │   │   ├── images.rs                       # ≈100 lines; images and Blobs
│   │   │   └── model.rs                        # ≈220 lines; Cursor model → Provider model
│   │   │
│   │   ├── checkpoint/                         # ≈2,200 lines; Conversation persistence and recovery
│   │   │   ├── mod.rs                          # ≈30 lines; public interface
│   │   │   ├── builder.rs                      # ≈280 lines; builds Checkpoints
│   │   │   ├── steps.rs                        # ≈120 lines; cache for steps not yet persisted
│   │   │   ├── turns.rs                        # ≈150 lines; Conversation turns
│   │   │   ├── roots.rs                        # ≈150 lines; stable root messages
│   │   │   ├── recovery.rs                     # ≈100 lines; restores Conversations
│   │   │   ├── summary.rs                      # ≈120 lines; compaction summaries
│   │   │   ├── derived.rs                      # ≈220 lines; derived state such as Todo/Plan
│   │   │   ├── worker.rs                       # ≈250 lines; async persistence and barrier
│   │   │   └── messages/                       # ≈800 lines; Message codec
│   │   │       ├── mod.rs                      # ≈20 lines; unified entry
│   │   │       ├── decode.rs                   # ≈250 lines; Checkpoint → Message
│   │   │       ├── encode.rs                   # ≈280 lines; Message → Checkpoint
│   │   │       └── tests.rs                    # ≈250 lines; stability tests
│   │   │
│   │   ├── tools/                              # ≈6,500 lines; extensible Tool system
│   │   │   ├── mod.rs                          # ≈180 lines; public types and registration
│   │   │   ├── registry.rs                     # ≈180 lines; Tool definitions
│   │   │   ├── runtime.rs                      # ≈420 lines; run state and cancellation
│   │   │   ├── stream.rs                       # ≈350 lines; streaming arguments
│   │   │   ├── edit.rs                         # ≈340 lines; edit state
│   │   │   ├── schedule.rs                     # ≈100 lines; background task scheduling
│   │   │   ├── compat.rs                       # ≈150 lines; compatibility tool conversion
│   │   │   │
│   │   │   ├── codec/                          # ≈1,750 lines; Tool Wire Protocol
│   │   │   │   ├── mod.rs                      # ≈20 lines; module exports
│   │   │   │   ├── request.rs                  # ≈520 lines; execution request encoding
│   │   │   │   ├── response.rs                 # ≈360 lines; execution response encoding
│   │   │   │   ├── query.rs                    # ≈250 lines; InteractionQuery
│   │   │   │   └── render.rs                   # ≈600 lines; Cursor Tool cards
│   │   │   │
│   │   │   ├── tool_call_dispatch/             # ≈700 lines; ToolCall dispatch
│   │   │   │   ├── mod.rs                      # ≈260 lines; main Dispatcher
│   │   │   │   ├── exec.rs                     # ≈80 lines; command execution
│   │   │   │   ├── edit.rs                     # ≈40 lines; edit calls
│   │   │   │   ├── interaction.rs              # ≈260 lines; user interaction
│   │   │   │   ├── local.rs                    # ≈30 lines; local tools
│   │   │   │   └── search.rs                   # ≈40 lines; search tools
│   │   │   │
│   │   │   └── tool_call_result/               # ≈3,000 lines; ToolResult consumption
│   │   │       ├── mod.rs                      # ≈180 lines; unified results
│   │   │       ├── gate.rs                     # ≈850 lines; completion correlation and gating
│   │   │       ├── interaction.rs              # ≈450 lines; user interaction results
│   │   │       ├── local.rs                    # ≈220 lines; local tool results
│   │   │       ├── mcp.rs                      # ≈80 lines; MCP results
│   │   │       ├── mcp_state.rs                # ≈150 lines; MCP state
│   │   │       ├── search.rs                   # ≈150 lines; search results
│   │   │       └── exec/                       # ≈920 lines; command execution results
│   │   │           ├── mod.rs                   # ≈180 lines; execution result entry
│   │   │           ├── output.rs                # ≈500 lines; output handling
│   │   │           └── render.rs                # ≈240 lines; result rendering
│   │   │
│   │   ├── protocol/                           # ≈600 lines; non-Tool Wire Protocol
│   │   │   ├── mod.rs                          # ≈20 lines; module exports
│   │   │   ├── proto.rs                        # ≈80 lines; protobuf types
│   │   │   ├── connect.rs                      # ≈150 lines; Connect framing
│   │   │   ├── json_stream.rs                  # ≈280 lines; JSON stream
│   │   │   └── events.rs                       # ≈300 lines; real-time downstream messages
│   │   │
│   │   ├── prompting/                          # ≈650 lines; Prompt compilation
│   │   │   ├── mod.rs                          # ≈20 lines; module exports
│   │   │   ├── compiler.rs                     # ≈120 lines; PromptSpec compilation
│   │   │   ├── catalog.rs                      # ≈100 lines; Prompt catalog
│   │   │   ├── assets.rs                       # ≈220 lines; asset loading
│   │   │   └── derived_state.rs                # ≈190 lines; stable derived context
│   │   │
│   │   └── services/                           # ≈2,800 lines; non-Agent-Loop services
│   │       ├── mod.rs                          # ≈30 lines; module exports
│   │       ├── account.rs                      # ≈470 lines; account info
│   │       ├── analytics.rs                    # ≈240 lines; Analytics
│   │       ├── blob_sync.rs                    # ≈320 lines; Blob sync
│   │       ├── context_sync.rs                 # ≈200 lines; context sync
│   │       ├── model_catalog.rs                # ≈730 lines; model catalog
│   │       ├── observability.rs                # ≈230 lines; Cursor Trace
│   │       ├── tab.rs                          # ≈80 lines; Tab info
│   │       └── usage.rs                        # ≈350 lines; usage stats
│   │
│   ├── run/                                    # ≈2,400 lines; generic Agent Loop
│   │   ├── mod.rs                              # ≈30 lines; public interface
│   │   ├── engine.rs                           # ≈550 lines; main loop flow
│   │   ├── handle.rs                           # ≈180 lines; RunHandle/RunPhase
│   │   ├── command.rs                          # ≈180 lines; RunCommand/CommandResult
│   │   ├── event.rs                            # ≈180 lines; RunEvent/RunOutcome
│   │   ├── model_cycle.rs                      # ≈380 lines; a single LLM call
│   │   ├── tool_round.rs                       # ≈320 lines; a single Tool call round
│   │   ├── messages.rs                         # ≈220 lines; idempotent message append
│   │   ├── compaction.rs                       # ≈260 lines; explicit context compaction
│   │   └── port.rs                             # ≈100 lines; external ports
│   │
│   ├── model/                                  # ≈1,900 lines; shared data types
│   │   ├── mod.rs                              # ≈30 lines; module exports
│   │   ├── conversation.rs                     # ≈100 lines; Conversation types
│   │   ├── checkpoint.rs                       # ≈80 lines; Checkpoint types
│   │   ├── message.rs                          # ≈180 lines; Message types
│   │   ├── run.rs                              # ≈100 lines; Run types
│   │   ├── tool.rs                             # ≈100 lines; ToolCall/ToolResult
│   │   ├── inference.rs                        # ≈150 lines; model requests and responses
│   │   ├── projection.rs                       # ≈180 lines; Provider input messages
│   │   ├── configuration.rs                    # ≈550 lines; model configuration
│   │   ├── observability.rs                    # ≈300 lines; call observability
│   │   ├── token_count.rs                      # ≈50 lines; Token counting
│   │   └── tool_result_replay.rs               # ≈230 lines; ToolResult recovery
│   │
│   ├── provider/                               # ≈3,000 lines; Provider adaptation
│   │   ├── mod.rs                              # ≈80 lines; Provider trait
│   │   ├── router.rs                           # ≈230 lines; Provider routing
│   │   ├── event.rs                            # ≈100 lines; unified stream events
│   │   ├── normalize.rs                        # ≈50 lines; response normalization
│   │   ├── retry.rs                            # ≈270 lines; retries
│   │   ├── recorder.rs                         # ≈600 lines; call recording
│   │   ├── anthropic.rs                        # ≈500 lines; Anthropic
│   │   ├── openai_chat.rs                      # ≈580 lines; Chat Completions
│   │   └── openai_responses.rs                 # ≈650 lines; Responses
│   │
│   ├── store/                                  # ≈4,100 lines; local persistence
│   │   ├── mod.rs                              # ≈40 lines; Store interface
│   │   ├── sqlite.rs                           # ≈60 lines; SQLite initialization
│   │   ├── writer.rs                           # ≈30 lines; serialized write transactions
│   │   ├── cas.rs                              # ≈120 lines; concurrent write checks
│   │   ├── conversations.rs                    # ≈180 lines; Conversation
│   │   ├── checkpoints.rs                      # ≈400 lines; Checkpoint
│   │   ├── messages.rs                         # ≈150 lines; Messages and idempotency
│   │   ├── runs.rs                             # ≈300 lines; Run
│   │   ├── tool_rounds.rs                      # ≈330 lines; Tool Round
│   │   ├── input_anchors.rs                    # ≈60 lines; input dedup
│   │   ├── llm_calls.rs                        # ≈650 lines; LLM call records
│   │   ├── models.rs                           # ≈430 lines; model configuration
│   │   ├── settings.rs                         # ≈430 lines; app settings
│   │   ├── storage.rs                          # ≈230 lines; Blob storage
│   │   ├── cursor_traces.rs                    # ≈400 lines; Cursor Trace
│   │   └── overview.rs                         # ≈350 lines; console queries
│   │
│   ├── control/                                # ≈2,100 lines; admin API
│   │   ├── mod.rs                              # ≈30 lines; module exports
│   │   ├── service.rs                          # ≈500 lines; admin service
│   │   ├── settings.rs                         # ≈350 lines; settings API
│   │   ├── models.rs                           # ≈350 lines; models API
│   │   ├── overview.rs                         # ≈300 lines; overview
│   │   ├── calls.rs                            # ≈250 lines; call records
│   │   └── harness.rs                          # ≈170 lines; Harness control
│   │
│   ├── search/                                 # ≈1,400 lines; search capability
│   │   ├── mod.rs                              # ≈30 lines; module exports
│   │   ├── engine.rs                           # ≈350 lines; search entry
│   │   ├── catalog.rs                          # ≈250 lines; search service catalog
│   │   ├── federation.rs                       # ≈280 lines; federated search
│   │   ├── fetch.rs                            # ≈250 lines; web page fetch
│   │   └── search_provider.rs                  # ≈240 lines; search Provider
│   │
│   └── local_app/                              # ≈1,000 lines; local runtime environment
│       ├── mod.rs                              # ≈100 lines; local_app entry (formerly Harness)
│       ├── account.rs                          # ≈150 lines; account
│       ├── proxy.rs                            # ≈250 lines; proxy
│       ├── settings.rs                         # ≈200 lines; settings
│       └── ca/                                 # ≈300 lines; certificates
│           ├── mod.rs                          # ≈250 lines; CA implementation
│           └── windows.rs                      # ≈50 lines; Windows support
│
└── tests/                                      # ≈3,500 lines; cross-module behavior tests
    ├── conversation_delivery.rs                # ≈400 lines; message delivery ordering
    ├── interrupt.rs                            # ≈400 lines; Break and cancel
    ├── error_lifecycle.rs                      # ≈300 lines; terminal-state uniqueness
    ├── checkpoint_recovery.rs                  # ≈350 lines; recovery
    ├── prefix_stability.rs                     # ≈450 lines; prefix stability
    ├── compaction.rs                           # ≈300 lines; compaction
    ├── tool_round.rs                           # ≈450 lines; Tool Round
    └── connect_wire.rs                         # ≈300 lines; Wire Protocol
```

## Top-level architecture

```text
                              Cursor Client
                    ┌──────────────┴──────────────┐
                    │                             │
                Bidi uplink                  RunSSE downlink
                    │                             ▲
                    ▼                             │
          ┌──────────────────────┐                │
          │ Transport            │                │
          │                      │                │
          │ request_id           │                │
          │ OrderedInbox         │                │
          │ OutputHub ────────────────────────────┘
          └──────────┬───────────┘
                     │
                     │ conversation_id
                     ▼
        ┌──────────────────────────────┐
        │ ConversationRegistry         │
        │                              │
        │ conversation_id              │
        │ → ConversationRuntime        │
        └──────────────┬───────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Conversation                                                │
│                                                             │
│ Messages                                                    │
│ current_run: Option<RunHandle>                               │
│ pending_messages                                            │
│ Checkpoint                                                  │
│ Transport bindings                                          │
│                                                             │
│ Sole responsibility:                                        │
│ create Run / deliver Message / Cancel / RunOutcome /        │
│ terminal output                                             │
└──────────────┬────────────────┬─────────────────────────────┘
               │                │
         RunCommand            Checkpoint
               │                │
               ▼                ▼
      ┌─────────────────┐   ┌──────────────────────┐
      │ RunEngine       │   │ CheckpointBuilder    │
      │                 │   │                      │
      │ Model Cycle     │   │ Messages             │
      │ Tool Round      │   │ Turns                │
      │ Message Append  │   │ Steps                │
      │ Compaction      │   │ Derived State        │
      └────────┬────────┘   └──────────┬───────────┘
               │                       │
        ┌──────┴───────┐               ▼
        │              │        ┌──────────────────┐
        ▼              ▼        │ Store            │
    Provider      Tool Runtime   │                  │
        │              │        │ Conversations    │
        └──────┬───────┘        │ Messages         │
               │                │ Checkpoints      │
               └───────────────→│ Runs             │
                                │ Tool Rounds       │
                                └──────────────────┘
```

## Uplink main path

```text
BidiAppendRequest
        │
        ▼
api/cursor/bidi.rs
├── decode request_id
├── decode append_seqno
└── decode AgentClientMessage
        │
        ▼
TransportRegistry
        │
        ▼
OrderedInbox
        │
        ▼
compile/action.rs
        │
        ├── Ignore
        ├── InsertMessages
        └── BreakMessages
        │
        ▼
ConversationRuntime
        │
        ▼
current_run
```

## Downlink main path

```text
RunEvent
   │
   ▼
conversation/output.rs
   │
   ├── protocol/events.rs
   │       │
   │       ▼
   │   AgentServerMessage
   │       │
   │       ▼
   │   Transport OutputHub
   │       │
   │       ▼
   │     RunSSE
   │
   └── checkpoint/steps.rs
           │
           ▼
       StepBuffer
           │
           ▼
       CheckpointWorker
```

## Message compilation

```text
Cursor Action
     │
     ▼
compile/action.rs
     │
     ▼
CompiledMessages
├── event_id
├── target_run_id
├── messages
└── delivery
     │
     ├── Ignore
     ├── InsertMessages
     └── BreakMessages
```

## Message delivery

```text
                         Ignore        InsertMessages        BreakMessages

Before Run starts        drop          initial_messages      initial_messages

Run running              drop          append after the      cancel the current
                                       current cycle         cycle, then append
                                       completes

Run Finalizing           drop          pending_messages      pending_messages

After Run ends           drop          start the next Run    start the next Run
```

When `target_run_id` is present:

```text
target_run_id == current_run_id
└── consumed per delivery

target_run_id != current_run_id
└── StaleTarget, ignored
```

## RunEngine

```text
RunEngine
│
├── Running
│   ├── accepts InsertMessages
│   ├── accepts BreakMessages
│   ├── accepts ToolResult
│   └── accepts Cancel
│
├── Finalizing
│   ├── rejects new messages
│   ├── commits the final Message
│   ├── waits for the Checkpoint barrier
│   └── returns RunClosing
│
└── Ended
    └── returns RunEnded
```

```text
RunCommand
├── InsertMessages(MessageBatch)
├── BreakMessages(MessageBatch)
├── ToolResult(ToolResult)
└── Cancel

CommandResult
├── Applied
├── Duplicate
├── RunClosing
├── RunEnded
└── StaleTarget
```

## InsertMessages

```text
Same Run
│
├── LLM Call #1 in flight
│       │
│       └── receives InsertMessages
│               └── pending_insertions
│
├── LLM Call #1 completes
├── commits Assistant Message
├── appends InsertMessages
├── persists Checkpoint
└── LLM Call #2
```

No new Run is created.

## BreakMessages

```text
Same Run
│
├── LLM Call / Tool Round in flight
│       │
│       └── receives BreakMessages
│
├── cancels the current cycle
├── aborts unfinished Tools
├── writes an interrupted ToolResult
├── appends BreakMessages
├── persists Checkpoint
└── re-enters the Model Cycle
```

Cancellation targets the current cycle, not the whole Run.

## Tool path

```text
RunEngine
    │ ToolCall
    ▼
ConversationRuntime
    │
    ▼
ToolDispatcher
    │
    ├── Local Tool
    ├── Exec Tool
    ├── Edit Tool
    ├── Interaction Tool
    ├── Search Tool
    ├── MCP Tool
    └── Subagent Tool
    │
    ▼
ToolRuntime
    │
    ├── stream
    ├── cancel
    ├── result gate
    └── completion
    │
    ▼
ToolResult
    │
    ▼
RunEngine
```

Tool Cursor Wire Protocol:

```text
ToolCall
├── tools/codec/query.rs
│       └── InteractionQuery
├── tools/codec/render.rs
│       └── Cursor Tool card
├── tools/codec/request.rs
│       └── Exec request
└── tools/codec/response.rs
        └── Exec response
```

## Checkpoint path

Persistence:

```text
Conversation Messages
        │
        ▼
checkpoint/messages/encode.rs
        │
        ▼
Stable root messages
        │
        ├── Turns
        ├── Steps
        ├── Tool state
        ├── Todo/Plan
        └── Read paths
        │
        ▼
Checkpoint
        │
        ▼
Cursor ConversationState
```

Recovery:

```text
Cursor ConversationState
        │
        ▼
checkpoint/recovery.rs
        │
        ▼
checkpoint/messages/decode.rs
        │
        ▼
Conversation Messages
        │
        ▼
PreparedRun
```

Stability:

```text
Without compaction
└── previous Messages are not modified, deleted, or reordered
    └── new Messages are only appended

With compaction
└── explicitly replaces Checkpoint roots
    └── keeps the latest stable context
```

## Cancel path

```text
Bidi Cancel / RunSSE Disconnect / Shutdown
                    │
                    ▼
         ConversationRuntime
                    │
          ┌─────────┴─────────┐
          │                   │
          ▼                   ▼
     RunHandle.cancel     ToolRuntime.abort
          │                   │
          └─────────┬─────────┘
                    ▼
                RunOutcome
                    │
                    ▼
             Final Checkpoint
                    │
                    ▼
          TransportHandle.terminal
                    │
                    ▼
             OutputHub.close
```

Only `ConversationRuntime` can:

```text
Cancel current_run
terminate Tools
send terminal
close OutputHub
remove request_id routing
```

## Module dependencies

```text
api
└── cursor

cursor/transport
└── cursor/conversation

cursor/conversation
├── cursor/compile
├── cursor/checkpoint
├── cursor/tools
├── cursor/protocol
└── run

run
├── model
├── provider
└── store

cursor/checkpoint
├── model
├── store
└── cursor/protocol

cursor/tools
├── model
├── store
└── cursor/protocol

provider
└── model

store
└── model
```

Reverse dependencies are forbidden:

```text
run       ─X→ cursor
provider  ─X→ cursor
store     ─X→ cursor
model     ─X→ cursor
```




## Core summary

```text
Bidi
  → Transport(request_id)
  → Compile
  → Conversation(conversation_id)
  → RunEngine
  → Provider / Tools
  → Conversation
  → Checkpoint
  → Transport
  → RunSSE
```
