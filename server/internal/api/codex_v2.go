package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/codexrpc"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

type codexV2SessionStartRequest struct {
	HostID         string `json:"host_id,omitempty"`
	ProjectID      string `json:"project_id,omitempty"`
	Path           string `json:"path,omitempty"`
	Title          string `json:"title,omitempty"`
	Model          string `json:"model,omitempty"`
	ApprovalPolicy string `json:"approval_policy,omitempty"`
	Sandbox        string `json:"sandbox,omitempty"`
}

type codexV2SessionActionRequest struct {
	HostID         string `json:"host_id,omitempty"`
	ProjectID      string `json:"project_id,omitempty"`
	Path           string `json:"path,omitempty"`
	Title          string `json:"title,omitempty"`
	Model          string `json:"model,omitempty"`
	ApprovalPolicy string `json:"approval_policy,omitempty"`
	Sandbox        string `json:"sandbox,omitempty"`
	Name           string `json:"name,omitempty"`
}

type codexV2TurnStartRequest struct {
	HostID         string            `json:"host_id,omitempty"`
	Prompt         string            `json:"prompt,omitempty"`
	Input          []map[string]any  `json:"input,omitempty"`
	Model          string            `json:"model,omitempty"`
	Cwd            string            `json:"cwd,omitempty"`
	ApprovalPolicy string            `json:"approval_policy,omitempty"`
	Sandbox        string            `json:"sandbox,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"`
}

type codexV2TurnSteerRequest struct {
	HostID string           `json:"host_id,omitempty"`
	Prompt string           `json:"prompt,omitempty"`
	Input  []map[string]any `json:"input,omitempty"`
}

type codexPendingRequest struct {
	SessionID  string          `json:"session_id"`
	RequestID  string          `json:"request_id"`
	HostID     string          `json:"host_id"`
	Method     string          `json:"method"`
	RawID      json.RawMessage `json:"raw_id,omitempty"`
	Params     json.RawMessage `json:"params,omitempty"`
	ReceivedAt time.Time       `json:"received_at"`
}

type codexV2ResolveRequestBody struct {
	Result   json.RawMessage    `json:"result,omitempty"`
	Decision json.RawMessage    `json:"decision,omitempty"`
	Error    *codexrpc.RPCError `json:"error,omitempty"`
}

type codexV2ThreadResult struct {
	Thread map[string]any `json:"thread,omitempty"`
}

func (s *Server) handleCodexV2SessionStart(w http.ResponseWriter, r *http.Request) {
	var req codexV2SessionStartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	host, project, err := s.resolveCodexV2StartTarget(req.HostID, req.ProjectID, req.Path, req.Title)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}

	params := codexV2SessionParams{
		model:          req.Model,
		approvalPolicy: req.ApprovalPolicy,
		sandbox:        req.Sandbox,
		cwd:            project.Path,
	}
	var rpcResp codexV2ThreadResult
	if err := bridge.Call(r.Context(), "thread/start", params.ToMap(true), &rpcResp); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	threadID := extractCodexThreadID(rpcResp.Thread)
	if threadID == "" {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "thread/start returned empty thread id"})
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = deriveCodexThreadTitle(rpcResp.Thread, threadID)
	}
	session, err := s.upsertCodexV2Session(threadID, host, project, title)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session": session,
		"project": project,
		"thread":  rpcResp.Thread,
	})
}

func (s *Server) handleCodexV2SessionResume(w http.ResponseWriter, r *http.Request) {
	threadID := strings.TrimSpace(r.PathValue("id"))
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	var req codexV2SessionActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	existing, host, err := s.resolveCodexV2SessionHost(threadID, req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	project, err := s.resolveCodexV2SessionProject(existing, host, req.ProjectID, req.Path, req.Title)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	params := codexV2SessionParams{
		model:          req.Model,
		approvalPolicy: req.ApprovalPolicy,
		sandbox:        req.Sandbox,
		cwd:            project.Path,
	}
	payload := params.ToMap(false)
	payload["threadId"] = threadID

	var rpcResp codexV2ThreadResult
	if err := bridge.Call(r.Context(), "thread/resume", payload, &rpcResp); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	resolvedID := extractCodexThreadID(rpcResp.Thread)
	if resolvedID == "" {
		resolvedID = threadID
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = deriveCodexThreadTitle(rpcResp.Thread, resolvedID)
	}
	session, err := s.upsertCodexV2Session(resolvedID, host, project, title)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session": session,
		"project": project,
		"thread":  rpcResp.Thread,
	})
}

