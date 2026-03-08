package api

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func runGitCommand(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	raw, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v output=%s", strings.Join(args, " "), err, string(raw))
	}
	return string(raw)
}

func initProjectGitRepo(t *testing.T) string {
	t.Helper()

	workdir := t.TempDir()
	runGitCommand(t, workdir, "init")
	runGitCommand(t, workdir, "checkout", "-b", "main")
	runGitCommand(t, workdir, "config", "user.email", "codex@example.com")
	runGitCommand(t, workdir, "config", "user.name", "Codex Test")

	srcDir := filepath.Join(workdir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "app.ts"), []byte("export const shell = 'legacy';\n"), 0o644); err != nil {
		t.Fatalf("write tracked file: %v", err)
	}
	runGitCommand(t, workdir, "add", "src/app.ts")
	runGitCommand(t, workdir, "commit", "-m", "Initial commit")

	if err := os.WriteFile(filepath.Join(srcDir, "app.ts"), []byte("export const shell = 'native';\n"), 0o644); err != nil {
		t.Fatalf("update tracked file: %v", err)
	}
	docsDir := filepath.Join(workdir, "docs")
	if err := os.MkdirAll(docsDir, 0o755); err != nil {
		t.Fatalf("mkdir docs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(docsDir, "review-plan.md"), []byte("# Review plan\n"), 0o644); err != nil {
		t.Fatalf("write untracked file: %v", err)
	}
	return workdir
}

func TestProjectGitActionsTrackRepoStatus(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	workdir := initProjectGitRepo(t)
	host.ConnectionMode = "local"
	host.Workspace = workdir
	host.Host = "localhost"
	host.User = ""
	updatedHost, err := srv.store.UpsertHost(host)
	if err != nil {
		t.Fatalf("upsert local host: %v", err)
	}
	project, err := srv.store.UpsertProject(model.ProjectRecord{
		ID:       "project_git_1",
		HostID:   updatedHost.ID,
		HostName: updatedHost.Name,
		Path:     workdir,
		Title:    "native review",
		Runtime:  "codex",
	})
	if err != nil {
		t.Fatalf("upsert project: %v", err)
	}

	var status projectGitStatusSnapshot
	statusCode := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v2/projects/%s/git/status", httpSrv.URL, project.ID),
		token,
		nil,
		&status,
	)
	if statusCode != http.StatusOK {
		t.Fatalf("status code=%d want=200", statusCode)
	}
	if !slices.Equal(status.ChangedPaths, []string{"docs/review-plan.md", "src/app.ts"}) {
		t.Fatalf("changed_paths=%v", status.ChangedPaths)
	}
	if status.Branch != "main" {
		t.Fatalf("branch=%q want=main", status.Branch)
	}
	if len(status.StagedPaths) != 0 {
		t.Fatalf("staged_paths=%v want empty", status.StagedPaths)
	}

	var stageResp projectGitActionResponse
	statusCode = doJSON(
		t,
		httpSrv.Client(),
		http.MethodPost,
		fmt.Sprintf("%s/v2/projects/%s/git/stage", httpSrv.URL, project.ID),
		token,
		map[string]any{"paths": []string{"src/app.ts"}},
		&stageResp,
	)
	if statusCode != http.StatusOK {
		t.Fatalf("stage status code=%d want=200", statusCode)
	}
	if !slices.Contains(stageResp.Status.StagedPaths, "src/app.ts") {
		t.Fatalf("staged_paths=%v should contain src/app.ts", stageResp.Status.StagedPaths)
	}
	if stageResp.Status.Branch != "main" {
		t.Fatalf("branch=%q want=main", stageResp.Status.Branch)
	}

	var revertResp projectGitActionResponse
	statusCode = doJSON(
		t,
		httpSrv.Client(),
		http.MethodPost,
		fmt.Sprintf("%s/v2/projects/%s/git/revert", httpSrv.URL, project.ID),
		token,
		map[string]any{"paths": []string{"docs/review-plan.md"}},
		&revertResp,
	)
	if statusCode != http.StatusOK {
		t.Fatalf("revert status code=%d want=200", statusCode)
	}
	if slices.Contains(revertResp.Status.ChangedPaths, "docs/review-plan.md") {
		t.Fatalf("changed_paths=%v should not contain reverted docs file", revertResp.Status.ChangedPaths)
	}
	if revertResp.Status.Branch != "main" {
		t.Fatalf("branch=%q want=main", revertResp.Status.Branch)
	}
	if _, err := os.Stat(filepath.Join(workdir, "docs", "review-plan.md")); !os.IsNotExist(err) {
		t.Fatalf("expected reverted docs file to be removed, stat err=%v", err)
	}

	var commitResp projectGitActionResponse
	statusCode = doJSON(
		t,
		httpSrv.Client(),
		http.MethodPost,
		fmt.Sprintf("%s/v2/projects/%s/git/commit", httpSrv.URL, project.ID),
		token,
		map[string]any{"message": "Native review commit"},
		&commitResp,
	)
	if statusCode != http.StatusOK {
		t.Fatalf("commit status code=%d want=200", statusCode)
	}
	if len(commitResp.Status.ChangedPaths) != 0 {
		t.Fatalf("changed_paths=%v want empty after commit", commitResp.Status.ChangedPaths)
	}
	if len(commitResp.Status.StagedPaths) != 0 {
		t.Fatalf("staged_paths=%v want empty after commit", commitResp.Status.StagedPaths)
	}
	if commitResp.Status.Branch != "main" {
		t.Fatalf("branch=%q want=main", commitResp.Status.Branch)
	}
	if got := strings.TrimSpace(runGitCommand(t, workdir, "log", "-1", "--pretty=%s")); got != "Native review commit" {
		t.Fatalf("last commit message=%q want=Native review commit", got)
	}
}
