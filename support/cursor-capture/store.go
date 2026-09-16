// store.go manages the debug capture's in-memory index, SQLite persistence, and subscription notifications.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// exchangeStore holds a bounded in-memory window plus an optional persistent database connection.
type exchangeStore struct {
	mu           sync.RWMutex
	max          int
	order        []string
	exchanges    map[string]*Exchange
	subscribers  map[chan storeEvent]struct{}
	db           *sql.DB
	databasePath string
	lastError    string
}

// newExchangeStore creates a memory-only capture store.
func newExchangeStore(max int) *exchangeStore {
	return &exchangeStore{
		max:         max,
		exchanges:   make(map[string]*Exchange),
		subscribers: make(map[chan storeEvent]struct{}),
	}
}

// newPersistentExchangeStore creates a SQLite-persisted capture store and restores recent records.
func newPersistentExchangeStore(path string, max int) (*exchangeStore, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("SQLite database path must not be empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("failed to create the SQLite data directory: %w", err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open the SQLite database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := newExchangeStore(max)
	store.db = db
	store.databasePath = path
	if err := store.initializeDatabase(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := store.backfillDecodedExchanges(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := store.loadRecent(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

// backfillDecodedExchanges fills in decoded views for old records and writes them back.
func (store *exchangeStore) backfillDecodedExchanges(ctx context.Context) error {
	rows, err := store.db.QueryContext(ctx, "SELECT payload_json FROM exchanges")
	if err != nil {
		return fmt.Errorf("failed to read SQLite capture records pending backfill: %w", err)
	}
	var exchanges []Exchange
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			_ = rows.Close()
			return err
		}
		var exchange Exchange
		if err := json.Unmarshal(payload, &exchange); err != nil {
			_ = rows.Close()
			return fmt.Errorf("failed to parse a SQLite capture record pending backfill: %w", err)
		}
		if hydrateStoredExchange(&exchange) {
			exchanges = append(exchanges, exchange)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(exchanges) == 0 {
		return nil
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for index := range exchanges {
		payload, marshalErr := json.Marshal(&exchanges[index])
		if marshalErr != nil {
			return marshalErr
		}
		if _, err := tx.ExecContext(ctx, `UPDATE exchanges SET payload_json = ?, conversation_id = ?,
			request_id = ?, updated_at_ms = ? WHERE id = ?`, payload, exchanges[index].ConversationID,
			exchanges[index].RequestID, time.Now().UnixMilli(), exchanges[index].ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// initializeDatabase creates the SQLite tables used by the debugger.
func (store *exchangeStore) initializeDatabase(ctx context.Context) error {
	for _, statement := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA secure_delete = ON",
		`CREATE TABLE IF NOT EXISTS exchanges (
			id TEXT PRIMARY KEY,
			started_at_ms INTEGER NOT NULL,
			conversation_id TEXT NOT NULL DEFAULT '',
			request_id TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL DEFAULT '',
			request_bytes INTEGER NOT NULL DEFAULT 0,
			response_bytes INTEGER NOT NULL DEFAULT 0,
			payload_json BLOB NOT NULL,
			updated_at_ms INTEGER NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS exchanges_conversation_started_idx ON exchanges(conversation_id, started_at_ms DESC)",
		"CREATE INDEX IF NOT EXISTS exchanges_request_idx ON exchanges(request_id)",
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("failed to initialize the SQLite database: %w", err)
		}
	}
	return nil
}

// loadRecent restores the most recent captures into the in-memory window.
func (store *exchangeStore) loadRecent(ctx context.Context) error {
	rows, err := store.db.QueryContext(ctx, `SELECT payload_json, conversation_id
		FROM exchanges ORDER BY started_at_ms DESC, id DESC LIMIT ?`, store.max)
	if err != nil {
		return fmt.Errorf("failed to read SQLite capture records: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var payload []byte
		var conversationID string
		if err := rows.Scan(&payload, &conversationID); err != nil {
			return err
		}
		var exchange Exchange
		if err := json.Unmarshal(payload, &exchange); err != nil {
			return fmt.Errorf("failed to parse a SQLite capture record: %w", err)
		}
		exchange.ConversationID = conversationID
		store.exchanges[exchange.ID] = &exchange
		store.order = append(store.order, exchange.ID)
	}
	return rows.Err()
}

// create adds a new capture and notifies subscribers.
func (store *exchangeStore) create(exchange *Exchange) {
	store.mu.Lock()
	store.exchanges[exchange.ID] = exchange
	store.order = append([]string{exchange.ID}, store.order...)
	for len(store.order) > store.max {
		oldest := store.order[len(store.order)-1]
		store.order = store.order[:len(store.order)-1]
		delete(store.exchanges, oldest)
	}
	store.persistLocked(exchange)
	store.mu.Unlock()
	store.publish(storeEvent{Type: "created", ID: exchange.ID})
}

// update persists the modification and publishes the final capture snapshot.
func (store *exchangeStore) update(id string, apply func(*Exchange)) {
	store.updateWithPersistence(id, apply, true)
}

// updateTransient updates memory only and publishes the in-flight streaming snapshot.
func (store *exchangeStore) updateTransient(id string, apply func(*Exchange)) {
	store.updateWithPersistence(id, apply, false)
}

// updateWithPersistence performs the mutation, association, and optional persistence under one lock.
func (store *exchangeStore) updateWithPersistence(id string, apply func(*Exchange), persist bool) {
	store.mu.Lock()
	exchange := store.exchanges[id]
	if exchange == nil && store.db != nil {
		var err error
		exchange, err = store.loadPersistedLocked(id)
		if err != nil {
			store.lastError = err.Error()
		}
		if exchange != nil {
			store.exchanges[id] = exchange
			store.order = append([]string{id}, store.order...)
			for len(store.order) > store.max {
				oldest := store.order[len(store.order)-1]
				store.order = store.order[:len(store.order)-1]
				delete(store.exchanges, oldest)
			}
		}
	}
	if exchange != nil {
		previousRequestID := exchange.RequestID
		previousConversationID := exchange.ConversationID
		apply(exchange)
		if exchange.RequestID != previousRequestID || exchange.ConversationID != previousConversationID {
			store.associateConversationLocked(exchange)
		}
		if persist {
			store.persistLocked(exchange)
		}
	}
	store.mu.Unlock()
	store.publish(storeEvent{Type: "updated", ID: id})
}

// summaries returns request summaries in reverse chronological order.
