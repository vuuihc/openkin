package web

import "embed"

// FS is the built UI (Vite output under dist/).
//
// Vite writes to web/dist (see ui/vite.config.ts). Keeping the build output in a
// subdirectory avoids emptyOutDir deleting this embed.go file.
//
//go:embed all:dist
var FS embed.FS
