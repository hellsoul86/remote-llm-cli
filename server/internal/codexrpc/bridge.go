package codexrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/executor"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
)

var ErrBridgeClosed = errors.New("codex bridge is closed")

const (
	defaultStartupTimeout      = 12 * time.Second
	defaultRequestTimeout      = 45 * time.Second
	defaultNotificationBuffer  = 256
	defaultServerRequestBuffer = 64
	defaultStatusBuffer        = 16
	defaultReconnectMinBackoff = 400 * time.Millisecond
	defaultReconnectMaxBackoff = 8 * time.Second
	maxRPCLineBytes            = 16 * 1024 * 1024
)

type ClientInfo struct {
	Name    string
	Title   string
	Version string
}

type BridgeOptions struct {
	StartupTimeout      time.Duration
	RequestTimeout      time.Duration
	NotificationBuffer  int
	ServerRequestBuffer int
	StatusBuffer        int
	ReconnectMinBackoff time.Duration
	ReconnectMaxBackoff time.Duration
	Workdir             string
	ClientInfo          ClientInfo
}

type StatusState string

const (
	StatusConnected    StatusState = "connected"
	StatusDisconnected StatusState = "disconnected"
	StatusReconnecting StatusState = "reconnecting"
)

type StatusEvent struct {
	HostID    string      `json:"host_id"`
	State     StatusState `json:"state"`
	Error     string      `json:"error,omitempty"`
	Timestamp time.Time   `json:"timestamp"`
}

type Notification struct {
	HostID     string          `json:"host_id"`
	Method     string          `json:"method"`
	Params     json.RawMessage `json:"params,omitempty"`
	ReceivedAt time.Time       `json:"received_at"`
}

type ServerRequest struct {
	HostID     string          `json:"host_id"`
	ID         string          `json:"id"`
	Method     string          `json:"method"`
	Params     json.RawMessage `json:"params,omitempty"`
	ReceivedAt time.Time       `json:"received_at"`
}

type Snapshot struct {
	HostID       string    `json:"host_id"`
	Connected    bool      `json:"connected"`
	Connecting   bool      `json:"connecting"`
	Reconnecting bool      `json:"reconnecting"`
	Pending      int       `json:"pending"`
	ConnectedAt  time.Time `json:"connected_at,omitempty"`
	LastError    string    `json:"last_error,omitempty"`
}

type bridgeProcess interface {
	CommandLine() string
	StdinPipe() io.WriteCloser
	StdoutPipe() io.ReadCloser
	StderrPipe() io.ReadCloser
	Wait() error
	Close() error
}

type startProcessFunc func(ctx context.Context, host model.Host, spec runtime.CommandSpec, workdir string) (bridgeProcess, error)

type rpcEnvelope struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	if e == nil {
		return ""
	}
	if strings.TrimSpace(e.Message) != "" {
		return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("rpc error %d", e.Code)
}

type rpcResponse struct {
	Result json.RawMessage
	Err    *RPCError
}

type Bridge struct {
	startFn startProcessFunc
	opts    BridgeOptions

	writerMu sync.Mutex

	mu           sync.Mutex
	cond         *sync.Cond
	host         model.Host
	closed       bool
	connecting   bool
	reconnecting bool
	connectedAt  time.Time
	lastError    string
	proc         bridgeProcess
	connID       uint64
	nextSubID    int64
	pending      map[string]chan rpcResponse
	notifySubs   map[int64]chan Notification
	requestSubs  map[int64]chan ServerRequest
	statusSubs   map[int64]chan StatusEvent

	nextReqID  uint64
	nextConnID uint64
}

func defaultClientInfo() ClientInfo {
	return ClientInfo{
		Name:    "remote_llm_cli",
		Title:   "remote-llm-cli",
		Version: "v1",
	}
}

