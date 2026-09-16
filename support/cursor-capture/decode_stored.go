// decode_stored.go restores text, frame, and protobuf views from persisted capture records.
package main

import (
	"bytes"
	"compress/zlib"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/andybalholm/brotli"
	agentv1 "github.com/leookun/cursor-byok/cursor-proto/gen/agent/v1"
	aiserverv1 "github.com/leookun/cursor-byok/cursor-proto/gen/aiserver/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/dynamicpb"
)

// decodeCapturedContent produces a readable body view based on content type and compression.
func decodeCapturedContent(payload []byte, contentType, codec string) (string, string, error) {
	decoded, err := decodeHTTPContent(payload, codec)
	if err != nil {
		return "", "", err
	}
	if len(decoded) == 0 {
		return "", "", nil
	}
	mediaType := normalizedMediaType(contentType)
	if json.Valid(decoded) {
		var formatted bytes.Buffer
		if err := json.Indent(&formatted, decoded, "", "  "); err != nil {
			return string(decoded), "json", err
		}
		return formatted.String(), "json", nil
	}
	if mediaType == "application/x-www-form-urlencoded" && utf8.Valid(decoded) {
		values, parseErr := url.ParseQuery(string(decoded))
		if parseErr != nil {
			return string(decoded), "plaintext", parseErr
		}
		formatted, marshalErr := json.MarshalIndent(values, "", "  ")
		return string(formatted), "json", marshalErr
	}
	if !isTextMediaType(mediaType) || !utf8.Valid(decoded) {
		return "", "", nil
	}
	if strings.ContainsRune(string(decoded), '\x00') {
		return "", "", nil
	}
	language := textLanguage(mediaType)
	if strings.HasSuffix(mediaType, "+json") || mediaType == "application/json" {
		return string(decoded), "json", fmt.Errorf("invalid JSON body")
	}
	return string(decoded), language, nil
}

// decodeHTTPContent decompresses the HTTP content encoding and returns the body copy.
func decodeHTTPContent(payload []byte, codec string) ([]byte, error) {
	encodings := strings.Split(strings.TrimSpace(codec), ",")
	decoded := payload
	for index := len(encodings) - 1; index >= 0; index-- {
		encoding := strings.ToLower(strings.TrimSpace(encodings[index]))
		switch encoding {
		case "", "identity":
		case "gzip", "x-gzip":
			var err error
			decoded, err = decompressPayload(decoded, "gzip")
			if err != nil {
				return nil, err
			}
		case "deflate":
			reader, err := zlib.NewReader(bytes.NewReader(decoded))
			if err != nil {
				return nil, fmt.Errorf("deflate decompression failed: %w", err)
			}
			result, readErr := io.ReadAll(io.LimitReader(reader, maxConnectFrameBytes+1))
			closeErr := reader.Close()
			if readErr != nil {
				return nil, fmt.Errorf("failed to read deflate content: %w", readErr)
			}
			if closeErr != nil {
				return nil, fmt.Errorf("failed to close deflate content: %w", closeErr)
			}
			if len(result) > maxConnectFrameBytes {
				return nil, fmt.Errorf("deflate content exceeded the %d byte limit", maxConnectFrameBytes)
			}
			decoded = result
		case "br":
			result, readErr := io.ReadAll(io.LimitReader(brotli.NewReader(bytes.NewReader(decoded)), maxConnectFrameBytes+1))
			if readErr != nil {
				return nil, fmt.Errorf("failed to read Brotli content: %w", readErr)
			}
			if len(result) > maxConnectFrameBytes {
				return nil, fmt.Errorf("Brotli content exceeded the %d byte limit", maxConnectFrameBytes)
			}
			decoded = result
		default:
			return nil, fmt.Errorf("unsupported content encoding %q", encoding)
		}
	}
	return decoded, nil
}

// normalizedMediaType strips parameters and normalizes media type case.
func normalizedMediaType(contentType string) string {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(contentType))
	if err == nil {
		return strings.ToLower(mediaType)
	}
	return strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
}

// isProtoContentType reports whether the media type denotes protobuf binary.
func isProtoContentType(contentType string) bool {
	return strings.Contains(normalizedMediaType(contentType), "proto")
}

// isTextMediaType reports whether the media type is suitable for direct text display.
func isTextMediaType(mediaType string) bool {
	return strings.HasPrefix(mediaType, "text/") || strings.HasSuffix(mediaType, "+json") ||
		strings.HasSuffix(mediaType, "+xml") || mediaType == "application/json" ||
		mediaType == "application/xml" || mediaType == "application/javascript" ||
		mediaType == "application/x-javascript" || mediaType == "application/graphql"
}

