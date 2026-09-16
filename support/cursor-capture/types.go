// types.go defines the protocol debugger's config, capture detail, and conversation summary models.
package main

import (
	"os"
	"path/filepath"
	"time"
)

// The defaults keep the debugger on loopback and bound in-memory capture size.
const (
	defaultServiceAddr     = "127.0.0.1:9090"
	defaultUpstreamURL     = "https://api2.cursor.sh"
	debugBasePath          = "/__debuger__"
	defaultMaxExchanges    = 200
	defaultMaxCaptureBytes = 2 << 20
	defaultMaxFrames       = 2000
	defaultDatabaseName    = "cursor-proxy-debugger.db"
)

// Config controls the standalone protocol debugger's listen and storage limits.
type Config struct {
	// ServiceAddr is the Cursor API debug service listen address.
	ServiceAddr string
	// MaxExchanges is the maximum number of requests kept in memory.
	MaxExchanges int
	// MaxCaptureBytes is the per-direction payload retention limit.
	MaxCaptureBytes int
	// MaxFrames is the Connect frame limit retained per stream.
	MaxFrames int
	// DatabasePath is the SQLite capture database path.
	DatabasePath string
}

// normalized fills empty values and rejects invalid capacity settings.
func (config Config) normalized() Config {
	if config.ServiceAddr == "" {
		config.ServiceAddr = defaultServiceAddr
	}
	if config.MaxExchanges <= 0 {
		config.MaxExchanges = defaultMaxExchanges
	}
	if config.MaxCaptureBytes <= 0 {
		config.MaxCaptureBytes = defaultMaxCaptureBytes
	}
	if config.MaxFrames <= 0 {
		config.MaxFrames = defaultMaxFrames
	}
	if config.DatabasePath == "" {
		config.DatabasePath = defaultDatabasePath()
	}
	return config
}

// defaultDatabasePath returns the default database path under the user config directory.
func defaultDatabasePath() string {
	configDir, err := os.UserConfigDir()
	if err != nil || configDir == "" {
		return defaultDatabaseName
	}
	return filepath.Join(configDir, "cursor-byok", defaultDatabaseName)
}

// ExchangeSummary is the compact capture summary used by the request list.
type ExchangeSummary struct {
	// ID is the process-local incrementing capture identifier.
	ID string `json:"id"`
	// StartedAt is the request start time.
	StartedAt time.Time `json:"startedAt"`
	// Method is the HTTP method.
	Method string `json:"method"`
	// URL is the full request URL.
	URL string `json:"url"`
	// Host is the request target host.
	Host string `json:"host"`
	// Path is the RPC or HTTP path.
	Path string `json:"path"`
	// Status is the HTTP response status code.
	Status int `json:"status"`
	// State is the capture processing stage.
	State string `json:"state"`
	// DurationMS is the total request duration in milliseconds.
	DurationMS int64 `json:"durationMs"`
	// RequestBytes is the full request body size in bytes.
	RequestBytes int64 `json:"requestBytes"`
	// ResponseBytes is the full response body size in bytes.
	ResponseBytes int64 `json:"responseBytes"`
	// RequestID is the protocol request identifier.
	RequestID string `json:"requestId,omitempty"`
	// ConversationID is the associated conversation identifier.
	ConversationID string `json:"conversationId,omitempty"`
	// RequestKind is the decoded request message type.
	RequestKind string `json:"requestKind,omitempty"`
	// ResponseKind is the decoded response message type.
	ResponseKind string `json:"responseKind,omitempty"`
	// FrameCount is the total number of Connect frames in both directions.
	FrameCount int `json:"frameCount"`
	// Error is a forwarding or decoding error.
	Error string `json:"error,omitempty"`
}

// Exchange holds the request and response details shown in the debug UI.
type Exchange struct {
	ExchangeSummary
	// Request is the request-direction payload.
	Request Payload `json:"request"`
	// Response is the response-direction payload.
	Response Payload `json:"response"`
}

// Payload holds headers, a raw copy, the decoded body, and protocol frames.
type Payload struct {
	// Headers are redacted, stably sorted HTTP headers.
	Headers []Header `json:"headers"`
	// ContentType is the normalized media type.
	ContentType string `json:"contentType,omitempty"`
	// ContentCodec is the content compression algorithm.
	ContentCodec string `json:"contentCodec,omitempty"`
	// Size is the full directional payload size in bytes.
	Size int64 `json:"size"`
	// RawHex is the hex text of the bounded raw copy.
	RawHex string `json:"rawHex,omitempty"`
	// RawTruncated marks that the raw copy hit the retention limit.
	RawTruncated bool `json:"rawTruncated,omitempty"`
	// DecodedJSON is the formatted structured body.
	DecodedJSON string `json:"decodedJson,omitempty"`
	// DecodedLang is the language identifier used by the frontend editor.
	DecodedLang string `json:"decodedLanguage,omitempty"`
	// DecodeError is a decoding error that does not affect forwarding.
	DecodeError string `json:"decodeError,omitempty"`
	// Frames is the per-frame view of a Connect stream.
	Frames []FrameView `json:"frames,omitempty"`
}

// Header is a stably sorted HTTP header key-value pair.
type Header struct {
	// Name is the header name.
	Name string `json:"name"`
	// Value is the redacted header value.
	Value string `json:"value"`
}

// FrameView describes one Connect streaming envelope.
type FrameView struct {
	// Index is the frame's sequence number in its direction.
	Index int `json:"index"`
	// Flags are the raw Connect flag bits.
	Flags uint8 `json:"flags"`
	// Length is the frame payload length before decompression.
	Length int `json:"length"`
	// Compressed marks the frame payload as compressed.
	Compressed bool `json:"compressed"`
	// EndStream marks the frame as carrying the stream-end flag.
	EndStream bool `json:"endStream"`
	// Kind is the decoded business message type.
	Kind string `json:"kind,omitempty"`
	// MessageType is the full protobuf message name.
	MessageType string `json:"messageType,omitempty"`
	// RequestID is the request identifier parsed from the frame.
	RequestID string `json:"requestId,omitempty"`
	// JSON is the protobuf message's JSON view.
	JSON string `json:"json,omitempty"`
	// RawHex is payload text kept when decoding fails.
	RawHex string `json:"rawHex,omitempty"`
	// Error is the frame's decompression or decoding error.
	Error string `json:"error,omitempty"`
}

// storeEvent is the minimal change event used for SSE notifications.
type storeEvent struct {
	// Type is the capture-record change type.
	Type string `json:"type"`
	// ID is the associated capture identifier.
	ID string `json:"id,omitempty"`
}

// ConversationSummary describes persisted traffic aggregated by conversation.
type ConversationSummary struct {
	// ConversationID is the stable conversation identifier.
	ConversationID string `json:"conversationId"`
	// ExchangeCount is the number of captured records in the conversation.
	ExchangeCount int `json:"exchangeCount"`
	// LastStartedAt is the conversation's most recent request time.
	LastStartedAt time.Time `json:"lastStartedAt"`
	// RequestBytes is the conversation's total request bytes.
	RequestBytes int64 `json:"requestBytes"`
	// ResponseBytes is the conversation's total response bytes.
	ResponseBytes int64 `json:"responseBytes"`
}