func normalizeOptions(opts BridgeOptions) BridgeOptions {
	out := opts
	if out.StartupTimeout <= 0 {
		out.StartupTimeout = defaultStartupTimeout
	}
	if out.RequestTimeout <= 0 {
		out.RequestTimeout = defaultRequestTimeout
	}
	if out.NotificationBuffer <= 0 {
		out.NotificationBuffer = defaultNotificationBuffer
	}
	if out.ServerRequestBuffer <= 0 {
		out.ServerRequestBuffer = defaultServerRequestBuffer
	}
	if out.StatusBuffer <= 0 {
		out.StatusBuffer = defaultStatusBuffer
	}
	if out.ReconnectMinBackoff <= 0 {
		out.ReconnectMinBackoff = defaultReconnectMinBackoff
	}
	if out.ReconnectMaxBackoff <= 0 {
		out.ReconnectMaxBackoff = defaultReconnectMaxBackoff
	}
	if out.ReconnectMaxBackoff < out.ReconnectMinBackoff {
		out.ReconnectMaxBackoff = out.ReconnectMinBackoff
	}
	if strings.TrimSpace(out.ClientInfo.Name) == "" {
		out.ClientInfo = defaultClientInfo()
	}
	return out
}

func NewBridge(host model.Host, opts BridgeOptions) *Bridge {
	return NewBridgeWithStarter(host, opts, func(ctx context.Context, h model.Host, spec runtime.CommandSpec, workdir string) (bridgeProcess, error) {
		return executor.StartInteractiveViaSSH(ctx, h, spec, workdir)
	})
}

func NewBridgeWithStarter(host model.Host, opts BridgeOptions, starter startProcessFunc) *Bridge {
	if starter == nil {
		starter = func(ctx context.Context, h model.Host, spec runtime.CommandSpec, workdir string) (bridgeProcess, error) {
			return executor.StartInteractiveViaSSH(ctx, h, spec, workdir)
		}
	}
	out := &Bridge{
		startFn:      starter,
		opts:         normalizeOptions(opts),
		host:         host,
		pending:      map[string]chan rpcResponse{},
		notifySubs:   map[int64]chan Notification{},
		requestSubs:  map[int64]chan ServerRequest{},
		statusSubs:   map[int64]chan StatusEvent{},
		nextReqID:    0,
		nextSubID:    0,
		reconnecting: false,
	}
	out.cond = sync.NewCond(&out.mu)
	return out
}

func (b *Bridge) UpdateHost(host model.Host) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.host = host
}

func (b *Bridge) hostID() string {
	id := strings.TrimSpace(b.host.ID)
	if id != "" {
		return id
	}
	name := strings.TrimSpace(b.host.Name)
	if name != "" {
		return name
	}
	if strings.TrimSpace(b.host.Host) != "" {
		return strings.TrimSpace(b.host.Host)
	}
	return "unknown"
}

func (b *Bridge) appServerSpec() runtime.CommandSpec {
	return runtime.CommandSpec{
		Program: "codex",
		Args:    []string{"app-server", "--listen", "stdio://"},
	}
}

func (b *Bridge) resolveWorkdir() string {
	if trimmed := strings.TrimSpace(b.opts.Workdir); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(b.host.Workspace)
}

func (b *Bridge) withRequestTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	if deadline, ok := parent.Deadline(); ok {
		if time.Until(deadline) <= b.opts.RequestTimeout {
			return parent, func() {}
		}
	}
	return context.WithTimeout(parent, b.opts.RequestTimeout)
}

func (b *Bridge) ensureConnected(ctx context.Context) error {
	b.mu.Lock()
	for {
		if b.closed {
			b.mu.Unlock()
			return ErrBridgeClosed
		}
		if b.proc != nil {
			b.mu.Unlock()
			return nil
		}
		if !b.connecting {
			b.connecting = true
			break
		}
		b.cond.Wait()
	}
	host := b.host
	b.mu.Unlock()

	connectCtx := ctx
	cancel := func() {}
	if deadline, ok := connectCtx.Deadline(); !ok || time.Until(deadline) > b.opts.StartupTimeout {
		connectCtx, cancel = context.WithTimeout(connectCtx, b.opts.StartupTimeout)
	}
	defer cancel()

	proc, err := b.startFn(connectCtx, host, b.appServerSpec(), b.resolveWorkdir())
	if err != nil {
		b.finishConnect(err)
		return err
	}

	connID := atomic.AddUint64(&b.nextConnID, 1)

	b.mu.Lock()
	if b.closed {
		b.connecting = false
		b.cond.Broadcast()
		b.mu.Unlock()
		_ = proc.Close()
		return ErrBridgeClosed
	}
	b.proc = proc
	b.connID = connID
	b.connectedAt = time.Now().UTC()
	b.lastError = ""
	b.connecting = false
	b.cond.Broadcast()
	b.mu.Unlock()

	go b.readLoop(connID, proc)
	go b.stderrDrainLoop(connID, proc)
	go b.waitLoop(connID, proc)

	initCtx, initCancel := b.withRequestTimeout(connectCtx)
	err = b.bootstrap(initCtx)
	initCancel()
	if err != nil {
		b.handleProcessDrop(connID, fmt.Errorf("initialize app-server: %w", err))
		return err
	}

	b.publishStatus(StatusEvent{
		HostID:    b.hostID(),
		State:     StatusConnected,
		Timestamp: time.Now().UTC(),
	})
	return nil
}

