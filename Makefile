.PHONY: server-test server-run key-create tui-run web-install web-dev web-build

server-test:
	cd server && go test ./...

server-run:
	cd server && go run ./cmd/remote-llm-server --addr :8080 --data ./data/state.json

key-create:
	cd server && go run ./cmd/remote-llm-admin key create --name default --data ./data/state.json

tui-run:
	cd server && go run ./cmd/remote-llm-cli --api http://localhost:8080 --runtime codex

web-install:
	cd web && npm install

web-dev:
	cd web && npm run dev

web-build:
	cd web && npm run build
