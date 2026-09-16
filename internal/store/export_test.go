package store

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportDirectoryExcludesCredentialsAndSecrets(t *testing.T) {
	s := openDeviceTestStore(t)
	ctx := context.Background()
	if err := s.SetSettings(ctx, map[string]string{
		"ui.theme": "dark",
		"provider.api_key": "sk-secret",
		"daemon.token": "master-secret",
		"providers": `{"entries":[{"api_key":"sk-nested"}]}`,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertDeviceCredential(ctx, DeviceCredential{
		ID: "ios-device", TokenHash: "hash", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := s.ExportDirectory(ctx, dir); err != nil {
		t.Fatal(err)
	}
	settings, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(settings)
	if strings.Contains(text, "sk-secret") || strings.Contains(text, "master-secret") || strings.Contains(text, "sk-nested") {
		t.Fatalf("secret leaked in settings export: %s", text)
	}
	if _, err := os.Stat(filepath.Join(dir, "device_credentials.jsonl")); !os.IsNotExist(err) {
		t.Fatal("device credentials were exported")
	}
}
