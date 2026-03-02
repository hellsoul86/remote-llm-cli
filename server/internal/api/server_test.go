package api

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
	"github.com/hellsoul86/remote-llm-cli/server/internal/store"
)

func TestResolveRunHostsSingle(t *testing.T) {
	s, hosts := makeTestServerWithHosts(t)
	got, err := s.resolveRunHosts(runRequest{HostID: hosts[0].ID})
	if err != nil {
		t.Fatalf("resolveRunHosts returned error: %v", err)
	}
	if len(got) != 1 || got[0].ID != hosts[0].ID {
		t.Fatalf("unexpected hosts: %#v", got)
	}
}

func TestResolveRunHostsManyDedup(t *testing.T) {
	s, hosts := makeTestServerWithHosts(t)
	got, err := s.resolveRunHosts(runRequest{HostIDs: []string{hosts[0].ID, hosts[1].ID, hosts[0].ID}})
	if err != nil {
		t.Fatalf("resolveRunHosts returned error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 hosts, got %d", len(got))
	}
	if got[0].ID != hosts[0].ID || got[1].ID != hosts[1].ID {
		t.Fatalf("unexpected host order: %#v", got)
	}
}

func TestResolveRunHostsAll(t *testing.T) {
	s, hosts := makeTestServerWithHosts(t)
	got, err := s.resolveRunHosts(runRequest{AllHosts: true})
	if err != nil {
		t.Fatalf("resolveRunHosts returned error: %v", err)
	}
	if len(got) != len(hosts) {
		t.Fatalf("expected %d hosts, got %d", len(hosts), len(got))
	}
}

func TestResolveRunHostsMutualExclusive(t *testing.T) {
	s, hosts := makeTestServerWithHosts(t)
	_, err := s.resolveRunHosts(runRequest{HostID: hosts[0].ID, AllHosts: true})
	if err == nil {
		t.Fatalf("expected error for mixed selectors")
	}
}

func TestInferAction(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		want   string
	}{
		{name: "runtimes", method: http.MethodGet, path: "/v1/runtimes", want: "runtime.list"},
		{name: "hosts list", method: http.MethodGet, path: "/v1/hosts", want: "host.list"},
		{name: "hosts upsert", method: http.MethodPost, path: "/v1/hosts", want: "host.upsert"},
		{name: "host delete", method: http.MethodDelete, path: "/v1/hosts/h_1", want: "host.delete"},
		{name: "host probe dynamic", method: http.MethodPost, path: "/v1/hosts/h_1/probe", want: "host.probe"},
		{name: "run execute", method: http.MethodPost, path: "/v1/run", want: "run.execute"},
		{name: "run list", method: http.MethodGet, path: "/v1/runs", want: "run.list"},
		{name: "audit list", method: http.MethodGet, path: "/v1/audit", want: "audit.list"},
		{name: "unknown", method: http.MethodPatch, path: "/v1/other", want: "request"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := inferAction(tc.method, tc.path)
			if got != tc.want {
				t.Fatalf("inferAction(%q,%q)=%q want=%q", tc.method, tc.path, got, tc.want)
			}
		})
	}
}

func makeTestServerWithHosts(t *testing.T) (*Server, []model.Host) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	host1, err := st.UpsertHost(model.Host{Name: "h1", Host: "10.0.0.1", User: "u1", Port: 22})
	if err != nil {
		t.Fatalf("upsert host1: %v", err)
	}
	host2, err := st.UpsertHost(model.Host{Name: "h2", Host: "10.0.0.2", User: "u2", Port: 22})
	if err != nil {
		t.Fatalf("upsert host2: %v", err)
	}
	s := New(st, runtime.NewRegistry(runtime.NewCodexAdapter()))
	return s, []model.Host{host1, host2}
}
