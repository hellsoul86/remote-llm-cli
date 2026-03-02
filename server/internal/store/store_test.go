package store

import (
	"encoding/json"
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

func TestRunJobLifecycleAndOrdering(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}

	queued := time.Now().UTC()
	jobA := model.RunJobRecord{
		ID:       "job_a",
		Type:     "run",
		Status:   "pending",
		Runtime:  "codex",
		QueuedAt: queued,
		Request:  json.RawMessage(`{"runtime":"codex","prompt":"a"}`),
	}
	jobB := model.RunJobRecord{
		ID:       "job_b",
		Type:     "run",
		Status:   "pending",
		Runtime:  "codex",
		QueuedAt: queued.Add(time.Second),
		Request:  json.RawMessage(`{"runtime":"codex","prompt":"b"}`),
	}
	if err := st.AddRunJob(jobA); err != nil {
		t.Fatalf("add run job a: %v", err)
	}
	if err := st.AddRunJob(jobB); err != nil {
		t.Fatalf("add run job b: %v", err)
	}

	jobs := st.ListRunJobs(2)
	if len(jobs) != 2 {
		t.Fatalf("len(jobs)=%d want=2", len(jobs))
	}
	if jobs[0].ID != "job_b" || jobs[1].ID != "job_a" {
		t.Fatalf("jobs ordering mismatch: got=%q,%q", jobs[0].ID, jobs[1].ID)
	}

	started := queued.Add(2 * time.Second)
	finished := queued.Add(3 * time.Second)
	jobA.Status = "succeeded"
	jobA.StartedAt = &started
	jobA.FinishedAt = &finished
	jobA.ResultStatus = 200
	jobA.Response = json.RawMessage(`{"runtime":"codex","summary":{"total":1}}`)
	jobA.DurationMS = 1234
	if err := st.UpdateRunJob(jobA); err != nil {
		t.Fatalf("update run job a: %v", err)
	}

	gotA, ok := st.GetRunJob("job_a")
	if !ok {
		t.Fatalf("job_a not found")
	}
	if gotA.Status != "succeeded" || gotA.ResultStatus != 200 {
		t.Fatalf("unexpected job_a state: status=%q result_status=%d", gotA.Status, gotA.ResultStatus)
	}
	if gotA.DurationMS != 1234 {
		t.Fatalf("job_a duration=%d want=1234", gotA.DurationMS)
	}

	gotB, ok := st.GetRunJob("job_b")
	if !ok {
		t.Fatalf("job_b not found")
	}
	if len(gotB.Request) == 0 {
		t.Fatalf("job_b request should not be empty")
	}

	// Ensure callers cannot mutate persisted request/response bytes through returned structs.
	gotB.Request[0] = 'X'
	gotBAgain, ok := st.GetRunJob("job_b")
	if !ok {
		t.Fatalf("job_b not found on second get")
	}
	if string(gotBAgain.Request) != `{"runtime":"codex","prompt":"b"}` {
		t.Fatalf("request bytes were unexpectedly mutated: %s", string(gotBAgain.Request))
	}
}
