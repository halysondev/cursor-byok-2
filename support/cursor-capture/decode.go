// decode.go parses Connect frames, compressed payloads, and Cursor protobuf message views.
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	agentv1 "github.com/leookun/cursor-byok/cursor-proto/gen/agent/v1"
	aiserverv1 "github.com/leookun/cursor-byok/cursor-proto/gen/aiserver/v1"
	"google.golang.org/protobuf/proto"
)

// maxConnectFrameBytes prevents anomalous frame lengths from making the debugger allocate excessive memory.
const maxConnectFrameBytes = 64 << 20

// Protocol path constants select the exact protobuf request, response, and streaming message types.
const (
	bidiAppendPath              = "/aiserver.v1.BidiService/BidiAppend"
	forkBackgroundComposerPath  = "/aiserver.v1.BackgroundComposerService/ForkBackgroundComposer"
	notifyConversationClonePath = "/agent.v1.AgentService/NotifyConversationClone"
	uploadConversationBlobsPath = "/agent.v1.AgentService/UploadConversationBlobs"
	cppAvailableModelsPath      = "/aiserver.v1.CppService/AvailableModels"
	aiAvailableModelsPath       = "/aiserver.v1.AiService/AvailableModels"
	aiGetDefaultModelPath       = "/aiserver.v1.AiService/GetDefaultModel"
	aiDefaultModelNudgeDataPath = "/aiserver.v1.AiService/GetDefaultModelNudgeData"
	mcpGetKnownServersPath      = "/aiserver.v1.MCPRegistryService/GetKnownServers"
	serverGetConfigPath         = "/aiserver.v1.ServerConfigService/GetServerConfig"
	runSSEPath                  = "/agent.v1.AgentService/RunSSE"
)

// connectFrameDecoder accumulates and parses Connect five-byte frames across arbitrary read boundaries.
type connectFrameDecoder struct {
	buffer      []byte
	messageType string
	codec       string
	maxFrames   int
	frameCount  int
	onFrame     func(FrameView)
}

// newConnectFrameDecoder creates a streaming decoder for a given protobuf type.
func newConnectFrameDecoder(messageType string, codec string, maxFrames int, onFrame func(FrameView)) *connectFrameDecoder {
	return &connectFrameDecoder{
		messageType: messageType,
		codec:       strings.TrimSpace(codec),
		maxFrames:   maxFrames,
		onFrame:     onFrame,
	}
}

// Write appends network chunks of any length and emits complete frames when possible.
func (decoder *connectFrameDecoder) Write(payload []byte) {
	if len(payload) == 0 || decoder.frameCount >= decoder.maxFrames {
		return
	}
	decoder.buffer = append(decoder.buffer, payload...)
	for len(decoder.buffer) >= 5 && decoder.frameCount < decoder.maxFrames {
		flags := decoder.buffer[0]
		length := int(binary.BigEndian.Uint32(decoder.buffer[1:5]))
		if length < 0 || length > maxConnectFrameBytes {
			decoder.emit(FrameView{Flags: flags, Length: length, Error: "invalid Connect frame length"})
			decoder.buffer = nil
			return
		}
		if len(decoder.buffer) < 5+length {
			return
		}
		framePayload := append([]byte(nil), decoder.buffer[5:5+length]...)
		decoder.buffer = decoder.buffer[5+length:]
		decoder.emit(decoder.decode(flags, framePayload))
	}
}

// Close marks the stream end and surfaces an incomplete trailing-frame error.
func (decoder *connectFrameDecoder) Close() {
	if len(decoder.buffer) > 0 && decoder.frameCount < decoder.maxFrames {
		decoder.emit(FrameView{
			Length: len(decoder.buffer),
			RawHex: clippedHex(decoder.buffer, 4096),
			Error:  "incomplete Connect frame at stream end",
		})
	}
	decoder.buffer = nil
}

// emit calls the frame callback until the frame limit is reached.
func (decoder *connectFrameDecoder) emit(frame FrameView) {
	frame.Index = decoder.frameCount
	decoder.frameCount++
	if decoder.onFrame != nil {
		decoder.onFrame(frame)
	}
}

// decode decompresses and parses a single Connect frame.
func (decoder *connectFrameDecoder) decode(flags uint8, payload []byte) FrameView {
	frame := FrameView{
		Flags:      flags,
		Length:     len(payload),
		Compressed: flags&0x01 != 0,
		EndStream:  flags&0x02 != 0,
		RawHex:     clippedHex(payload, 4096),
	}
	decoded := payload
	if frame.Compressed {
		var err error
		decoded, err = decompressPayload(payload, decoder.codec)
		if err != nil {
			frame.Error = err.Error()
			return frame
		}
	}
	if frame.EndStream {
		frame.Kind = "end_stream"
		frame.MessageType = "connect.error.v1.EndStreamResponse"
		frame.JSON = prettyJSON(decoded)
		return frame
	}

	message := newMessage(decoder.messageType)
	if message == nil {
		frame.Error = "unknown protobuf message type"
		return frame
	}
	if err := proto.Unmarshal(decoded, message); err != nil {
		frame.Error = fmt.Sprintf("protobuf decode failed: %v", err)
		return frame
	}
	frame.MessageType = decoder.messageType
	frame.Kind = activeOneofName(message)
	if requestID, ok := message.(*aiserverv1.BidiRequestId); ok {
		frame.RequestID = strings.TrimSpace(requestID.GetRequestId())
	}
	frame.JSON = marshalProtoJSON(message)
	return frame
}

