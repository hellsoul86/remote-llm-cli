package store

import (
	"encoding/json"
	"fmt"
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

func TestRetentionPolicyUpdateCapsRecords(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	now := time.Now().UTC()
	for i := 0; i < 150; i++ {
		if err := st.AddRunRecord(model.RunRecord{
			ID:         fmt.Sprintf("run_%03d", i),
			Runtime:    "codex",
			StartedAt:  now.Add(time.Duration(i) * time.Second),
			FinishedAt: now.Add(time.Duration(i+1) * time.Second),
		}); err != nil {
			t.Fatalf("add run record %d: %v", i, err)
		}
	}
	policy, err := st.UpdateRetentionPolicy(model.RetentionPolicy{
		RunRecordsMax:  100,
		RunJobsMax:     100,
		AuditEventsMax: 100,
	})
	if err != nil {
		t.Fatalf("update retention: %v", err)
	}
	if policy.RunRecordsMax != 100 {
		t.Fatalf("run_records_max=%d want=100", policy.RunRecordsMax)
	}
	if got := st.ListRunRecords(0); len(got) != 100 {
		t.Fatalf("run records count=%d want=100", len(got))
	}
}

func TestRunJobHostIDsAreCloned(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	job := model.RunJobRecord{
		ID:       "job_hosts",
		Type:     "run",
		Status:   "pending",
		Runtime:  "codex",
		QueuedAt: time.Now().UTC(),
		HostIDs:  []string{"h_1", "h_2"},
	}
	if err := st.AddRunJob(job); err != nil {
		t.Fatalf("add run job: %v", err)
	}
	got, ok := st.GetRunJob(job.ID)
	if !ok {
		t.Fatalf("job not found")
	}
	got.HostIDs[0] = "mutated"
	again, ok := st.GetRunJob(job.ID)
	if !ok {
		t.Fatalf("job not found on second read")
	}
	if again.HostIDs[0] != "h_1" {
		t.Fatalf("host ids unexpectedly mutated: %#v", again.HostIDs)
	}
}

func TestSessionEventsPersistAndPaginateBySeq(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	st, err := Open(statePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	first, err := st.AppendSessionEvent(model.SessionEvent{
		SessionID: "session_a",
		RunID:     "job_1",
		Type:      "run.started",
		Payload:   json.RawMessage(`{"status":"running"}`),
	})
	if err != nil {
		t.Fatalf("append first event: %v", err)
	}
	second, err := st.AppendSessionEvent(model.SessionEvent{
		SessionID: "session_a",
		RunID:     "job_1",
		Type:      "assistant.delta",
		Payload:   json.RawMessage(`{"chunk":"hello"}`),
	})
	if err != nil {
		t.Fatalf("append second event: %v", err)
	}
	if _, err := st.AppendSessionEvent(model.SessionEvent{
		SessionID: "session_b",
		RunID:     "job_2",
		Type:      "run.started",
	}); err != nil {
		t.Fatalf("append other session event: %v", err)
	}
	if first.Seq != 1 || second.Seq != 2 {
		t.Fatalf("unexpected seqs: first=%d second=%d", first.Seq, second.Seq)
	}
	page := st.ListSessionEvents("session_a", 0, 10)
	if len(page) != 2 {
		t.Fatalf("session_a events=%d want=2", len(page))
	}
	if page[0].Seq != 1 || page[1].Seq != 2 {
		t.Fatalf("session_a seq ordering mismatch: got=%d,%d", page[0].Seq, page[1].Seq)
	}
	nextPage := st.ListSessionEvents("session_a", 1, 10)
	if len(nextPage) != 1 || nextPage[0].Seq != 2 {
		t.Fatalf("after cursor mismatch: %#v", nextPage)
	}

	reopened, err := Open(statePath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	third, err := reopened.AppendSessionEvent(model.SessionEvent{
		SessionID: "session_a",
		RunID:     "job_3",
		Type:      "run.completed",
	})
	if err != nil {
		t.Fatalf("append third event after reopen: %v", err)
	}
	if third.Seq != 3 {
		t.Fatalf("third seq=%d want=3", third.Seq)
	}
}

func TestProjectAndSessionBindingLifecycle(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	project, err := st.UpsertProject(model.ProjectRecord{
		ID:       "project_h1::/srv/app",
		HostID:   "h1",
		HostName: "staging",
		Path:     "/srv/app",
		Runtime:  "codex",
	})
	if err != nil {
		t.Fatalf("upsert project: %v", err)
	}
	if project.ID == "" || project.CreatedAt.IsZero() {
		t.Fatalf("invalid project: %#v", project)
	}
	session, err := st.UpsertSession(model.SessionRecord{
		ID:         "session_1",
		ProjectID:  project.ID,
		HostID:     "h1",
		Path:       "/srv/app",
		Runtime:    "codex",
		Title:      "Initial",
		LastRunID:  "job_1",
		LastStatus: "pending",
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}
	if session.ID != "session_1" {
		t.Fatalf("session id=%q", session.ID)
	}
	got, ok := st.GetSession("session_1")
	if !ok {
		t.Fatalf("session not found")
	}
	if got.ProjectID != project.ID || got.LastRunID != "job_1" {
		t.Fatalf("unexpected session state: %#v", got)
	}
	got.LastStatus = "succeeded"
	if _, err := st.UpsertSession(got); err != nil {
		t.Fatalf("update session: %v", err)
	}
	projects := st.ListProjects(10)
	if len(projects) != 1 {
		t.Fatalf("projects=%d want=1", len(projects))
	}
	sessions := st.ListSessions(10)
	if len(sessions) != 1 {
		t.Fatalf("sessions=%d want=1", len(sessions))
	}
	if sessions[0].LastStatus != "succeeded" {
		t.Fatalf("session last_status=%q want=succeeded", sessions[0].LastStatus)
	}
}