func (b *Bridge) finishConnect(err error) {
	b.mu.Lock()
	b.connecting = false
	if err != nil {
		b.lastError = err.Error()
	}
	b.cond.Broadcast()
	b.mu.Unlock()
	if err != nil {
		b.publishStatus(StatusEvent{
			HostID:    b.hostID(),
			State:     StatusDisconnected,
			Error:     err.Error(),
			Timestamp: time.Now().UTC(),
		})
	}
}

func (b *Bridge) bootstrap(ctx context.Context) error {
	params := map[string]any{
		"clientInfo": map[string]string{
			"name":    b.opts.ClientInfo.Name,
			"title":   b.opts.ClientInfo.Title,
			"version": b.opts.ClientInfo.Version,
		},
	}
	var initResp map[string]any
	if err := b.callConnected(ctx, "initialize", params, &initResp); err != nil {
		return err
	}
	if err := b.notifyConnected(ctx, "initialized", map[string]any{}); err != nil {
		return err
	}
	return nil
}

func (b *Bridge) Call(ctx context.Context, method string, params any, out any) error {
	method = strings.TrimSpace(method)
	if method == "" {
		return errors.New("method is required")
	}
	if err := b.ensureConnected(ctx); err != nil {
		return err
	}
	callCtx, cancel := b.withRequestTimeout(ctx)
	defer cancel()
	err := b.callConnected(callCtx, method, params, out)
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrBridgeClosed) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	// Try once on transport failure after forcing a reconnect.
	if reconnectErr := b.ensureConnected(ctx); reconnectErr != nil {
		return err
	}
	callCtx, cancel = b.withRequestTimeout(ctx)
	defer cancel()
	return b.callConnected(callCtx, method, params, out)
}

func (b *Bridge) Notify(ctx context.Context, method string, params any) error {
	method = strings.TrimSpace(method)
	if method == "" {
		return errors.New("method is required")
	}
	if err := b.ensureConnected(ctx); err != nil {
		return err
	}
	notifyCtx, cancel := b.withRequestTimeout(ctx)
	defer cancel()
	return b.notifyConnected(notifyCtx, method, params)
}

func (b *Bridge) callConnected(ctx context.Context, method string, params any, out any) error {
	id := fmt.Sprintf("req_%d", atomic.AddUint64(&b.nextReqID, 1))
	envelope := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return err
	}

	respCh := make(chan rpcResponse, 1)
	proc, err := b.registerPending(id, respCh)
	if err != nil {
		return err
	}
	if err := b.writeLine(proc, payload); err != nil {
		b.unregisterPending(id)
		b.handleProcessDrop(b.currentConnID(), fmt.Errorf("write request: %w", err))
		return err
	}

	select {
	case <-ctx.Done():
		b.unregisterPending(id)
		return ctx.Err()
	case response := <-respCh:
		if response.Err != nil {
			return response.Err
		}
		if out == nil || len(response.Result) == 0 {
			return nil
		}
		if err := json.Unmarshal(response.Result, out); err != nil {
			return fmt.Errorf("decode result: %w", err)
		}
		return nil
	}
}

func (b *Bridge) notifyConnected(ctx context.Context, method string, params any) error {
	envelope := map[string]any{
		"method": method,
		"params": params,
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	proc, err := b.currentProcess()
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() {
		done <- b.writeLine(proc, payload)
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-done:
		if err != nil {
			b.handleProcessDrop(b.currentConnID(), fmt.Errorf("write notification: %w", err))
		}
		return err
	}
}

func (b *Bridge) registerPending(id string, respCh chan rpcResponse) (bridgeProcess, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, ErrBridgeClosed
	}
	if b.proc == nil {
		return nil, errors.New("bridge is not connected")
	}
	b.pending[id] = respCh
	return b.proc, nil
}

