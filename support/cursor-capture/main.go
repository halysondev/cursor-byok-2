// cursor-proxy-debugger is the process entry point for the standalone Cursor API debug service.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/pkg/browser"
)

// main parses startup flags and manages the debug service's full lifecycle.
func main() {
	config := Config{}
	openBrowser := true
	flag.StringVar(&config.ServiceAddr, "addr", defaultServiceAddr, "Cursor API debug service listen address")
	flag.IntVar(&config.MaxExchanges, "max-exchanges", 200, "maximum number of requests kept in memory")
	flag.StringVar(&config.DatabasePath, "db", "", "SQLite database path (defaults to the user config directory)")
	flag.BoolVar(&openBrowser, "open", true, "open a browser after startup")
	flag.Parse()

	server, err := New(config)
	if err != nil {
		log.Fatal(err)
	}
	if err := server.Start(); err != nil {
		log.Fatal(err)
	}

	fmt.Printf("Cursor API debug service started\n")
	fmt.Printf("Service address: http://%s\n", server.ServiceAddr())
	fmt.Printf("Fixed upstream: %s\n", defaultUpstreamURL)
	fmt.Printf("Debug UI: %s\n", server.UIURL())
	fmt.Printf("SQLite: %s\n", server.DatabasePath())
	if openBrowser {
		_ = browser.OpenURL(server.UIURL())
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	signal.Stop(signals)

	if err := server.Close(); err != nil {
		log.Printf("failed to shut down the debug service: %v", err)
	}
}
