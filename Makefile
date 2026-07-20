.PHONY: build test clean ui go-build setup-dev desktop-dev desktop-dist desktop-icons desktop-rebuild dev

# Single binary with embedded UI (spec §10 M0).
build: ui go-build

ui:
	cd ui && npm install && npm run build

go-build:
	go build -o kin ./cmd/kin

setup-dev:
	./scripts/setup-dev.sh

# Full-stack local dev: Vite HMR + Go rebuild/restart on change.
# Open http://127.0.0.1:5173  (API proxied to :7777)
# Extra serve flags: make dev ARGS='--lan'   or  KIN_SERVE_ARGS='--lan' make dev
dev:
	./scripts/dev.sh $(ARGS)

test:
	go test ./...
	go vet ./...
	cd ui && npm install && npx tsc --noEmit

# --- Desktop shell (Electron; macOS arm64 only) ---
# Dev: uses repo-root ./kin as sidecar. Does not package.
desktop-dev: go-build desktop-icons
	cd desktop && npm install && npm run dev

# Full rebuild + restart desktop: UI embed + kin + kill :7777 + Electron.
# Use this when you changed frontend or need a clean daemon restart.
desktop-rebuild:
	./scripts/desktop-rebuild.sh

# Packaged .dmg under desktop/dist-electron/ (unsigned).
# Bundles a freshly built kin binary via extraResources.
desktop-dist: build desktop-icons
	mkdir -p desktop/resources
	cp -f kin desktop/resources/kin
	chmod +x desktop/resources/kin
	cd desktop && npm install && npm run dist

desktop-icons:
	cd desktop && node scripts/gen-icons.mjs

clean:
	rm -f kin
	rm -rf .kin-dev
	rm -rf web/dist
	mkdir -p web/dist
	printf '%s\n' '<!doctype html><title>Kin</title><p>UI not built. Run make build.</p>' > web/dist/index.html
	rm -rf ui/node_modules ui/dist
	rm -rf desktop/node_modules desktop/dist desktop/dist-electron desktop/resources/kin
