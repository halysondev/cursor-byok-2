// capture_pipeline.go captures, decodes, and appends events for service request/response bodies.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// exchangeIDContextKey isolates the capture identifier used inside the reverse proxy.
type exchangeIDContextKey struct{}

// captureRequest captures request metadata and installs the request body reader.
func (server *Server) captureRequest(request *http.Request) *http.Request {
	if request == nil {
		return request
	}
	server.captureMu.RLock()
	id := strconv.FormatUint(server.counter.Add(1), 10)
	path := request.URL.Path
	upstreamURL := *request.URL
	upstreamURL.Scheme = server.upstream.Scheme
	upstreamURL.Host = server.upstream.Host
	upstreamURL.User = nil
	requestContentType := request.Header.Get("Content-Type")
	requestCodec := requestContentCodec(path, request.Header)
	exchange := &Exchange{
		ExchangeSummary: ExchangeSummary{
			ID:        id,
			StartedAt: time.Now(),
			Method:    request.Method,
			URL:       upstreamURL.String(),
			Host:      server.upstream.Host,
			Path:      path,
			State:     "pending",
		},
		Request: Payload{
			Headers:      sortedHeaders(request.Header),
			ContentType:  requestContentType,
			ContentCodec: requestCodec,
			Frames:       make([]FrameView, 0),
		},
		Response: Payload{Headers: make([]Header, 0), Frames: make([]FrameView, 0)},
	}
	server.store.create(exchange)
	server.captureMu.RUnlock()
	request = request.WithContext(context.WithValue(request.Context(), exchangeIDContextKey{}, id))
	request.Close = false

	if request.Body == nil {
		server.finishRequestBody(id, path, requestContentType, requestCodec, nil, 0, false, nil)
		return request
	}
	var frameDecoder *connectFrameDecoder
	if messageType := streamingRequestMessageType(path); messageType != "" {
		frameDecoder = newConnectFrameDecoder(
			messageType,
			requestCodec,
			server.config.MaxFrames,
			func(frame FrameView) { server.appendRequestFrame(id, frame) },
		)
	}
	request.Body = newCaptureReadCloser(
		request.Body,
		server.config.MaxCaptureBytes,
		func(chunk []byte) {
			if frameDecoder != nil {
				frameDecoder.Write(chunk)
			}
		},
		func(captured []byte, size int64, truncated bool, readErr error) {
			if frameDecoder != nil {
				frameDecoder.Close()
			}
			server.finishRequestBody(id, path, requestContentType, requestCodec, captured, size, truncated, readErr)
		},
	)
	return request
}

// clearExchanges clears in-memory and persisted captures and resets the incrementing ID.
func (server *Server) clearExchanges() error {
	server.captureMu.Lock()
	defer server.captureMu.Unlock()
	if err := server.store.clear(); err != nil {
		return err
	}
	server.counter.Store(0)
	return nil
}

// captureResponse creates the response record update and wraps the response body capturer.
func (server *Server) captureResponse(response *http.Response) error {
	if response == nil {
		return nil
	}
	id := exchangeID(response.Request)
	if id == "" {
		return nil
	}
	path := ""
	if response.Request != nil && response.Request.URL != nil {
		path = response.Request.URL.Path
	}
	responseCodec := responseContentCodec(path, response.Header)
	responseContentType := response.Header.Get("Content-Type")
	server.store.update(id, func(exchange *Exchange) {
		exchange.Status = response.StatusCode
		exchange.State = "streaming"
		exchange.DurationMS = elapsedMS(exchange.StartedAt)
		exchange.Response.Headers = sortedHeaders(response.Header)
		exchange.Response.ContentType = responseContentType
		exchange.Response.ContentCodec = responseCodec
	})
	if response.Body == nil {
		server.finishResponseBody(id, path, responseContentType, responseCodec, nil, 0, false, nil)
		return nil
	}

	var frameDecoder *connectFrameDecoder
	if messageType := streamingResponseMessageType(path); messageType != "" {
		frameDecoder = newConnectFrameDecoder(
			messageType,
			responseCodec,
			server.config.MaxFrames,
			func(frame FrameView) { server.appendResponseFrame(id, frame) },
		)
	}
	response.Body = newCaptureReadCloser(
		response.Body,
		server.config.MaxCaptureBytes,
		func(chunk []byte) {
			if frameDecoder != nil {
				frameDecoder.Write(chunk)
			}
		},
		func(captured []byte, size int64, truncated bool, readErr error) {
			if frameDecoder != nil {
				frameDecoder.Close()
			}
			server.finishResponseBody(id, path, responseContentType, responseCodec, captured, size, truncated, readErr)
		},
	)
	return nil
}

// failExchange records a reverse-forwarding failure.
func (server *Server) failExchange(request *http.Request, upstreamErr error) {
	id := exchangeID(request)
	if id == "" || upstreamErr == nil {
		return
	}
	server.store.update(id, func(exchange *Exchange) {
		exchange.State = "error"
		exchange.Error = upstreamErr.Error()
		exchange.DurationMS = elapsedMS(exchange.StartedAt)
	})
}