// textLanguage picks the text language for the frontend editor.
func textLanguage(mediaType string) string {
	switch {
	case strings.Contains(mediaType, "json"):
		return "json"
	case strings.Contains(mediaType, "xml"):
		return "xml"
	case strings.Contains(mediaType, "html"):
		return "html"
	case strings.Contains(mediaType, "javascript"):
		return "javascript"
	case strings.Contains(mediaType, "css"):
		return "css"
	default:
		return "plaintext"
	}
}

// decodeStoredConnectFrames restores streaming frames from the persisted hex payload.
func decodeStoredConnectFrames(rawHexValue, messageType, codec string) ([]FrameView, error) {
	payload, err := hex.DecodeString(strings.TrimSpace(rawHexValue))
	if err != nil {
		return nil, fmt.Errorf("failed to parse the stored Connect body: %w", err)
	}
	frames := make([]FrameView, 0)
	decoder := newConnectFrameDecoder(messageType, codec, defaultMaxFrames, func(frame FrameView) {
		frames = append(frames, frame)
	})
	decoder.Write(payload)
	decoder.Close()
	return frames, nil
}

// isUnaryProtoContentType reports whether the media type is directly decodable protobuf.
func isUnaryProtoContentType(contentType string) bool {
	mediaType := normalizedMediaType(contentType)
	return mediaType == "application/proto" || mediaType == "application/protobuf" || mediaType == "application/x-protobuf"
}

// decodeStoredRawPayload decodes the persisted raw payload, applying compression handling.
func decodeStoredRawPayload(rawHexValue, codec string) ([]byte, error) {
	payload, err := hex.DecodeString(strings.TrimSpace(rawHexValue))
	if err != nil {
		return nil, fmt.Errorf("failed to parse the stored body: %w", err)
	}
	if codec == "" || strings.EqualFold(codec, "identity") {
		return payload, nil
	}
	return decompressPayload(payload, codec)
}

// unaryRequestMessage creates the request message and a stable type name from the RPC path.
func unaryRequestMessage(path string) (proto.Message, string) {
	switch path {
	case forkBackgroundComposerPath:
		return &aiserverv1.ForkBackgroundComposerRequest{}, "fork_background_composer_request"
	case notifyConversationClonePath:
		return &agentv1.NotifyConversationCloneRequest{}, "notify_conversation_clone_request"
	case uploadConversationBlobsPath:
		return &agentv1.UploadConversationBlobsRequest{}, "upload_conversation_blobs_request"
	case cppAvailableModelsPath:
		return &aiserverv1.AvailableCppModelsRequest{}, "available_cpp_models_request"
	case aiAvailableModelsPath:
		return &aiserverv1.AvailableModelsRequest{}, "available_models_request"
	case aiGetDefaultModelPath:
		return &aiserverv1.GetDefaultModelRequest{}, "get_default_model_request"
	case aiDefaultModelNudgeDataPath:
		return &aiserverv1.GetDefaultModelNudgeDataRequest{}, "get_default_model_nudge_data_request"
	case mcpGetKnownServersPath:
		return &aiserverv1.GetKnownServersRequest{}, "get_known_servers_request"
	case serverGetConfigPath:
		return &aiserverv1.GetServerConfigRequest{}, "get_server_config_request"
	default:
		method := rpcMethodDescriptor(path)
		if method == nil || method.IsStreamingClient() || method.IsStreamingServer() {
			return nil, ""
		}
		return dynamicpb.NewMessage(method.Input()), protoMessageKind(method.Input())
	}
}

// unaryResponseMessage creates the response message and a stable type name from the RPC path.
func unaryResponseMessage(path string) (proto.Message, string) {
	switch path {
	case forkBackgroundComposerPath:
		return &aiserverv1.ForkBackgroundComposerResponse{}, "fork_background_composer_response"
	case notifyConversationClonePath:
		return &agentv1.NotifyConversationCloneResponse{}, "notify_conversation_clone_response"
	case uploadConversationBlobsPath:
		return &agentv1.UploadConversationBlobsResponse{}, "upload_conversation_blobs_response"
	case cppAvailableModelsPath:
		return &aiserverv1.AvailableCppModelsResponse{}, "available_cpp_models_response"
	case aiAvailableModelsPath:
		return &aiserverv1.AvailableModelsResponse{}, "available_models_response"
	case aiGetDefaultModelPath:
		return &aiserverv1.GetDefaultModelResponse{}, "get_default_model_response"
	case aiDefaultModelNudgeDataPath:
		return &aiserverv1.GetDefaultModelNudgeDataResponse{}, "get_default_model_nudge_data_response"
	case mcpGetKnownServersPath:
		return &aiserverv1.GetKnownServersResponse{}, "get_known_servers_response"
	case serverGetConfigPath:
		return &aiserverv1.GetServerConfigResponse{}, "get_server_config_response"
	default:
		method := rpcMethodDescriptor(path)
		if method == nil || method.IsStreamingClient() || method.IsStreamingServer() {
			return nil, ""
		}
		return dynamicpb.NewMessage(method.Output()), protoMessageKind(method.Output())
	}
}