func (b *Bridge) unregisterPending(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.pending, id)
}

func (b *Bridge) currentProcess() (bridgeProcess, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, ErrBridgeClosed
	}
	if b.proc == nil {
		return nil, errors.New("bridge is not connected")
	}
	return b.proc, nil
}

func (b *Bridge) currentConnID() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connID
}

func (b *Bridge) writeLine(proc bridgeProcess, payload []byte) error {
	stdin := proc.StdinPipe()
	if stdin == nil {
		return errors.New("bridge stdin is nil")
	}
	b.writerMu.Lock()
	defer b.writerMu.Unlock()
	if _, err := stdin.Write(payload); err != nil {
		return err
	}
	if _, err := stdin.Write([]byte("\n")); err != nil {
		return err
	}
	return nil
}

func (b *Bridge) readLoop(connID uint64, proc bridgeProcess) {
	stdout := proc.StdoutPipe()
	if stdout == nil {
		b.handleProcessDrop(connID, errors.New("bridge stdout is nil"))
		return
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 128*1024), maxRPCLineBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var envelope rpcEnvelope
		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			continue
		}
		b.dispatchEnvelope(envelope)
	}
	if err := scanner.Err(); err != nil {
		b.handleProcessDrop(connID, fmt.Errorf("read loop: %w", err))
	}
}

func (b *Bridge) stderrDrainLoop(connID uint64, proc bridgeProcess) {
	stderr := proc.StderrPipe()
	if stderr == nil {
		return
	}
	reader := bufio.NewScanner(stderr)
	reader.Buffer(make([]byte, 0, 64*1024), maxRPCLineBytes)
	for reader.Scan() {
		// Intentionally drained to avoid blocking the process when stderr is verbose.
	}
	if err := reader.Err(); err != nil {
		b.handleProcessDrop(connID, fmt.Errorf("stderr drain loop: %w", err))
	}
}

func (b *Bridge) waitLoop(connID uint64, proc bridgeProcess) {
	if err := proc.Wait(); err != nil {
		b.handleProcessDrop(connID, fmt.Errorf("process exited: %w", err))
		return
	}
	b.handleProcessDrop(connID, errors.New("process exited"))
}

func (b *Bridge) dispatchEnvelope(envelope rpcEnvelope) {
	now := time.Now().UTC()
	if strings.TrimSpace(envelope.Method) != "" {
		if id := normalizeMessageID(envelope.ID); id != "" {
			b.publishServerRequest(ServerRequest{
				HostID:     b.hostID(),
				ID:         id,
				Method:     strings.TrimSpace(envelope.Method),
				Params:     envelope.Params,
				ReceivedAt: now,
			})
			return
		}
		b.publishNotification(Notification{
			HostID:     b.hostID(),
			Method:     strings.TrimSpace(envelope.Method),
			Params:     envelope.Params,
			ReceivedAt: now,
		})
		return
	}
	id := normalizeMessageID(envelope.ID)
	if id == "" {
		return
	}
	b.mu.Lock()
	respCh := b.pending[id]
	delete(b.pending, id)
	b.mu.Unlock()
	if respCh == nil {
		return
	}
	select {
	case respCh <- rpcResponse{Result: envelope.Result, Err: envelope.Error}:
	default:
	}
}

func normalizeMessageID(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "\"") {
		var out string
		if err := json.Unmarshal(raw, &out); err == nil {
			return strings.TrimSpace(out)
		}
	}
	return trimmed
}

