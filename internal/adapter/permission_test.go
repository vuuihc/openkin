package adapter

import "testing"

func TestNormalizePermissionMode(t *testing.T) {
	cases := map[string]string{
		"":                    PermissionDefault,
		"default":             PermissionDefault,
		"accept_edits":        PermissionAcceptEdits,
		"acceptEdits":         PermissionAcceptEdits,
		"accept-edits":        PermissionAcceptEdits,
		"yolo":                PermissionYOLO,
		"bypass":              PermissionYOLO,
		"bypassPermissions":   PermissionYOLO,
		"dangerously-skip-permissions": PermissionYOLO,
		"weird":               PermissionDefault,
	}
	for in, want := range cases {
		if got := NormalizePermissionMode(in); got != want {
			t.Fatalf("NormalizePermissionMode(%q)=%q want %q", in, got, want)
		}
	}
}
