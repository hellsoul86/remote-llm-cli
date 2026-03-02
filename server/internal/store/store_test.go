package store

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func TestCopyTailNewestFirst(t *testing.T) {
	src := []int{1, 2, 3, 4}
	got := copyTail(src, 2)
	if len(got) != 2 {
		t.Fatalf("len(got)=%d want=2", len(got))
	}
	if got[0] != 4 || got[1] != 3 {
		t.Fatalf("got=%v want=[4 3]", got)
	}
}

func TestCapTail(t *testing.T) {
	src := []int{1, 2, 3, 4}
	got := capTail(src, 2)
	if len(got) != 2 {
		t.Fatalf("len(got)=%d want=2", len(got))
	}
	if got[0] != 3 || got[1] != 4 {
		t.Fatalf("got=%v want=[3 4]", got)
	}
}

func TestRunAndAuditPersistenceAndOrdering(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}

	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		if err := st.AddRunRecord(model.RunRecord{
			ID:         "run_" + string(rune('a'+i)),
			Runtime:    "codex",
			StartedAt:  now.Add(time.Duration(i) * time.Second),
			FinishedAt: now.Add(time.Duration(i+1) * time.Second),
		}); err != nil {
			t.Fatalf("add run record %d: %v", i, err)
		}
		if err := st.AddAuditEvent(model.AuditEvent{
			ID:        "evt_" + string(rune('a'+i)),
			Method:    "GET",
			Path:      "/v1/hosts",
			Timestamp: now.Add(time.Duration(i) * time.Second),
		}); err != nil {
			t.Fatalf("add audit event %d: %v", i, err)
		}
	}

	runs := st.ListRunRecords(2)
	if len(runs) != 2 {
		t.Fatalf("len(runs)=%d want=2", len(runs))
	}
	if runs[0].ID != "run_c" || runs[1].ID != "run_b" {
		t.Fatalf("runs ordering mismatch: got=%q,%q", runs[0].ID, runs[1].ID)
	}

	events := st.ListAuditEvents(2)
	if len(events) != 2 {
		t.Fatalf("len(events)=%d want=2", len(events))
	}
	if events[0].ID != "evt_c" || events[1].ID != "evt_b" {
		t.Fatalf("events ordering mismatch: got=%q,%q", events[0].ID, events[1].ID)
	}
}
