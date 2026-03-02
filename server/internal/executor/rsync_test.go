package executor

import (
	"reflect"
	"testing"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func TestBuildRsyncArgs(t *testing.T) {
	h := model.Host{
		Host:         "10.0.0.1",
		User:         "ecs-user",
		Port:         2222,
		IdentityFile: "/tmp/id_rsa",
	}
	args := buildRsyncArgs(h, "./local", "/srv/work", SyncOptions{
		Delete:   true,
		Excludes: []string{"node_modules", " .git "},
	})
	wantPrefix := []string{
		"-az",
		"--delete",
		"--exclude", "node_modules",
		"--exclude", ".git",
		"-e",
	}
	if len(args) < len(wantPrefix)+2 {
		t.Fatalf("args too short: %v", args)
	}
	if !reflect.DeepEqual(args[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("args prefix mismatch:\n got=%v\nwant=%v", args[:len(wantPrefix)], wantPrefix)
	}
	if args[len(args)-2] != "./local" {
		t.Fatalf("src mismatch: %q", args[len(args)-2])
	}
	if args[len(args)-1] != "ecs-user@10.0.0.1:/srv/work" {
		t.Fatalf("dst mismatch: %q", args[len(args)-1])
	}
}