// decompressPayload decompresses the payload using the codec declared by the protocol.
func decompressPayload(payload []byte, codec string) ([]byte, error) {
	if codec != "" && !strings.EqualFold(codec, "gzip") {
		return nil, fmt.Errorf("unsupported compression codec %q", codec)
	}
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("gzip decompression failed: %w", err)
	}
	defer reader.Close()
	decoded, err := io.ReadAll(io.LimitReader(reader, maxConnectFrameBytes+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read gzip content: %w", err)
	}
	if len(decoded) > maxConnectFrameBytes {
		return nil, fmt.Errorf("gzip content exceeded the %d byte limit", maxConnectFrameBytes)
	}
	return decoded, nil
}

// decodeUnaryRequest parses a unary RPC request and extracts key correlation identifiers.
func decodeUnaryRequest(path string, payload []byte) (decodedJSON string, kind string, requestID string, conversationID string, err error) {
	switch path {
	case bidiAppendPath:
		request := &aiserverv1.BidiAppendRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return "", "", "", "", err
		}
		requestID := strings.TrimSpace(request.GetRequestId().GetRequestId())
		outer := marshalProtoJSON(request)
		clientMessage, clientKind, decodeErr := decodeBidiClientMessage(request)
		if decodeErr != nil || clientMessage == nil {
			return outer, "bidi_append", requestID, "", decodeErr
		}
		combined := struct {
			BidiAppendRequest json.RawMessage `json:"bidi_append_request"`
			AgentClientKind   string          `json:"agent_client_kind"`
			AgentClient       json.RawMessage `json:"agent_client_message"`
		}{
			BidiAppendRequest: json.RawMessage(outer),
			AgentClientKind:   clientKind,
			AgentClient:       json.RawMessage(marshalProtoJSON(clientMessage)),
		}
		formatted, marshalErr := json.MarshalIndent(combined, "", "  ")
		return string(formatted), clientKind, requestID, conversationIDFromClientMessage(clientMessage), marshalErr
	}
	message, kind := unaryRequestMessage(path)
	if message == nil {
		return "", "", "", "", nil
	}
	if err := proto.Unmarshal(payload, message); err != nil {
		return "", "", "", "", err
	}
	return marshalProtoJSON(message), kind, "", conversationIDFromUnaryRequest(message), nil
}

// decodeBidiClientMessage parses the hex-encoded Agent message carried by BidiAppend.
func decodeBidiClientMessage(request *aiserverv1.BidiAppendRequest) (*agentv1.AgentClientMessage, string, error) {
	if request == nil {
		return nil, "", nil
	}
	if strings.TrimSpace(request.GetData()) != "" {
		payload, err := hex.DecodeString(strings.TrimSpace(request.GetData()))
		if err != nil {
			return nil, "", fmt.Errorf("decode hex agent client message failed: %w", err)
		}
		message := &agentv1.AgentClientMessage{}
		if err := proto.Unmarshal(payload, message); err != nil {
			return nil, "", fmt.Errorf("decode agent client message failed: %w", err)
		}
		return message, activeOneofName(message), nil
	}
	if len(request.GetDataBinary()) == 0 {
		return nil, "", nil
	}
	message := &agentv1.AgentClientMessage{}
	if err := proto.Unmarshal(request.GetDataBinary(), message); err != nil {
		return nil, "", fmt.Errorf("decode binary agent client message failed: %w", err)
	}
	return message, activeOneofName(message), nil
}

// conversationIDFromClientMessage extracts the conversation identifier from the Agent message's conversation field.
func conversationIDFromClientMessage(message *agentv1.AgentClientMessage) string {
	if message == nil {
		return ""
	}
	if runRequest := message.GetRunRequest(); runRequest != nil {
		return strings.TrimSpace(runRequest.GetConversationId())
	}
	if prewarmRequest := message.GetPrewarmRequest(); prewarmRequest != nil {
		return strings.TrimSpace(prewarmRequest.GetConversationId())
	}
	return ""
}

// conversationIDFromUnaryRequest extracts the conversation identifier from a known RPC request.
func conversationIDFromUnaryRequest(message proto.Message) string {
	switch typed := message.(type) {
	case *agentv1.NotifyConversationCloneRequest:
		return strings.TrimSpace(typed.GetConversationId())
	case *agentv1.UploadConversationBlobsRequest:
		return strings.TrimSpace(typed.GetConversationId())
	default:
		return ""
	}
}

