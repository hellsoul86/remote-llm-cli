package main

import (
	"flag"
	"log"
	"net/http"
	"strings"

	"github.com/hellsoul86/remote-llm-cli/server/internal/api"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
	"github.com/hellsoul86/remote-llm-cli/server/internal/store"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	data := flag.String("data", "./data/state.json", "state file path")
	runtimeConfig := flag.String("runtime-config", "", "optional runtime config json path")
	flag.Parse()

	if err := api.ValidateConfig(*data); err != nil {
		log.Fatalf("invalid config: %v", err)
	}

	st, err := store.Open(*data)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}

	rt := runtime.NewRegistry(
		runtime.NewCodexAdapter(),
		runtime.NewClaudeCodeAdapter(),
	)
	if path := strings.TrimSpace(*runtimeConfig); path != "" {
		adapters, err := runtime.LoadTemplateAdaptersFromFile(path)
		if err != nil {
			log.Fatalf("load runtime config: %v", err)
		}
		for _, adapter := range adapters {
			if err := rt.Add(adapter); err != nil {
				if strings.Contains(err.Error(), "runtime already registered") {
					log.Printf("skip runtime %q from config: %v", adapter.Name(), err)
					continue
				}
				log.Fatalf("register runtime %q: %v", adapter.Name(), err)
			}
		}
		log.Printf("loaded %d runtime adapters from %s", len(adapters), path)
	}
	srv := api.New(st, rt)

	log.Printf("remote-llm-server listening on %s", *addr)
	log.Printf("state file: %s", *data)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}
