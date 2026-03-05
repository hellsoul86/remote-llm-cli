package api

import (
	"fmt"
	"os"
	"strings"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func projectBindingID(hostID string, pathValue string, runtimeName string) string {
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		hostID = "local"
	}
	pathValue = strings.TrimSpace(pathValue)
	if pathValue == "" {
		pathValue = "/"
	}
	runtimeName = strings.TrimSpace(runtimeName)
	if runtimeName == "" {
		runtimeName = "codex"
	}
	return "project_" + hostID + "::" + runtimeName + "::" + pathValue
}

func defaultProjectPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "/"
	}
	home = strings.TrimSpace(home)
	if home == "" {
		return "/"
	}
	return home
}

func deriveSessionTitle(promptPreview string, sessionID string) string {
	title := strings.TrimSpace(promptPreview)
	if title == "" {
		return strings.TrimSpace(sessionID)
	}
	if len(title) <= 80 {
		return title
	}
	return strings.TrimSpace(title[:80])
}

func (s *Server) ensureSessionBinding(job model.RunJobRecord, req runRequest, hosts []model.Host) (bool, string, error) {
	sessionID := normalizeSessionID(job.SessionID, job.ID)
	if sessionID == "" {
		return false, "", nil
	}
	primaryHost := model.Host{}
	if len(hosts) > 0 {
		primaryHost = hosts[0]
	}
	projectPath := strings.TrimSpace(resolveWorkdir(req.Workdir, primaryHost.Workspace))
	if projectPath == "" {
		projectPath = defaultProjectPath()
	}
	runtimeName := strings.TrimSpace(job.Runtime)
	if runtimeName == "" {
		runtimeName = "codex"
	}
	project := model.ProjectRecord{
		ID:       projectBindingID(primaryHost.ID, projectPath, runtimeName),
		HostID:   strings.TrimSpace(primaryHost.ID),
		HostName: strings.TrimSpace(primaryHost.Name),
		Path:     projectPath,
		Runtime:  runtimeName,
	}
	projectRecord, err := s.store.UpsertProject(project)
	if err != nil {
		return false, "", fmt.Errorf("upsert project binding: %w", err)
	}

	existing, exists := s.store.GetSession(sessionID)
	title := deriveSessionTitle(job.PromptPreview, sessionID)
	if exists && strings.TrimSpace(existing.Title) != "" {
		title = strings.TrimSpace(existing.Title)
	}
	titleUpdated := !exists
	if exists && strings.TrimSpace(existing.Title) != strings.TrimSpace(title) {
		titleUpdated = true
	}
	session := model.SessionRecord{
		ID:               sessionID,
		ProjectID:        projectRecord.ID,
		HostID:           strings.TrimSpace(primaryHost.ID),
		Path:             projectPath,
		Runtime:          runtimeName,
		RuntimeSessionID: existing.RuntimeSessionID,
		Title:            title,
		LastRunID:        strings.TrimSpace(job.ID),
		LastStatus:       strings.TrimSpace(job.Status),
	}
	if _, err := s.store.UpsertSession(session); err != nil {
		return false, "", fmt.Errorf("upsert session binding: %w", err)
	}
	return titleUpdated, title, nil
}

func (s *Server) updateSessionRunState(job model.RunJobRecord) error {
	sessionID := normalizeSessionID(job.SessionID, job.ID)
	if sessionID == "" {
		return nil
	}
	session, ok := s.store.GetSession(sessionID)
	if !ok {
		return nil
	}
	session.LastRunID = strings.TrimSpace(job.ID)
	session.LastStatus = strings.TrimSpace(job.Status)
	if strings.TrimSpace(session.Runtime) == "" {
		session.Runtime = strings.TrimSpace(job.Runtime)
	}
	_, err := s.store.UpsertSession(session)
	return err
}
