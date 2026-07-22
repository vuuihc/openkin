package provider

import (
	"strings"
	"testing"
)

func TestResolveAPIKey(t *testing.T) {
	t.Setenv("KIN_TEST_PROVIDER_KEY", "secret-value")

	tests := []struct {
		name    string
		input   string
		want    string
		wantErr string
	}{
		{name: "literal", input: "literal-key", want: "literal-key"},
		{name: "braced reference", input: "${KIN_TEST_PROVIDER_KEY}", want: "secret-value"},
		{name: "plain reference", input: "$KIN_TEST_PROVIDER_KEY", want: "secret-value"},
		{name: "missing", input: "${KIN_TEST_MISSING_KEY}", wantErr: "is not set"},
		{name: "invalid", input: "${}", wantErr: "invalid"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveAPIKey(tt.input)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %v, want substring %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
