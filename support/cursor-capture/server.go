// server.go owns the lifecycle of the fixed-upstream service, traffic capture, and debug UI.
package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

// Server runs the Cursor API forwarding service and its local debug UI.
type Server struct {
	config        Config
	upstream      *url.URL
	store         *exchangeStore
	counter       atomic.Uint64
	serviceServer *http.Server
	serviceLn     net.Listener
	runMu         sync.Mutex
	captureMu     sync.RWMutex
}

// New creates a protocol debug service that always forwards to the Cursor API.
func New(config Config) (*Server, error) {
	config = config.normalized()
	if err := validateLoopbackAddress(config.ServiceAddr); err != nil {
		return nil, fmt.Errorf("invalid service listen address: %w", err)
	}
	upstream, err := url.Parse(defaultUpstreamURL)
	if err != nil {
		return nil, fmt.Errorf("invalid fixed upstream address: %w", err)
	}
	store, err := newPersistentExchangeStore(config.DatabasePath, config.MaxExchanges)
	if err != nil {
		return nil, err
	}
	server := &Server{
		config:   config,
		upstream: upstream,
		store:    store,
	}
	server.counter.Store(store.maxNumericID())
	server.serviceServer = &http.Server{
		Handler:  server.newServiceHandler(),
		ErrorLog: log.New(io.Discard, "", 0),
	}
	return server, nil
}

// Start launches the single-port service hosting both API forwarding and the debug UI.
func (server *Server) Start() error {
	server.runMu.Lock()
	defer server.runMu.Unlock()
	if server.serviceLn != nil {
		return errors.New("Cursor API debug service is already running")
	}
	serviceListener, err := net.Listen("tcp", server.config.ServiceAddr)
	if err != nil {
		return fmt.Errorf("failed to start the API service listener: %w", err)
	}
	server.serviceLn = serviceListener
	go func() { _ = server.serviceServer.Serve(serviceListener) }()
	return nil
}

// Close immediately closes the listener, active connections, and the capture store.
func (server *Server) Close() error {
	server.runMu.Lock()
	serviceServer := server.serviceServer
	server.serviceLn = nil
	server.runMu.Unlock()
	var errorsList []error
	if serviceServer != nil {
		if err := serviceServer.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errorsList = append(errorsList, err)
		}
	}
	if server.store != nil {
		if err := server.store.close(); err != nil {
			errorsList = append(errorsList, err)
		}
	}
	return errors.Join(errorsList...)
}

// ServiceAddr returns the Cursor API service listen address.
func (server *Server) ServiceAddr() string { return server.config.ServiceAddr }

// UIURL returns the debug UI address to open in a browser.
func (server *Server) UIURL() string {
	return "http://" + browserAddress(server.config.ServiceAddr) + debugBasePath + "/"
}

// DatabasePath returns the capture database path.
func (server *Server) DatabasePath() string {
	return server.config.DatabasePath
}

// newServiceHandler creates the single-port debug router and fixed-upstream streaming forwarder.
func (server *Server) newServiceHandler() http.Handler {
	reverseProxy := httputil.NewSingleHostReverseProxy(server.upstream)
	reverseProxy.FlushInterval = -1
	reverseProxy.ErrorLog = log.New(io.Discard, "", 0)
	originalDirector := reverseProxy.Director
	reverseProxy.Director = func(request *http.Request) {
		originalDirector(request)
		request.Host = server.upstream.Host
		request.Header["X-Forwarded-For"] = nil
	}
	reverseProxy.Transport = &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		DisableCompression:    true,
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	reverseProxy.ModifyResponse = server.captureResponse
	reverseProxy.ErrorHandler = func(writer http.ResponseWriter, request *http.Request, upstreamErr error) {
		server.failExchange(request, upstreamErr)
		http.Error(writer, "Cursor API upstream unavailable", http.StatusBadGateway)
	}
	forwardHandler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		reverseProxy.ServeHTTP(writer, server.captureRequest(request))
	})
	debugHandler := http.StripPrefix(debugBasePath, server.newUIHandler())
	mux := http.NewServeMux()
	mux.Handle(debugBasePath+"/", debugHandler)
	mux.HandleFunc(debugBasePath, func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, debugBasePath+"/", http.StatusTemporaryRedirect)
	})
	mux.Handle("/", forwardHandler)
	return mux
}
