package genericcli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/vuuihc/kin/internal/adapter/detect"
)

func TestSmokeExitZero(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script smoke on unix")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "fakecli")
	script := "#!/bin/sh\nexit 0\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	inv := detect.Invocation{
		Mode: "text",
		Args: []string{"{{prompt}}"},
	}
	res := Smoke(context.Background(), inv, bin)
	if !res.OK {
		t.Fatalf("%+v", res)
	}
}

func TestSmokeNonZero(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script smoke on unix")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "fakecli")
	script := "#!/bin/sh\necho boom >&2\nexit 2\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	inv := detect.Invocation{
		Mode: "text",
		Args: []string{"{{prompt}}"},
	}
	res := Smoke(context.Background(), inv, bin)
	if res.OK {
		t.Fatal("expected failure")
	}
	if res.Detail == "" {
		t.Fatal("expected detail")
	}
}

func TestSmokeMissingBinary(t *testing.T) {
	res := Smoke(context.Background(), detect.Invocation{Args: []string{"{{prompt}}"}}, "")
	if res.OK {
		t.Fatal("expected fail")
	}
}
