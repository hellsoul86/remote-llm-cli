package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/accesskey"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/store"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "key":
		handleKey(os.Args[2:])
	default:
		printUsage()
		os.Exit(1)
	}
}

func handleKey(args []string) {
	if len(args) < 1 {
		printKeyUsage()
		os.Exit(1)
	}
	switch args[0] {
	case "create":
		keyCreate(args[1:])
	case "list":
		keyList(args[1:])
	case "revoke":
		keyRevoke(args[1:])
	default:
		printKeyUsage()
		os.Exit(1)
	}
}

func keyCreate(args []string) {
	fs := flag.NewFlagSet("key create", flag.ExitOnError)
	data := fs.String("data", "./data/state.json", "state file path")
	name := fs.String("name", "default", "key name")
	_ = fs.Parse(args)

	st := mustStore(*data)
	full, prefix, secret, err := accesskey.Generate()
	if err != nil {
		log.Fatalf("generate key: %v", err)
	}
	hash, err := accesskey.HashSecret(secret)
	if err != nil {
		log.Fatalf("hash key: %v", err)
	}
	k := model.AccessKey{
		ID:        fmt.Sprintf("k_%d", time.Now().UTC().UnixNano()),
		Name:      strings.TrimSpace(*name),
		Prefix:    prefix,
		Hash:      hash,
		CreatedAt: time.Now().UTC(),
	}
	if err := st.AddKey(k); err != nil {
		log.Fatalf("save key: %v", err)
	}
	fmt.Printf("created access key %s (%s)\n", k.ID, k.Name)
	fmt.Printf("key: %s\n", full)
	fmt.Printf("redacted: %s\n", accesskey.Redact(full))
	fmt.Println("note: this key is shown only once")
}

func keyList(args []string) {
	fs := flag.NewFlagSet("key list", flag.ExitOnError)
	data := fs.String("data", "./data/state.json", "state file path")
	jsonOut := fs.Bool("json", false, "print json")
	_ = fs.Parse(args)

	st := mustStore(*data)
	keys := st.ListKeys()
	if *jsonOut {
		raw, _ := json.MarshalIndent(map[string]any{"access_keys": keys}, "", "  ")
		fmt.Println(string(raw))
		return
	}
	for _, k := range keys {
		fmt.Printf("id=%s name=%s prefix=%s created_at=%s revoked=%t\n", k.ID, k.Name, k.Prefix, k.CreatedAt.Format(time.RFC3339), k.RevokedAt != nil)
	}
}

func keyRevoke(args []string) {
	fs := flag.NewFlagSet("key revoke", flag.ExitOnError)
	data := fs.String("data", "./data/state.json", "state file path")
	id := fs.String("id", "", "key id")
	_ = fs.Parse(args)
	if strings.TrimSpace(*id) == "" {
		log.Fatal("--id is required")
	}
	st := mustStore(*data)
	ok, err := st.RevokeKey(strings.TrimSpace(*id))
	if err != nil {
		log.Fatalf("revoke key: %v", err)
	}
	if !ok {
		log.Fatalf("key not found: %s", *id)
	}
	fmt.Printf("revoked key %s\n", *id)
}

func mustStore(path string) *store.Store {
	st, err := store.Open(path)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	return st
}

func printUsage() {
	fmt.Println("remote-llm-admin usage:")
	fmt.Println("  remote-llm-admin key create --name default [--data ./data/state.json]")
	fmt.Println("  remote-llm-admin key list [--json] [--data ./data/state.json]")
	fmt.Println("  remote-llm-admin key revoke --id k_xxx [--data ./data/state.json]")
}

func printKeyUsage() {
	fmt.Println("key subcommands: create | list | revoke")
}