func (s *Server) handleCodexV2SessionFork(w http.ResponseWriter, r *http.Request) {
	threadID := strings.TrimSpace(r.PathValue("id"))
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	var req codexV2SessionActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	source, host, err := s.resolveCodexV2SessionHost(threadID, req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	project, err := s.resolveCodexV2SessionProject(source, host, req.ProjectID, req.Path, req.Title)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	var rpcResp codexV2ThreadResult
	if err := bridge.Call(r.Context(), "thread/fork", map[string]any{"threadId": threadID}, &rpcResp); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	newID := extractCodexThreadID(rpcResp.Thread)
	if newID == "" {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "thread/fork returned empty thread id"})
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = deriveCodexThreadTitle(rpcResp.Thread, newID)
	}
	if title == "" && source.ID != "" {
		title = "Fork · " + strings.TrimSpace(source.Title)
	}
	session, err := s.upsertCodexV2Session(newID, host, project, title)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session": session,
		"project": project,
		"thread":  rpcResp.Thread,
	})
}

func (s *Server) handleCodexV2SessionArchive(w http.ResponseWriter, r *http.Request) {
	threadID := strings.TrimSpace(r.PathValue("id"))
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	var req codexV2SessionActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	session, host, err := s.resolveCodexV2SessionHost(threadID, req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if err := bridge.Call(r.Context(), "thread/archive", map[string]any{"threadId": threadID}, nil); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	deletedSession, deleted, deleteErr := s.store.DeleteSession(threadID)
	if deleteErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": deleteErr.Error()})
		return
	}
	if deleted {
		s.closeSessionStreams(threadID)
		session = deletedSession
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"archived": true,
		"session":  session,
		"deleted":  deleted,
	})
}

func (s *Server) handleCodexV2SessionUnarchive(w http.ResponseWriter, r *http.Request) {
	threadID := strings.TrimSpace(r.PathValue("id"))
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	var req codexV2SessionActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	existing, host, err := s.resolveCodexV2SessionHost(threadID, req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	project, err := s.resolveCodexV2SessionProject(existing, host, req.ProjectID, req.Path, req.Title)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	var rpcResp codexV2ThreadResult
	if err := bridge.Call(r.Context(), "thread/unarchive", map[string]any{"threadId": threadID}, &rpcResp); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	resolvedID := extractCodexThreadID(rpcResp.Thread)
	if resolvedID == "" {
		resolvedID = threadID
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = deriveCodexThreadTitle(rpcResp.Thread, resolvedID)
	}
	session, err := s.upsertCodexV2Session(resolvedID, host, project, title)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session": session,
		"project": project,
		"thread":  rpcResp.Thread,
	})
}

func (s *Server) handleCodexV2SessionSetName(w http.ResponseWriter, r *http.Request) {
	threadID := strings.TrimSpace(r.PathValue("id"))
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	var req codexV2SessionActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name is required"})
		return
	}
	session, host, err := s.resolveCodexV2SessionHost(threadID, req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if err := bridge.Call(r.Context(), "thread/name/set", map[string]any{
		"threadId": threadID,
		"name":     name,
	}, nil); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	session.Title = name
	session.UpdatedAt = time.Now().UTC()
	saved, err := s.store.UpsertSession(session)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session": saved,
	})
}

