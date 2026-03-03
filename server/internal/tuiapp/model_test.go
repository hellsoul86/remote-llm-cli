package tuiapp

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestModelKeyToggleSmoke(t *testing.T) {
	m := NewModel(nil, "codex")

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("u")})
	m1 := next.(Model)
	if !m.runAsync || m1.runAsync {
		t.Fatalf("runAsync toggle failed: before=%t after=%t", m.runAsync, m1.runAsync)
	}

	next, _ = m1.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("t")})
	m2 := next.(Model)
	if m2.codexMode == m1.codexMode {
		t.Fatalf("codex mode did not cycle: %q", m1.codexMode)
	}

	next, _ = m2.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	m3 := next.(Model)
	if m3.allHosts == m2.allHosts {
		t.Fatalf("allHosts toggle failed")
	}
}

func TestBuildRunRequestUsesSelectedHosts(t *testing.T) {
	m := NewModel(nil, "codex")
	m.allHosts = false
	m.selected = map[string]bool{"h_2": true, "h_1": true}
	m.prompt = "smoke"
	req := m.buildRunRequest()
	if req.AllHosts {
		t.Fatalf("AllHosts should be false")
	}
	if len(req.HostIDs) != 2 {
		t.Fatalf("HostIDs len=%d want=2", len(req.HostIDs))
	}
	if req.HostIDs[0] != "h_1" || req.HostIDs[1] != "h_2" {
		t.Fatalf("HostIDs not sorted: %#v", req.HostIDs)
	}
}

func TestHostConnectionMode(t *testing.T) {
	if got := hostConnectionMode(Host{}); got != "ssh" {
		t.Fatalf("default mode=%q want=ssh", got)
	}
	if got := hostConnectionMode(Host{ConnectionMode: "local"}); got != "local" {
		t.Fatalf("mode=%q want=local", got)
	}
}
