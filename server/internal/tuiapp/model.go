package tuiapp

import (
	"fmt"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const (
	paneControl = iota
	paneRuns
	paneAudit
)

type loadHostsMsg struct {
	hosts []Host
	err   error
}

type loadHistoryMsg struct {
	runs  []RunRecord
	audit []AuditEvent
	err   error
}

type runDoneMsg struct {
	status int
	resp   RunResponse
	err    error
}

type Model struct {
	client         *APIClient
	runtime        string
	hosts          []Host
	selected       map[string]bool
	cursor         int
	prompt         string
	workdir        string
	fanout         int
	allHosts       bool
	editingPrompt  bool
	editingWorkdir bool

	runHistory  []RunRecord
	auditEvents []AuditEvent
	activePane  int

	loading        bool
	historyLoading bool
	running        bool
	message        string

	lastStatus int
	lastRun    *RunResponse
}

func NewModel(client *APIClient, runtime string) Model {
	return Model{
		client:         client,
		runtime:        runtime,
		selected:       map[string]bool{},
		prompt:         "summarize git status and key risks",
		fanout:         3,
		allHosts:       true,
		message:        "loading hosts and history...",
		loading:        true,
		historyLoading: true,
		activePane:     paneControl,
	}
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(m.loadHostsCmd(), m.loadHistoryCmd())
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case loadHostsMsg:
		m.loading = false
		if msg.err != nil {
			m.message = "failed to load hosts: " + msg.err.Error()
			return m, nil
		}
		m.hosts = msg.hosts
		if len(m.hosts) > 0 {
			m.cursor = min(m.cursor, len(m.hosts)-1)
		} else {
			m.cursor = 0
		}
		m.message = fmt.Sprintf("loaded %d hosts", len(m.hosts))
		return m, nil
	case loadHistoryMsg:
		m.historyLoading = false
		if msg.err != nil {
			m.message = "failed to load history: " + msg.err.Error()
			return m, nil
		}
		m.runHistory = msg.runs
		m.auditEvents = msg.audit
		m.message = fmt.Sprintf("loaded history: %d runs, %d audit events", len(msg.runs), len(msg.audit))
		return m, nil
	case runDoneMsg:
		m.running = false
		if msg.err != nil {
			m.message = "run failed: " + msg.err.Error()
			return m, nil
		}
		m.lastStatus = msg.status
		m.lastRun = &msg.resp
		m.historyLoading = true
		m.message = fmt.Sprintf("run complete: http=%d total=%d failed=%d", msg.status, msg.resp.Summary.Total, msg.resp.Summary.Failed)
		return m, m.loadHistoryCmd()
	case tea.KeyMsg:
		if m.editingPrompt {
			switch msg.String() {
			case "esc", "enter":
				m.editingPrompt = false
				m.message = "prompt edit done"
				return m, nil
			case "backspace":
				if len(m.prompt) > 0 {
					m.prompt = m.prompt[:len(m.prompt)-1]
				}
				return m, nil
			default:
				if len(msg.Runes) > 0 && msg.Type == tea.KeyRunes {
					m.prompt += string(msg.Runes)
				}
				return m, nil
			}
		}
		if m.editingWorkdir {
			switch msg.String() {
			case "esc", "enter":
				m.editingWorkdir = false
				m.message = "workdir edit done"
				return m, nil
			case "backspace":
				if len(m.workdir) > 0 {
					m.workdir = m.workdir[:len(m.workdir)-1]
				}
				return m, nil
			default:
				if len(msg.Runes) > 0 && msg.Type == tea.KeyRunes {
					m.workdir += string(msg.Runes)
				}
				return m, nil
			}
		}
		switch msg.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "tab":
			m.activePane = (m.activePane + 1) % 3
			m.message = "switched pane: " + paneLabel(m.activePane)
			return m, nil
		case "h":
			if m.historyLoading {
				return m, nil
			}
			m.historyLoading = true
			m.message = "reloading history..."
			return m, m.loadHistoryCmd()
		case "r":
			if m.running {
				return m, nil
			}
			if strings.TrimSpace(m.prompt) == "" {
				m.message = "prompt is empty"
				return m, nil
			}
			if !m.allHosts && len(m.selectedHostIDs()) == 0 {
				m.message = "select at least one host or toggle all-hosts"
				return m, nil
			}
			m.running = true
			m.message = "running..."
			return m, m.runCmd()
		case "R":
			if m.loading || m.running || m.historyLoading {
				return m, nil
			}
			m.loading = true
			m.historyLoading = true
			m.message = "reloading hosts and history..."
			return m, tea.Batch(m.loadHostsCmd(), m.loadHistoryCmd())
		}

		if m.activePane != paneControl {
			return m, nil
		}

		switch msg.String() {
		case "up", "k":
			if len(m.hosts) > 0 && m.cursor > 0 {
				m.cursor--
			}
			return m, nil
		case "down", "j":
			if len(m.hosts) > 0 && m.cursor < len(m.hosts)-1 {
				m.cursor++
			}
			return m, nil
		case " ":
			if len(m.hosts) == 0 || m.allHosts {
				return m, nil
			}
			h := m.hosts[m.cursor]
			m.selected[h.ID] = !m.selected[h.ID]
			return m, nil
		case "a":
			m.allHosts = !m.allHosts
			if m.allHosts {
				m.message = "targeting all hosts"
			} else {
				m.message = "manual host selection mode"
			}
			return m, nil
		case "+", "=":
			if m.fanout < 64 {
				m.fanout++
			}
			return m, nil
		case "-", "_":
			if m.fanout > 1 {
				m.fanout--
			}
			return m, nil
		case "p":
			m.editingPrompt = true
			m.message = "editing prompt (Enter/Esc to finish)"
			return m, nil
		case "w":
			m.editingWorkdir = true
			m.message = "editing workdir (Enter/Esc to finish)"
			return m, nil
		}
	}
	return m, nil
}

