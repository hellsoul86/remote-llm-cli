package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hellsoul86/remote-llm-cli/server/internal/tuiapp"
)

func main() {
	apiBase := flag.String("api", envOrDefault("REMOTE_LLM_API", "http://localhost:8080"), "remote-llm-server base URL")
	token := flag.String("token", envOrDefault("REMOTE_LLM_KEY", ""), "access key (or REMOTE_LLM_KEY)")
	runtime := flag.String("runtime", "codex", "runtime name")
	flag.Parse()

	if strings.TrimSpace(*token) == "" {
		fmt.Fprintln(os.Stderr, "missing access key: pass --token or set REMOTE_LLM_KEY")
		os.Exit(1)
	}

	client := tuiapp.NewAPIClient(*apiBase, *token)
	model := tuiapp.NewModel(client, strings.TrimSpace(*runtime))

	p := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "tui error:", err)
		os.Exit(1)
	}
}

func envOrDefault(key string, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