// decodeUnaryResponse parses a unary RPC response and produces a JSON view.
func decodeUnaryResponse(path string, payload []byte) (decodedJSON string, kind string, err error) {
	message, kind := unaryResponseMessage(path)
	if message == nil {
		return "", "", nil
	}
	if err := proto.Unmarshal(payload, message); err != nil {
		return "", "", err
	}
	return marshalProtoJSON(message), kind, nil
}

// hydrateStoredExchange backfills body and Connect frame views for a historical capture.
func hydrateStoredExchange(exchange *Exchange) bool {
	if exchange == nil || (exchange.State != "completed" && exchange.State != "streaming") {
		return false
	}
	changed := false
	if messageType := streamingRequestMessageType(exchange.Path); messageType != "" &&
		len(exchange.Request.Frames) == 0 && exchange.Request.RawHex != "" && !exchange.Request.RawTruncated {
		frames, err := decodeStoredConnectFrames(exchange.Request.RawHex, messageType, exchange.Request.ContentCodec)
		if err != nil {
			exchange.Request.DecodeError = err.Error()
		} else if len(frames) > 0 {
			exchange.Request.Frames = frames
			for _, frame := range frames {
				if frame.Kind != "" && frame.Kind != "end_stream" {
					exchange.RequestKind = frame.Kind
				}
				if frame.RequestID != "" {
					exchange.RequestID = frame.RequestID
				}
			}
		}
		changed = true
	}
	if messageType := streamingResponseMessageType(exchange.Path); messageType != "" &&
		len(exchange.Response.Frames) == 0 && exchange.Response.RawHex != "" && !exchange.Response.RawTruncated {
		frames, err := decodeStoredConnectFrames(exchange.Response.RawHex, messageType, exchange.Response.ContentCodec)
		if err != nil {
			exchange.Response.DecodeError = err.Error()
		} else if len(frames) > 0 {
			exchange.Response.Frames = frames
			exchange.FrameCount = len(frames)
			for _, frame := range frames {
				if frame.Kind != "" && frame.Kind != "end_stream" {
					exchange.ResponseKind = frame.Kind
				}
			}
		}
		changed = true
	}
	if isUnaryProtoContentType(exchange.Request.ContentType) && exchange.Request.DecodedJSON == "" && !exchange.Request.RawTruncated {
		payload, err := decodeStoredRawPayload(exchange.Request.RawHex, exchange.Request.ContentCodec)
		if err == nil {
			decoded, kind, requestID, conversationID, decodeErr := decodeUnaryRequest(exchange.Path, payload)
			if decodeErr != nil {
				err = decodeErr
			} else if decoded != "" {
				exchange.Request.DecodedJSON = decoded
				exchange.Request.DecodedLang = "json"
				exchange.RequestKind = kind
				if requestID != "" {
					exchange.RequestID = requestID
				}
				if conversationID != "" {
					exchange.ConversationID = conversationID
				}
				changed = true
			}
		}
		if err != nil {
			exchange.Request.DecodeError = err.Error()
			changed = true
		}
	}
	if isUnaryProtoContentType(exchange.Response.ContentType) && exchange.Response.DecodedJSON == "" && !exchange.Response.RawTruncated {
		payload, err := decodeStoredRawPayload(exchange.Response.RawHex, exchange.Response.ContentCodec)
		if err == nil {
			decoded, kind, decodeErr := decodeUnaryResponse(exchange.Path, payload)
			if decodeErr != nil {
				err = decodeErr
			} else if decoded != "" {
				exchange.Response.DecodedJSON = decoded
				exchange.Response.DecodedLang = "json"
				exchange.ResponseKind = kind
				changed = true
			}
		}
		if err != nil {
			exchange.Response.DecodeError = err.Error()
			changed = true
		}
	}
	if exchange.Request.DecodedJSON == "" && exchange.Request.RawHex != "" &&
		!isProtoContentType(exchange.Request.ContentType) && streamingRequestMessageType(exchange.Path) == "" {
		if hydrateStoredTextPayload(&exchange.Request) {
			changed = true
		}
	}
	if exchange.Response.DecodedJSON == "" && exchange.Response.RawHex != "" &&
		!isProtoContentType(exchange.Response.ContentType) && streamingResponseMessageType(exchange.Path) == "" {
		if hydrateStoredTextPayload(&exchange.Response) {
			changed = true
		}
	}
	return changed
}

// hydrateStoredTextPayload backfills the JSON view for a historical text payload.
func hydrateStoredTextPayload(payload *Payload) bool {
	raw, err := hex.DecodeString(strings.TrimSpace(payload.RawHex))
	if err != nil {
		payload.DecodeError = fmt.Sprintf("failed to parse the stored body: %v", err)
		return true
	}
	decoded, language, decodeErr := decodeCapturedContent(raw, payload.ContentType, payload.ContentCodec)
	if decoded == "" && decodeErr == nil {
		return false
	}
	payload.DecodedJSON = decoded
	payload.DecodedLang = language
	if decodeErr != nil {
		payload.DecodeError = decodeErr.Error()
	}
	return true
}

// decodeCapturedContent decodes any captured body by media type and compression encoding.