func (s *Server) handleCodexV2TurnStart(w http.ResponseWriter, r *http.Request) {
	threadID := strings.TrimSpace(r.PathValue("id"))
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	var req codexV2TurnStartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	session, host, err := s.resolveCodexV2SessionHost(threadID, req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	input := codexV2BuildInput(req.Prompt, req.Input)
	if len(input) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "prompt or input is required"})
		return
	}
	payload := map[string]any{
		"threadId": threadID,
		"input":    input,
	}
	if modelName := strings.TrimSpace(req.Model); modelName != "" {
		payload["model"] = modelName
	}
	if cwd := strings.TrimSpace(req.Cwd); cwd != "" {
		payload["cwd"] = cwd
	} else if pathValue := strings.TrimSpace(session.Path); pathValue != "" {
		payload["cwd"] = pathValue
	}
	if approval := normalizeCodexV2Approval(req.ApprovalPolicy); approval != "" {
		payload["approvalPolicy"] = approval
	}
	if sandbox := normalizeCodexV2Sandbox(req.Sandbox); sandbox != "" {
		payload["sandbox"] = sandbox
	}
	if len(req.Metadata) > 0 {
		payload["metadata"] = req.Metadata
	}
	var out map[string]any
	if err := bridge.Call(r.Context(), "turn/start", payload, &out); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if session.ID != "" {
		session.LastStatus = "running"
		session.LastRunID = ""
		_, _ = s.store.UpsertSession(session)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCodexV2TurnInterrupt(w http.ResponseWriter, r *http.Request) {
	threadID := strings.TrimSpace(r.PathValue("id"))
	turnID := strings.TrimSpace(r.PathValue("turn_id"))
	if threadID == "" || turnID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session or turn id"})
		return
	}
	var req codexV2SessionActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	_, host, err := s.resolveCodexV2SessionHost(threadID, req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	var out map[string]any
	if err := bridge.Call(r.Context(), "turn/interrupt", map[string]any{
		"threadId": threadID,
		"turnId":   turnID,
	}, &out); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCodexV2TurnSteer(w http.ResponseWriter, r *http.Request) {
	threadID := strings.TrimSpace(r.PathValue("id"))
	turnID := strings.TrimSpace(r.PathValue("turn_id"))
	if threadID == "" || turnID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session or turn id"})
		return
	}
	var req codexV2TurnSteerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	_, host, err := s.resolveCodexV2SessionHost(threadID, req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	input := codexV2BuildInput(req.Prompt, req.Input)
	if len(input) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "prompt or input is required"})
		return
	}
	var out map[string]any
	if err := bridge.Call(r.Context(), "turn/steer", map[string]any{
		"threadId":       threadID,
		"expectedTurnId": turnID,
		"input":          input,
	}, &out); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCodexV2PendingRequests(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	items := s.listCodexPendingRequests(sessionID)
	writeJSON(w, http.StatusOK, map[string]any{
		"session_id": sessionID,
		"requests":   items,
	})
}

func (s *Server) handleCodexV2ResolveRequest(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	requestID := strings.TrimSpace(r.PathValue("request_id"))
	if sessionID == "" || requestID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session or request id"})
		return
	}
	record, ok := s.getCodexPendingRequest(sessionID, requestID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "pending request not found"})
		return
	}

	var req codexV2ResolveRequestBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	result := req.Result
	if len(result) == 0 && len(req.Decision) > 0 {
		result = json.RawMessage(append([]byte(`{"decision":`), append(req.Decision, '}')...))
	}
	if len(result) == 0 && req.Error == nil {
		result = json.RawMessage(`{}`)
	}

	host, ok := s.store.GetHost(strings.TrimSpace(record.HostID))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error":   "request host not found",
			"host_id": record.HostID,
		})
		return
	}
	bridge, err := s.codexBridgeForHost(host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if err := bridge.Respond(r.Context(), record.RawID, result, req.Error); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	s.deleteCodexPendingRequest(sessionID, requestID)
	writeJSON(w, http.StatusOK, map[string]any{
		"resolved":   true,
		"session_id": sessionID,
		"request_id": requestID,
	})
}

type codexV2SessionParams struct {
	model          string
	approvalPolicy string
	sandbox        string
	cwd            string
}

func (p codexV2SessionParams) ToMap(includeCwd bool) map[string]any {
	out := map[string]any{}
	if modelName := strings.TrimSpace(p.model); modelName != "" {
		out["model"] = modelName
	}
	if approval := normalizeCodexV2Approval(p.approvalPolicy); approval != "" {
		out["approvalPolicy"] = approval
	}
	if sandbox := normalizeCodexV2Sandbox(p.sandbox); sandbox != "" {
		out["sandbox"] = sandbox
	}
	if includeCwd {
		if cwd := strings.TrimSpace(p.cwd); cwd != "" {
			out["cwd"] = cwd
		}
	}
	return out
}

func normalizeCodexV2Approval(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "untrusted":
		return "untrusted"
	case "on-failure", "onfailure":
		return "onFailure"
	case "on-request", "onrequest":
		return "onRequest"
	case "never":
		return "never"
	case "unless-trusted", "unlesstrusted":
		return "unlessTrusted"
	default:
		return strings.TrimSpace(v)
	}
}