func (m Model) View() string {
	var b strings.Builder
	b.WriteString("remote-llm-cli (TUI)\n")
	b.WriteString("runtime=" + m.runtime + "  ")
	b.WriteString(fmt.Sprintf("all_hosts=%t  fanout=%d  pane=%s\n", m.allHosts, m.fanout, paneLabel(m.activePane)))
	b.WriteString("keys: q quit | R reload all | r run | h reload-history | Tab switch-pane | a toggle-all | space toggle-host | p edit-prompt | w edit-workdir | +/- fanout\n")

	if m.loading {
		b.WriteString("[loading hosts...]\n")
	}
	if m.historyLoading {
		b.WriteString("[loading history...]\n")
	}

	switch m.activePane {
	case paneRuns:
		m.viewRunsPane(&b)
	case paneAudit:
		m.viewAuditPane(&b)
	default:
		m.viewControlPane(&b)
	}

	if m.message != "" {
		b.WriteString("\n" + m.message + "\n")
	}
	return b.String()
}

func (m Model) viewControlPane(b *strings.Builder) {
	if len(m.hosts) == 0 {
		b.WriteString("\n[no hosts]\n")
	} else {
		b.WriteString("\nHosts:\n")
		for i, h := range m.hosts {
			cursor := " "
			if i == m.cursor {
				cursor = ">"
			}
			mark := " "
			if m.allHosts || m.selected[h.ID] {
				mark = "x"
			}
			line := fmt.Sprintf("%s [%s] %s (%s@%s:%d)", cursor, mark, h.Name, safeUser(h.User), h.Host, safePort(h.Port))
			if h.Workspace != "" {
				line += " wd=" + h.Workspace
			}
			b.WriteString(line + "\n")
		}
	}

	if m.editingPrompt {
		b.WriteString("\nPrompt (editing):\n")
	} else {
		b.WriteString("\nPrompt:\n")
	}
	b.WriteString(m.prompt + "\n")

	if m.editingWorkdir {
		b.WriteString("\nWorkdir override (editing):\n")
	} else {
		b.WriteString("\nWorkdir override:\n")
	}
	if strings.TrimSpace(m.workdir) == "" {
		b.WriteString("<empty>\n")
	} else {
		b.WriteString(m.workdir + "\n")
	}

	if m.running {
		b.WriteString("\n[run in progress...]\n")
	}
	if m.lastRun != nil {
		b.WriteString("\nLast Run Summary:\n")
		b.WriteString(fmt.Sprintf("http=%d total=%d ok=%d failed=%d fanout=%d duration=%dms\n",
			m.lastStatus,
			m.lastRun.Summary.Total,
			m.lastRun.Summary.Succeeded,
			m.lastRun.Summary.Failed,
			m.lastRun.Summary.Fanout,
			m.lastRun.Summary.DurationMS,
		))
		b.WriteString("Targets:\n")
		for _, t := range m.lastRun.Targets {
			errText := ""
			if strings.TrimSpace(t.Error) != "" {
				errText = " err=" + strings.TrimSpace(t.Error)
			}
			b.WriteString(fmt.Sprintf("- %s ok=%t exit=%d dur=%dms%s\n",
				t.Host.Name,
				t.OK,
				t.Result.ExitCode,
				t.Result.DurationMS,
				errText,
			))
		}
	}
}

