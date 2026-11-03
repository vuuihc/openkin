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
		"ui.theme":              "dark",
		"provider.api_key":      "sk-secret",
		"daemon.token":          "master-secret",
		"providers":             `{"entries":[{"api_key":"sk-nested"}]}`,
		"push.apns.private_key": "-----BEGIN PRIVATE KEY-----\napns-secret\n-----END PRIVATE KEY-----",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertDeviceCredential(ctx, DeviceCredential{
		ID: "ios-device", TokenHash: "hash", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "push-1", InstallID: "install-0001", Platform: "ios",
		Token:       "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
		Environment: "sandbox", UpdatedAt: NowMilli(),
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
	if strings.Contains(text, "sk-secret") || strings.Contains(text, "master-secret") ||
		strings.Contains(text, "sk-nested") || strings.Contains(text, "apns-secret") {
		t.Fatalf("secret leaked in settings export: %s", text)
	}
	if _, err := os.Stat(filepath.Join(dir, "device_credentials.jsonl")); !os.IsNotExist(err) {
		t.Fatal("device credentials were exported")
	}
	if _, err := os.Stat(filepath.Join(dir, "push_devices.jsonl")); !os.IsNotExist(err) {
		t.Fatal("push device tokens were exported")
	}
}