func normalizeCodexV2Sandbox(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "read-only", "readonly":
		return "readOnly"
	case "workspace-write", "workspacewrite":
		return "workspaceWrite"
	case "danger-full-access", "dangerfullaccess":
		return "dangerFullAccess"
	default:
		return strings.TrimSpace(v)
	}
}

func codexV2BuildInput(prompt string, input []map[string]any) []map[string]any {
	if len(input) > 0 {
		out := make([]map[string]any, 0, len(input))
		for _, item := range input {
			if len(item) == 0 {
				continue
			}
			out = append(out, item)
		}
		if len(out) > 0 {
			return out
		}
	}
	trimmed := strings.TrimSpace(prompt)
	if trimmed == "" {
		return nil
	}
	return []map[string]any{{"type": "text", "text": trimmed}}
}

func extractCodexThreadID(thread map[string]any) string {
	if len(thread) == 0 {
		return ""
	}
	if id, ok := thread["id"]; ok {
		return strings.TrimSpace(asString(id))
	}
	return ""
}

func deriveCodexThreadTitle(thread map[string]any, fallback string) string {
	if len(thread) > 0 {
		if preview, ok := thread["preview"]; ok {
			title := strings.TrimSpace(asString(preview))
			if title != "" {
				if len(title) <= 80 {
					return title
				}
				return strings.TrimSpace(title[:80])
			}
		}
	}
	return deriveSessionTitle("", fallback)
}

func (s *Server) resolveCodexV2Host(hostID string) (model.Host, error) {
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		return model.Host{}, errors.New("host_id is required")
	}
	host, ok := s.store.GetHost(hostID)
	if !ok {
		return model.Host{}, fmt.Errorf("host not found: %s", hostID)
	}
	return host, nil
}

func (s *Server) resolveCodexV2StartTarget(hostID string, projectID string, pathValue string, title string) (model.Host, model.ProjectRecord, error) {
	projectID = strings.TrimSpace(projectID)
	if projectID != "" {
		project, ok := s.store.GetProject(projectID)
		if !ok {
			return model.Host{}, model.ProjectRecord{}, fmt.Errorf("project not found: %s", projectID)
		}
		host, ok := s.store.GetHost(strings.TrimSpace(project.HostID))
		if !ok {
			return model.Host{}, model.ProjectRecord{}, fmt.Errorf("project host not found: %s", strings.TrimSpace(project.HostID))
		}
		return host, project, nil
	}
	host, err := s.resolveCodexV2Host(hostID)
	if err != nil {
		return model.Host{}, model.ProjectRecord{}, err
	}
	pathValue = strings.TrimSpace(pathValue)
	if pathValue == "" {
		pathValue = strings.TrimSpace(host.Workspace)
	}
	if pathValue == "" {
		pathValue = defaultProjectPath()
	}
	project := model.ProjectRecord{
		ID:       projectBindingID(host.ID, pathValue, "codex"),
		HostID:   strings.TrimSpace(host.ID),
		HostName: strings.TrimSpace(host.Name),
		Path:     pathValue,
		Title:    strings.TrimSpace(title),
		Runtime:  "codex",
	}
	saved, err := s.store.UpsertProject(project)
	if err != nil {
		return model.Host{}, model.ProjectRecord{}, err
	}
	return host, saved, nil
}

func (s *Server) resolveCodexV2SessionHost(threadID string, hostOverride string) (model.SessionRecord, model.Host, error) {
	threadID = strings.TrimSpace(threadID)
	existing, exists := s.store.GetSession(threadID)
	hostID := strings.TrimSpace(hostOverride)
	if hostID == "" && exists {
		hostID = strings.TrimSpace(existing.HostID)
	}
	if hostID == "" {
		return model.SessionRecord{}, model.Host{}, errors.New("host_id is required")
	}
	host, ok := s.store.GetHost(hostID)
	if !ok {
		return model.SessionRecord{}, model.Host{}, fmt.Errorf("host not found: %s", hostID)
	}
	if !exists {
		return model.SessionRecord{}, host, nil
	}
	return existing, host, nil
}