func (m Model) viewRunsPane(b *strings.Builder) {
	b.WriteString("\nRecent Runs:\n")
	if len(m.runHistory) == 0 {
		b.WriteString("no runs yet\n")
		return
	}
	for i, run := range m.runHistory {
		started := asTime(run.StartedAt).Format(time.RFC3339)
		b.WriteString(fmt.Sprintf("%2d. %s %s http=%d hosts=%d ok=%d failed=%d fanout=%d dur=%dms prompt=%q\n",
			i+1,
			started,
			run.Runtime,
			run.StatusCode,
			run.TotalHosts,
			run.SucceededHosts,
			run.FailedHosts,
			run.Fanout,
			run.DurationMS,
			clamp(run.PromptPreview, 80),
		))
	}
}

func (m Model) viewAuditPane(b *strings.Builder) {
	b.WriteString("\nAudit Events:\n")
	if len(m.auditEvents) == 0 {
		b.WriteString("no audit events yet\n")
		return
	}
	for i, evt := range m.auditEvents {
		ts := asTime(evt.Timestamp).Format(time.RFC3339)
		b.WriteString(fmt.Sprintf("%2d. %s %s %s %s status=%d dur=%dms\n",
			i+1,
			ts,
			evt.Action,
			evt.Method,
			evt.Path,
			evt.StatusCode,
			evt.DurationMS,
		))
	}
}

func (m Model) loadHostsCmd() tea.Cmd {
	return func() tea.Msg {
		hosts, err := m.client.ListHosts()
		return loadHostsMsg{hosts: hosts, err: err}
	}
}

func (m Model) loadHistoryCmd() tea.Cmd {
	return func() tea.Msg {
		runs, err := m.client.ListRuns(20)
		if err != nil {
			return loadHistoryMsg{err: err}
		}
		audit, err := m.client.ListAudit(100)
		return loadHistoryMsg{runs: runs, audit: audit, err: err}
	}
}

func (m Model) selectedHostIDs() []string {
	ids := make([]string, 0, len(m.selected))
	for id, ok := range m.selected {
		if ok {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (m Model) runCmd() tea.Cmd {
	req := RunRequest{
		Runtime:  m.runtime,
		Prompt:   m.prompt,
		AllHosts: m.allHosts,
		Fanout:   m.fanout,
		Workdir:  strings.TrimSpace(m.workdir),
	}
	if !m.allHosts {
		req.HostIDs = m.selectedHostIDs()
	}
	return func() tea.Msg {
		status, resp, err := m.client.Run(req)
		return runDoneMsg{status: status, resp: resp, err: err}
	}
}

func safeUser(v string) string {
	if strings.TrimSpace(v) == "" {
		return "?"
	}
	return v
}

func safePort(v int) int {
	if v <= 0 {
		return 22
	}
	return v
}

func paneLabel(pane int) string {
	switch pane {
	case paneRuns:
		return "runs"
	case paneAudit:
		return "audit"
	default:
		return "control"
	}
}

func asTime(v string) time.Time {
	t, err := time.Parse(time.RFC3339, v)
	if err == nil {
		return t
	}
	return time.Time{}
}

func clamp(v string, max int) string {
	s := strings.TrimSpace(v)
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func min(a int, b int) int {
	if a < b {
		return a
	}
	return b
}
