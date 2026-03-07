package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/hellsoul86/remote-llm-cli/server/internal/executor"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
)

const (
	projectGitStatusMaxStdoutBytes = 512 * 1024
	projectGitStatusMaxStderrBytes = 128 * 1024
)

type projectGitFileStatus struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Staged  bool   `json:"staged"`
	Changed bool   `json:"changed"`
}

type projectGitStatusSnapshot struct {
	ProjectID    string                 `json:"project_id"`
	HostID       string                 `json:"host_id"`
	Files        []projectGitFileStatus `json:"files"`
	ChangedPaths []string               `json:"changed_paths"`
	StagedPaths  []string               `json:"staged_paths"`
}

type projectGitActionRequest struct {
	Paths   []string `json:"paths,omitempty"`
	Message string   `json:"message,omitempty"`
}

type projectGitActionResponse struct {
	Action  string                   `json:"action"`
	Paths   []string                 `json:"paths,omitempty"`
	Message string                   `json:"message,omitempty"`
	Result  executor.ExecResult      `json:"result"`
	Status  projectGitStatusSnapshot `json:"status"`
}

func (s *Server) handleGetProjectGitStatus(w http.ResponseWriter, r *http.Request) {
	projectID := strings.TrimSpace(r.PathValue("id"))
	if projectID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing project id"})
		return
	}
	project, host, err := s.resolveProjectTerminalTarget(projectID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	status, err := s.collectProjectGitStatus(r.Context(), projectID, host.ID, host, strings.TrimSpace(project.Path))
	if err != nil {
		s.writeProjectGitExecError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleStageProjectGitPaths(w http.ResponseWriter, r *http.Request) {
	s.handleProjectGitAction(w, r, "stage")
}

func (s *Server) handleRevertProjectGitPaths(w http.ResponseWriter, r *http.Request) {
	s.handleProjectGitAction(w, r, "revert")
}

func (s *Server) handleCommitProjectGitChanges(w http.ResponseWriter, r *http.Request) {
	s.handleProjectGitAction(w, r, "commit")
}

func (s *Server) handleProjectGitAction(w http.ResponseWriter, r *http.Request, action string) {
	projectID := strings.TrimSpace(r.PathValue("id"))
	if projectID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing project id"})
		return
	}
	project, host, err := s.resolveProjectTerminalTarget(projectID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	var req projectGitActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}

	paths := normalizeProjectGitPaths(req.Paths)
	spec, err := buildProjectGitActionSpec(action, paths, req.Message)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	result, err := s.runViaSSH(r.Context(), host, spec, strings.TrimSpace(project.Path), executor.ExecOptions{
		MaxStdoutBytes: projectGitStatusMaxStdoutBytes,
		MaxStderrBytes: projectGitStatusMaxStderrBytes,
	})
	if err != nil {
		s.writeProjectGitExecError(w, err)
		return
	}
	status, err := s.collectProjectGitStatus(r.Context(), projectID, host.ID, host, strings.TrimSpace(project.Path))
	if err != nil {
		s.writeProjectGitExecError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, projectGitActionResponse{
		Action:  action,
		Paths:   paths,
		Message: strings.TrimSpace(req.Message),
		Result:  result,
		Status:  status,
	})
}

func (s *Server) collectProjectGitStatus(
	ctx context.Context,
	projectID string,
	hostID string,
	host model.Host,
	workdir string,
) (projectGitStatusSnapshot, error) {
	result, err := s.runViaSSH(ctx, host, runtime.CommandSpec{
		Program: "git",
		Args: []string{
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--no-renames",
		},
	}, workdir, executor.ExecOptions{
		MaxStdoutBytes: projectGitStatusMaxStdoutBytes,
		MaxStderrBytes: projectGitStatusMaxStderrBytes,
	})
	if err != nil {
		return projectGitStatusSnapshot{}, err
	}
	files := parseProjectGitStatus(result.Stdout)
	changedPaths := make([]string, 0, len(files))
	stagedPaths := make([]string, 0, len(files))
	for _, item := range files {
		if item.Changed {
			changedPaths = append(changedPaths, item.Path)
		}
		if item.Staged {
			stagedPaths = append(stagedPaths, item.Path)
		}
	}
	sort.Strings(changedPaths)
	sort.Strings(stagedPaths)
	return projectGitStatusSnapshot{
		ProjectID:    projectID,
		HostID:       hostID,
		Files:        files,
		ChangedPaths: changedPaths,
		StagedPaths:  stagedPaths,
	}, nil
}

func parseProjectGitStatus(stdout string) []projectGitFileStatus {
	lines := strings.Split(stdout, "\n")
	out := make([]projectGitFileStatus, 0, len(lines))
	for _, rawLine := range lines {
		line := strings.TrimRight(rawLine, "\r")
		if len(line) < 4 {
			continue
		}
		code := line[:2]
		path := strings.TrimSpace(line[3:])
		if path == "" {
			continue
		}
		if strings.HasPrefix(path, "\"") && strings.HasSuffix(path, "\"") {
			if unquoted, err := strconv.Unquote(path); err == nil {
				path = unquoted
			}
		}
		staged := code[0] != ' ' && code[0] != '?'
		changed := code != "  "
		out = append(out, projectGitFileStatus{
			Path:    path,
			Code:    code,
			Staged:  staged,
			Changed: changed,
		})
	}
	return out
}

func buildProjectGitActionSpec(action string, paths []string, message string) (runtime.CommandSpec, error) {
	switch strings.TrimSpace(action) {
	case "stage":
		if len(paths) == 0 {
			return runtime.CommandSpec{}, errBadRequest("paths are required")
		}
		args := append([]string{"add", "--"}, paths...)
		return runtime.CommandSpec{Program: "git", Args: args}, nil
	case "revert":
		if len(paths) == 0 {
			return runtime.CommandSpec{}, errBadRequest("paths are required")
		}
		args := []string{
			"-lc",
			`for p in "$@"; do if git cat-file -e "HEAD:$p" 2>/dev/null; then git restore --staged --worktree --source=HEAD -- "$p"; else git rm -r --cached --force --ignore-unmatch -- "$p" >/dev/null 2>&1 || true; rm -rf -- "$p"; fi; done`,
			"project-git-revert",
		}
		args = append(args, paths...)
		return runtime.CommandSpec{Program: "sh", Args: args}, nil
	case "commit":
		trimmedMessage := strings.TrimSpace(message)
		if trimmedMessage == "" {
			return runtime.CommandSpec{}, errBadRequest("commit message is required")
		}
		return runtime.CommandSpec{
			Program: "git",
			Args:    []string{"commit", "-m", trimmedMessage},
		}, nil
	default:
		return runtime.CommandSpec{}, errBadRequest("unsupported git action")
	}
}

func normalizeProjectGitPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := map[string]struct{}{}
	for _, raw := range paths {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func (s *Server) writeProjectGitExecError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	if executor.ErrorClassOf(err) == string(executor.ErrorClassCommand) {
		status = http.StatusConflict
	}
	writeJSON(w, status, map[string]any{"error": err.Error()})
}

type badRequestError struct {
	message string
}

func (e badRequestError) Error() string { return e.message }

func errBadRequest(message string) error {
	return badRequestError{message: strings.TrimSpace(message)}
}
