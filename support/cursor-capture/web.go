// web.go provides the debugger's read-only API, SSE update stream, and embedded static pages.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"time"
)

// webAssets holds the debugger page assets needed to start without external files.
//
//go:embed web/*
var webAssets embed.FS

// newUIHandler registers the debug API and static assets bound to the local UI.
func (server *Server) newUIHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", server.handleStatus)
	mux.HandleFunc("GET /api/exchanges", server.handleExchangeList)
	mux.HandleFunc("GET /api/exchanges/{id}", server.handleExchangeDetail)
	mux.HandleFunc("GET /api/conversations", server.handleConversationList)
	mux.HandleFunc("DELETE /api/exchanges", server.handleClearExchanges)
	mux.HandleFunc("GET /api/events", server.handleEvents)
	assets, _ := fs.Sub(webAssets, "web")
	fileServer := http.FileServer(http.FS(assets))
	mux.Handle("/", fileServer)
	return securityHeaders(mux)
}

// handleStatus returns the listen address, fixed upstream, and database status.
func (server *Server) handleStatus(writer http.ResponseWriter, _ *http.Request) {
	databasePath, databaseError := server.store.status()
	writeJSON(writer, http.StatusOK, map[string]any{
		"serviceAddr":   server.config.ServiceAddr,
		"debugPath":     debugBasePath + "/",
		"upstreamURL":   server.upstream.String(),
		"running":       true,
		"databasePath":  databasePath,
		"databaseError": databaseError,
	})
}

// handleExchangeList lists request summaries for an optional conversation ID.
func (server *Server) handleExchangeList(writer http.ResponseWriter, request *http.Request) {
	conversationID := strings.TrimSpace(request.URL.Query().Get("conversation_id"))
	summaries, err := server.store.summaries(conversationID)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, summaries)
}

// handleExchangeDetail returns the full capture details of a single request.
func (server *Server) handleExchangeDetail(writer http.ResponseWriter, request *http.Request) {
	id := strings.TrimSpace(request.PathValue("id"))
	exchange, ok, err := server.store.get(id)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(writer, http.StatusNotFound, map[string]string{"error": "request record not found"})
		return
	}
	writeJSON(writer, http.StatusOK, exchange)
}

// handleClearExchanges clears captured records from memory and SQLite.
func (server *Server) handleClearExchanges(writer http.ResponseWriter, _ *http.Request) {
	if err := server.clearExchanges(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

// handleConversationList returns conversation groupings of persisted traffic.
func (server *Server) handleConversationList(writer http.ResponseWriter, _ *http.Request) {
	conversations, err := server.store.conversations()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, conversations)
}

// handleEvents pushes capture changes and keepalive heartbeats over SSE.
func (server *Server) handleEvents(writer http.ResponseWriter, request *http.Request) {
	flusher, ok := writer.(http.Flusher)
	if !ok {
		http.Error(writer, "streaming flush unsupported by this response", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("Connection", "keep-alive")
	updates, unsubscribe := server.store.subscribe()
	defer unsubscribe()
	fmt.Fprint(writer, "event: ready\ndata: {}\n\n")
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case event, open := <-updates:
			if !open {
				return
			}
			payload, _ := json.Marshal(event)
			fmt.Fprintf(writer, "event: update\ndata: %s\n\n", payload)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(writer, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}

// writeJSON writes a uniform JSON response.
func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

// securityHeaders adds a minimal browser security policy for the local debug page.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; connect-src 'self'; worker-src 'self' blob:")
		next.ServeHTTP(writer, request)
	})
}