// streamingRequestMessageType returns the protobuf type name for streaming requests.
func streamingRequestMessageType(path string) string {
	if path == runSSEPath {
		return "aiserver.v1.BidiRequestId"
	}
	method := rpcMethodDescriptor(path)
	if method == nil || (!method.IsStreamingClient() && !method.IsStreamingServer()) {
		return ""
	}
	return string(method.Input().FullName())
}

// streamingResponseMessageType returns the protobuf type name for streaming responses.
func streamingResponseMessageType(path string) string {
	if path == runSSEPath {
		return "agent.v1.AgentServerMessage"
	}
	method := rpcMethodDescriptor(path)
	if method == nil || (!method.IsStreamingClient() && !method.IsStreamingServer()) {
		return ""
	}
	return string(method.Output().FullName())
}

// decodesUnaryRequest reports whether a known unary request decoder exists.
func decodesUnaryRequest(path string) bool {
	if path == bidiAppendPath {
		return true
	}
	message, _ := unaryRequestMessage(path)
	return message != nil
}

// decodesUnaryResponse reports whether a known unary response decoder exists.
func decodesUnaryResponse(path string) bool {
	message, _ := unaryResponseMessage(path)
	return message != nil
}

// newMessage creates a message instance from the registry by full protobuf type name.
func newMessage(messageType string) proto.Message {
	switch messageType {
	case "aiserver.v1.BidiRequestId":
		return &aiserverv1.BidiRequestId{}
	case "agent.v1.AgentServerMessage":
		return &agentv1.AgentServerMessage{}
	default:
		descriptor, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(messageType))
		if err != nil {
			return nil
		}
		messageDescriptor, ok := descriptor.(protoreflect.MessageDescriptor)
		if !ok {
			return nil
		}
		return dynamicpb.NewMessage(messageDescriptor)
	}
}

// rpcMethodDescriptor finds the method descriptor in the registry by full RPC path.
func rpcMethodDescriptor(path string) protoreflect.MethodDescriptor {
	parts := strings.Split(strings.Trim(strings.TrimSpace(path), "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil
	}
	descriptor, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(parts[0]))
	if err != nil {
		return nil
	}
	service, ok := descriptor.(protoreflect.ServiceDescriptor)
	if !ok {
		return nil
	}
	return service.Methods().ByName(protoreflect.Name(parts[1]))
}

// protoMessageKind derives a stable JSON kind name from the message descriptor.
func protoMessageKind(descriptor protoreflect.MessageDescriptor) string {
	if descriptor == nil {
		return ""
	}
	return snakeCase(string(descriptor.Name()))
}

// snakeCase converts a protobuf name into the frontend-stable snake_case form.
func snakeCase(value string) string {
	var result strings.Builder
	for index, character := range value {
		if unicode.IsUpper(character) {
			if index > 0 {
				result.WriteByte('_')
			}
			result.WriteRune(unicode.ToLower(character))
			continue
		}
		result.WriteRune(character)
	}
	return result.String()
}

// marshalProtoJSON encodes a protobuf message as frontend-readable JSON.
func marshalProtoJSON(message proto.Message) string {
	if message == nil {
		return ""
	}
	payload, err := (protojson.MarshalOptions{
		UseProtoNames:   true,
		EmitUnpopulated: false,
		Indent:          "  ",
	}).Marshal(message)
	if err != nil {
		return ""
	}
	return string(payload)
}

// activeOneofName returns the currently active oneof name on an Agent message.
func activeOneofName(message proto.Message) string {
	if message == nil {
		return ""
	}
	reflected := message.ProtoReflect()
	oneofs := reflected.Descriptor().Oneofs()
	for index := 0; index < oneofs.Len(); index++ {
		oneof := oneofs.Get(index)
		field := reflected.WhichOneof(oneof)
		if field != nil {
			return string(field.Name())
		}
	}
	return string(reflected.Descriptor().Name())
}

// prettyJSON formats JSON when possible and returns the raw text on failure.
func prettyJSON(payload []byte) string {
	var target any
	if err := json.Unmarshal(payload, &target); err != nil {
		return string(payload)
	}
	formatted, err := json.MarshalIndent(target, "", "  ")
	if err != nil {
		return string(payload)
	}
	return string(formatted)
}

// clippedHex bounds the displayed raw payload length and marks elided bytes.
func clippedHex(payload []byte, max int) string {
	if len(payload) > max {
		return hex.EncodeToString(payload[:max]) + "..."
	}
	return hex.EncodeToString(payload)
}
