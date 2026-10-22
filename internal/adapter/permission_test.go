package adapter

import (
	"context"
	"testing"
)

func TestNormalizePermissionMode(t *testing.T) {
	cases := map[string]string{
		"":                             PermissionDefault,
		"default":                      PermissionDefault,
		"accept_edits":                 PermissionAcceptEdits,
		"acceptEdits":                  PermissionAcceptEdits,
		"accept-edits":                 PermissionAcceptEdits,
		"yolo":                         PermissionYOLO,
		"bypass":                       PermissionYOLO,
		"bypassPermissions":            PermissionYOLO,
		"dangerously-skip-permissions": PermissionYOLO,
		"weird":                        PermissionDefault,
	}
	for in, want := range cases {
		if got := NormalizePermissionMode(in); got != want {
			t.Fatalf("NormalizePermissionMode(%q)=%q want %q", in, got, want)
		}
	}
}

// plainAdapter has no opinion about its own permission mapping.
type plainAdapter struct{}

func (plainAdapter) Start(context.Context, TaskSpec) (RunHandle, error) { return nil, nil }

// TestAutoApprovesAllDefaultsToTheModeName pins the fallback for an adapter that
// cannot say what a mode does for it: only yolo is read as a bypass.
func TestAutoApprovesAllDefaultsToTheModeName(t *testing.T) {
	for mode, want := range map[string]bool{
		PermissionDefault:              false,
		"":                             false,
		PermissionAcceptEdits:          false,
		"acceptEdits":                  false,
		PermissionYOLO:                 true,
		"bypassPermissions":            true,
		"dangerously-skip-permissions": true,
	} {
		if got := AutoApprovesAll(plainAdapter{}, mode); got != want {
			t.Fatalf("AutoApprovesAll(plain, %q) = %v, want %v", mode, got, want)
		}
	}
}