func (s *Server) resolveCodexV2SessionProject(
	session model.SessionRecord,
	host model.Host,
	projectID string,
	pathValue string,
	title string,
) (model.ProjectRecord, error) {
	projectID = strings.TrimSpace(projectID)
	if projectID != "" {
		project, ok := s.store.GetProject(projectID)
		if !ok {
			return model.ProjectRecord{}, fmt.Errorf("project not found: %s", projectID)
		}
		return project, nil
	}
	if strings.TrimSpace(session.ProjectID) != "" {
		project, ok := s.store.GetProject(strings.TrimSpace(session.ProjectID))
		if ok {
			return project, nil
		}
	}
	pathValue = strings.TrimSpace(pathValue)
	if pathValue == "" {
		pathValue = strings.TrimSpace(session.Path)
	}
	if pathValue == "" {
		pathValue = strings.TrimSpace(host.Workspace)
	}
	if pathValue == "" {
		pathValue = defaultProjectPath()
	}
	project := model.ProjectRecord{
		ID:       projectBindingID(host.ID, pathValue, "codex"),
		HostID:   strings.TrimSpace(host.ID),
		HostName: strings.TrimSpace(host.Name),
		Path:     pathValue,
		Title:    strings.TrimSpace(title),
		Runtime:  "codex",
	}
	return s.store.UpsertProject(project)
}

func (s *Server) upsertCodexV2Session(
	threadID string,
	host model.Host,
	project model.ProjectRecord,
	title string,
) (model.SessionRecord, error) {
	existing, exists := s.store.GetSession(threadID)
	session := model.SessionRecord{
		ID:        strings.TrimSpace(threadID),
		ProjectID: strings.TrimSpace(project.ID),
		HostID:    strings.TrimSpace(host.ID),
		Path:      strings.TrimSpace(project.Path),
		Runtime:   "codex",
		Title:     strings.TrimSpace(title),
	}
	if exists {
		session.RuntimeSessionID = existing.RuntimeSessionID
		session.LastRunID = existing.LastRunID
		session.LastStatus = existing.LastStatus
		if session.Title == "" {
			session.Title = existing.Title
		}
	}
	return s.store.UpsertSession(session)
}

func (s *Server) codexBridgeForHost(host model.Host) (*codexrpc.Bridge, error) {
	if s.codexBridge == nil {
		return nil, errors.New("codex bridge manager is unavailable")
	}
	bridge := s.codexBridge.BridgeForHost(host)
	s.ensureCodexBridgeSubscription(host, bridge)
	return bridge, nil
}

func (s *Server) ensureCodexBridgeSubscription(host model.Host, bridge *codexrpc.Bridge) {
	if bridge == nil {
		return
	}
	hostID := strings.TrimSpace(host.ID)
	if hostID == "" {
		hostID = strings.TrimSpace(host.Name)
	}
	if hostID == "" {
		hostID = strings.TrimSpace(host.Host)
	}
	if hostID == "" {
		return
	}

	s.mu.Lock()
	if s.codexBridgeSub == nil {
		s.codexBridgeSub = map[string]func(){}
	}
	if _, exists := s.codexBridgeSub[hostID]; exists {
		s.mu.Unlock()
		return
	}
	notifications, stopNotifications := bridge.SubscribeNotifications(512)
	requests, stopRequests := bridge.SubscribeServerRequests(128)
	stopAll := func() {
		stopNotifications()
		stopRequests()
	}
	s.codexBridgeSub[hostID] = stopAll
	s.mu.Unlock()

	go func() {
		for event := range notifications {
			s.persistCodexNotification(hostID, event.Method, event.Params, event.ReceivedAt)
		}
	}()
	go func() {
		for req := range requests {
			s.persistCodexServerRequest(hostID, req)
		}
	}()
}

func (s *Server) persistCodexNotification(hostID string, method string, params json.RawMessage, at time.Time) {
	sessionID := extractCodexNotificationSessionID(method, params)
	if sessionID == "" {
		return
	}
	eventType := "codexrpc." + strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(method), "/", "."), " ", "_")
	payload := map[string]any{
		"host_id":     strings.TrimSpace(hostID),
		"method":      strings.TrimSpace(method),
		"params":      params,
		"received_at": at,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	persisted, err := s.store.AppendSessionEvent(model.SessionEvent{
		SessionID: sessionID,
		Type:      eventType,
		Payload:   raw,
		CreatedAt: at,
	})
	if err != nil {
		return
	}
	s.publishSessionEvent(persisted)
	if strings.EqualFold(strings.TrimSpace(method), "serverRequest/resolved") {
		requestID := extractCodexResolvedRequestID(params)
		if requestID != "" {
			s.deleteCodexPendingRequest(sessionID, requestID)
		}
	}
}

