package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/hellsoul86/remote-llm-cli/server/internal/api"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
	"github.com/hellsoul86/remote-llm-cli/server/internal/store"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	data := flag.String("data", "./data/state.json", "state file path")
	flag.Parse()

	if err := api.ValidateConfig(*data); err != nil {
		log.Fatalf("invalid config: %v", err)
	}

	st, err := store.Open(*data)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}

	rt := runtime.NewRegistry(runtime.NewCodexAdapter())
	srv := api.New(st, rt)

	log.Printf("remote-llm-server listening on %s", *addr)
	log.Printf("state file: %s", *data)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}