func (b *Bridge) handleProcessDrop(connID uint64, cause error) {
	b.mu.Lock()
	if b.connID != connID || b.proc == nil {
		b.mu.Unlock()
		return
	}
	proc := b.proc
	b.proc = nil
	b.connID = 0
	if cause != nil {
		b.lastError = cause.Error()
	}

	pending := b.pending
	b.pending = map[string]chan rpcResponse{}

	shouldReconnect := !b.closed && !b.reconnecting
	if shouldReconnect {
		b.reconnecting = true
	}
	b.cond.Broadcast()
	b.mu.Unlock()

	if proc != nil {
		_ = proc.Close()
	}

	for _, respCh := range pending {
		select {
		case respCh <- rpcResponse{Err: &RPCError{Code: -32000, Message: "bridge disconnected"}}:
		default:
		}
	}

	errMsg := ""
	if cause != nil {
		errMsg = cause.Error()
	}
	b.publishStatus(StatusEvent{
		HostID:    b.hostID(),
		State:     StatusDisconnected,
		Error:     errMsg,
		Timestamp: time.Now().UTC(),
	})

	if shouldReconnect {
		go b.reconnectLoop()
	}
}

func (b *Bridge) reconnectLoop() {
	defer func() {
		b.mu.Lock()
		b.reconnecting = false
		b.mu.Unlock()
	}()

	backoff := b.opts.ReconnectMinBackoff
	for {
		b.mu.Lock()
		if b.closed || b.proc != nil {
			b.mu.Unlock()
			return
		}
		b.mu.Unlock()

		b.publishStatus(StatusEvent{
			HostID:    b.hostID(),
			State:     StatusReconnecting,
			Timestamp: time.Now().UTC(),
		})

		ctx, cancel := context.WithTimeout(context.Background(), b.opts.StartupTimeout)
		err := b.ensureConnected(ctx)
		cancel()
		if err == nil {
			return
		}

		timer := time.NewTimer(backoff)
		<-timer.C
		backoff *= 2
		if backoff > b.opts.ReconnectMaxBackoff {
			backoff = b.opts.ReconnectMaxBackoff
		}
	}
}

func (b *Bridge) publishNotification(event Notification) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, ch := range b.notifySubs {
		select {
		case ch <- event:
		default:
			close(ch)
			delete(b.notifySubs, id)
		}
	}
}

func (b *Bridge) publishServerRequest(event ServerRequest) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, ch := range b.requestSubs {
		select {
		case ch <- event:
		default:
			close(ch)
			delete(b.requestSubs, id)
		}
	}
}

func (b *Bridge) publishStatus(event StatusEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, ch := range b.statusSubs {
		select {
		case ch <- event:
		default:
			close(ch)
			delete(b.statusSubs, id)
		}
	}
}

func (b *Bridge) SubscribeNotifications(buffer int) (<-chan Notification, func()) {
	if buffer <= 0 {
		buffer = b.opts.NotificationBuffer
	}
	ch := make(chan Notification, buffer)
	subID, ok := b.addNotificationSub(ch)
	if !ok {
		close(ch)
		return ch, func() {}
	}
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			b.removeNotificationSub(subID)
		})
	}
}

func (b *Bridge) addNotificationSub(ch chan Notification) (int64, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return 0, false
	}
	b.nextSubID++
	subID := b.nextSubID
	b.notifySubs[subID] = ch
	return subID, true
}

func (b *Bridge) removeNotificationSub(subID int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch, ok := b.notifySubs[subID]
	if !ok {
		return
	}
	delete(b.notifySubs, subID)
	close(ch)
}

func (b *Bridge) SubscribeServerRequests(buffer int) (<-chan ServerRequest, func()) {
	if buffer <= 0 {
		buffer = b.opts.ServerRequestBuffer
	}
	ch := make(chan ServerRequest, buffer)
	subID, ok := b.addServerRequestSub(ch)
	if !ok {
		close(ch)
		return ch, func() {}
	}
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			b.removeServerRequestSub(subID)
		})
	}
}

func (b *Bridge) addServerRequestSub(ch chan ServerRequest) (int64, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return 0, false
	}
	b.nextSubID++
	subID := b.nextSubID
	b.requestSubs[subID] = ch
	return subID, true
}

func (b *Bridge) removeServerRequestSub(subID int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch, ok := b.requestSubs[subID]
	if !ok {
		return
	}
	delete(b.requestSubs, subID)
	close(ch)
}

func (b *Bridge) SubscribeStatus(buffer int) (<-chan StatusEvent, func()) {
	if buffer <= 0 {
		buffer = b.opts.StatusBuffer
	}
	ch := make(chan StatusEvent, buffer)
	subID, ok := b.addStatusSub(ch)
	if !ok {
		close(ch)
		return ch, func() {}
	}
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			b.removeStatusSub(subID)
		})
	}
}