func (s *Server) persistCodexServerRequest(hostID string, req codexrpc.ServerRequest) {
	method := "serverRequest/" + strings.TrimSpace(req.Method)
	sessionID := extractCodexNotificationSessionID(method, req.Params)
	if sessionID != "" {
		s.putCodexPendingRequest(codexPendingRequest{
			SessionID:  sessionID,
			RequestID:  strings.TrimSpace(req.ID),
			HostID:     strings.TrimSpace(hostID),
			Method:     strings.TrimSpace(req.Method),
			RawID:      append(json.RawMessage(nil), req.RawID...),
			Params:     append(json.RawMessage(nil), req.Params...),
			ReceivedAt: req.ReceivedAt,
		})
	}
	s.persistCodexNotification(hostID, method, req.Params, req.ReceivedAt)
}

func (s *Server) putCodexPendingRequest(record codexPendingRequest) {
	sessionID := strings.TrimSpace(record.SessionID)
	requestID := strings.TrimSpace(record.RequestID)
	if sessionID == "" || requestID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.codexPending == nil {
		s.codexPending = map[string]map[string]codexPendingRequest{}
	}
	if s.codexPending[sessionID] == nil {
		s.codexPending[sessionID] = map[string]codexPendingRequest{}
	}
	s.codexPending[sessionID][requestID] = record
}

func (s *Server) listCodexPendingRequests(sessionID string) []codexPendingRequest {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bySession := s.codexPending[sessionID]
	if len(bySession) == 0 {
		return nil
	}
	out := make([]codexPendingRequest, 0, len(bySession))
	for _, item := range bySession {
		out = append(out, item)
	}
	return out
}

func (s *Server) getCodexPendingRequest(sessionID string, requestID string) (codexPendingRequest, bool) {
	sessionID = strings.TrimSpace(sessionID)
	requestID = strings.TrimSpace(requestID)
	if sessionID == "" || requestID == "" {
		return codexPendingRequest{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bySession := s.codexPending[sessionID]
	if len(bySession) == 0 {
		return codexPendingRequest{}, false
	}
	item, ok := bySession[requestID]
	return item, ok
}

func (s *Server) deleteCodexPendingRequest(sessionID string, requestID string) {
	sessionID = strings.TrimSpace(sessionID)
	requestID = strings.TrimSpace(requestID)
	if sessionID == "" || requestID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bySession := s.codexPending[sessionID]
	if len(bySession) == 0 {
		return
	}
	delete(bySession, requestID)
	if len(bySession) == 0 {
		delete(s.codexPending, sessionID)
	}
}

func extractCodexResolvedRequestID(params json.RawMessage) string {
	if len(params) == 0 {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(params, &payload); err != nil {
		return ""
	}
	if value := strings.TrimSpace(asString(payload["requestId"])); value != "" {
		return value
	}
	if value := strings.TrimSpace(asString(payload["request_id"])); value != "" {
		return value
	}
	return ""
}

func extractCodexNotificationSessionID(method string, params json.RawMessage) string {
	method = strings.TrimSpace(method)
	if method == "" || len(params) == 0 {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(params, &payload); err != nil {
		return ""
	}
	if id := strings.TrimSpace(asString(payload["threadId"])); id != "" {
		return id
	}
	if id := strings.TrimSpace(asString(payload["thread_id"])); id != "" {
		return id
	}
	if threadObj, ok := payload["thread"].(map[string]any); ok {
		if id := strings.TrimSpace(asString(threadObj["id"])); id != "" {
			return id
		}
	}
	if turnObj, ok := payload["turn"].(map[string]any); ok {
		if id := strings.TrimSpace(asString(turnObj["threadId"])); id != "" {
			return id
		}
		if id := strings.TrimSpace(asString(turnObj["thread_id"])); id != "" {
			return id
		}
	}
	return ""
}

func asString(v any) string {
	switch value := v.(type) {
	case string:
		return value
	default:
		return ""
	}
}
