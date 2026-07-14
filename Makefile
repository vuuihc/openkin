.PHONY: build test clean ui go-build

# Single binary with embedded UI (spec §10 M0).
build: ui go-build

ui:
	cd ui && npm install && npm run build

go-build:
	go build -o kin ./cmd/kin

test:
	go test ./...
	go vet ./...
	cd ui && npm install && npx tsc --noEmit

clean:
	rm -f kin
	rm -rf web/dist
	mkdir -p web/dist
	printf '%s\n' '<!doctype html><title>Kin</title><p>UI not built. Run make build.</p>' > web/dist/index.html
	rm -rf ui/node_modules ui/dist