// finishRequestBody decompresses, decodes, and stores the final state of the complete request body.
func (server *Server) finishRequestBody(id, path, contentType, codec string, captured []byte, size int64, truncated bool, readErr error) {
	decodePayload := captured
	var contentDecodeErr error
	decodeProto := decodesUnaryRequest(path) && isUnaryProtoContentType(contentType)
	if decodeProto && truncated {
		contentDecodeErr = errors.New("request body exceeded the capture limit and cannot be fully decoded")
	} else if decodeProto && codec != "" && !strings.EqualFold(codec, "identity") {
		decodePayload, contentDecodeErr = decompressPayload(captured, codec)
	}
	decodedJSON, decodedLang, kind, requestID, conversationID, decodeErr := "", "", "", "", "", contentDecodeErr
	if decodeProto && decodeErr == nil {
		decodedJSON, kind, requestID, conversationID, decodeErr = decodeUnaryRequest(path, decodePayload)
	}
	if decodeErr == nil && decodedJSON != "" {
		decodedLang = "json"
	} else if !decodeProto {
		decodedJSON, decodedLang, decodeErr = decodeCapturedContent(captured, contentType, codec)
	}
	server.store.update(id, func(exchange *Exchange) {
		exchange.RequestBytes = size
		exchange.Request.Size = size
		exchange.Request.RawHex = rawHex(captured)
		exchange.Request.RawTruncated = truncated
		if decodedJSON != "" {
			exchange.Request.DecodedJSON = decodedJSON
			exchange.Request.DecodedLang = decodedLang
		}
		if kind != "" {
			exchange.RequestKind = kind
		}
		if requestID != "" {
			exchange.RequestID = requestID
		}
		if conversationID != "" {
			exchange.ConversationID = conversationID
		}
		if decodeErr != nil {
			exchange.Request.DecodeError = decodeErr.Error()
		}
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			exchange.Error = readErr.Error()
		}
	})
}

// requestContentCodec reads the request direction's Connect or HTTP compression encoding.
func requestContentCodec(path string, headers http.Header) string {
	if streamingRequestMessageType(path) != "" {
		return strings.TrimSpace(headers.Get("Connect-Content-Encoding"))
	}
	return strings.TrimSpace(headers.Get("Content-Encoding"))
}

// responseContentCodec reads the response direction's Connect or HTTP compression encoding.
func responseContentCodec(path string, headers http.Header) string {
	if streamingResponseMessageType(path) != "" {
		return strings.TrimSpace(headers.Get("Connect-Content-Encoding"))
	}
	if !decodesUnaryResponse(path) {
		if codec := strings.TrimSpace(headers.Get("Connect-Content-Encoding")); codec != "" {
			return codec
		}
	}
	return strings.TrimSpace(headers.Get("Content-Encoding"))
}

// finishResponseBody decompresses, decodes, and stores the final state of the complete response body.
func (server *Server) finishResponseBody(id, path, contentType, codec string, captured []byte, size int64, truncated bool, readErr error) {
	decodePayload := captured
	var contentDecodeErr error
	decodeProto := decodesUnaryResponse(path) && isUnaryProtoContentType(contentType)
	if decodeProto && truncated {
		contentDecodeErr = errors.New("response body exceeded the capture limit and cannot be fully decoded")
	} else if decodeProto && codec != "" && !strings.EqualFold(codec, "identity") {
		decodePayload, contentDecodeErr = decompressPayload(captured, codec)
	}
	decodedJSON, decodedLang, kind, decodeErr := "", "", "", contentDecodeErr
	if decodeProto && decodeErr == nil {
		decodedJSON, kind, decodeErr = decodeUnaryResponse(path, decodePayload)
	}
	if decodeErr == nil && decodedJSON != "" {
		decodedLang = "json"
	} else if !decodeProto {
		decodedJSON, decodedLang, decodeErr = decodeCapturedContent(captured, contentType, codec)
	}
	server.store.update(id, func(exchange *Exchange) {
		exchange.ResponseBytes = size
		exchange.Response.Size = size
		exchange.Response.RawHex = rawHex(captured)
		exchange.Response.RawTruncated = truncated
		if decodedJSON != "" {
			exchange.Response.DecodedJSON = decodedJSON
			exchange.Response.DecodedLang = decodedLang
		}
		if kind != "" {
			exchange.ResponseKind = kind
		}
		if decodeErr != nil {
			exchange.Response.DecodeError = decodeErr.Error()
		}
		exchange.DurationMS = elapsedMS(exchange.StartedAt)
		exchange.State = "completed"
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			exchange.State = "error"
			exchange.Error = readErr.Error()
		}
	})
}

// appendRequestFrame appends a request-direction streaming frame to the in-flight snapshot.
func (server *Server) appendRequestFrame(id string, frame FrameView) {
	server.store.updateTransient(id, func(exchange *Exchange) {
		if len(exchange.Request.Frames) < server.config.MaxFrames {
			exchange.Request.Frames = append(exchange.Request.Frames, frame)
		}
		if frame.Kind != "" {
			exchange.RequestKind = frame.Kind
		}
		if frame.RequestID != "" {
			exchange.RequestID = frame.RequestID
		}
	})
}

// appendResponseFrame appends a response-direction streaming frame to the in-flight snapshot.
func (server *Server) appendResponseFrame(id string, frame FrameView) {
	server.store.updateTransient(id, func(exchange *Exchange) {
		if len(exchange.Response.Frames) < server.config.MaxFrames {
			exchange.Response.Frames = append(exchange.Response.Frames, frame)
		}
		exchange.FrameCount = len(exchange.Response.Frames)
		if frame.Kind != "" && frame.Kind != "end_stream" {
			exchange.ResponseKind = frame.Kind
		}
		if frame.Error != "" {
			exchange.Response.DecodeError = frame.Error
		}
	})
}

// exchangeID reads the capture record identifier from the request context.
func exchangeID(request *http.Request) string {
	if request == nil {
		return ""
	}
	value, ok := request.Context().Value(exchangeIDContextKey{}).(string)
	if !ok {
		return ""
	}
	return value
}

// browserAddress converts a wildcard listen address into a browser-reachable loopback address.
func browserAddress(address string) string {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return address
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}

// validateLoopbackAddress refuses to expose the debug service on a non-loopback interface.
func validateLoopbackAddress(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid debug service listen address: %w", err)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("the debug service may only listen on a loopback address")
	}
	return nil
}