func (b *Bridge) addStatusSub(ch chan StatusEvent) (int64, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return 0, false
	}
	b.nextSubID++
	subID := b.nextSubID
	b.statusSubs[subID] = ch
	return subID, true
}

func (b *Bridge) removeStatusSub(subID int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch, ok := b.statusSubs[subID]
	if !ok {
		return
	}
	delete(b.statusSubs, subID)
	close(ch)
}

func (b *Bridge) Snapshot() Snapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	return Snapshot{
		HostID:       b.hostID(),
		Connected:    b.proc != nil,
		Connecting:   b.connecting,
		Reconnecting: b.reconnecting,
		Pending:      len(b.pending),
		ConnectedAt:  b.connectedAt,
		LastError:    b.lastError,
	}
}

func (b *Bridge) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	proc := b.proc
	b.proc = nil
	b.connID = 0
	pending := b.pending
	b.pending = map[string]chan rpcResponse{}
	b.cond.Broadcast()

	notifySubs := b.notifySubs
	b.notifySubs = map[int64]chan Notification{}
	requestSubs := b.requestSubs
	b.requestSubs = map[int64]chan ServerRequest{}
	statusSubs := b.statusSubs
	b.statusSubs = map[int64]chan StatusEvent{}
	b.mu.Unlock()

	for _, ch := range pending {
		select {
		case ch <- rpcResponse{Err: &RPCError{Code: -32000, Message: "bridge closed"}}:
		default:
		}
	}
	for _, ch := range notifySubs {
		close(ch)
	}
	for _, ch := range requestSubs {
		close(ch)
	}
	for _, ch := range statusSubs {
		close(ch)
	}
	if proc != nil {
		return proc.Close()
	}
	return nil
}

type Manager struct {
	opts    BridgeOptions
	startFn startProcessFunc

	mu      sync.Mutex
	bridges map[string]*Bridge
}

func NewManager(opts BridgeOptions) *Manager {
	return NewManagerWithStarter(opts, nil)
}

func NewManagerWithStarter(opts BridgeOptions, starter startProcessFunc) *Manager {
	return &Manager{
		opts:    normalizeOptions(opts),
		startFn: starter,
		bridges: map[string]*Bridge{},
	}
}

func (m *Manager) BridgeForHost(host model.Host) *Bridge {
	hostID := strings.TrimSpace(host.ID)
	if hostID == "" {
		hostID = strings.TrimSpace(host.Name)
	}
	if hostID == "" {
		hostID = strings.TrimSpace(host.Host)
	}
	if hostID == "" {
		hostID = fmt.Sprintf("host_%d", time.Now().UnixNano())
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.bridges[hostID]; ok {
		existing.UpdateHost(host)
		return existing
	}
	var bridge *Bridge
	if m.startFn != nil {
		bridge = NewBridgeWithStarter(host, m.opts, m.startFn)
	} else {
		bridge = NewBridge(host, m.opts)
	}
	m.bridges[hostID] = bridge
	return bridge
}

func (m *Manager) CloseHost(hostID string) error {
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		return nil
	}
	m.mu.Lock()
	bridge := m.bridges[hostID]
	delete(m.bridges, hostID)
	m.mu.Unlock()
	if bridge == nil {
		return nil
	}
	return bridge.Close()
}

func (m *Manager) Snapshots() []Snapshot {
	m.mu.Lock()
	bridges := make([]*Bridge, 0, len(m.bridges))
	for _, bridge := range m.bridges {
		bridges = append(bridges, bridge)
	}
	m.mu.Unlock()
	out := make([]Snapshot, 0, len(bridges))
	for _, bridge := range bridges {
		out = append(out, bridge.Snapshot())
	}
	return out
}

func (m *Manager) Close() error {
	m.mu.Lock()
	bridges := make([]*Bridge, 0, len(m.bridges))
	for hostID, bridge := range m.bridges {
		bridges = append(bridges, bridge)
		delete(m.bridges, hostID)
	}
	m.mu.Unlock()
	var closeErr error
	for _, bridge := range bridges {
		closeErr = errors.Join(closeErr, bridge.Close())
	}
	return closeErr
}
