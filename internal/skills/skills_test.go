package skills

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSkill(t *testing.T, root, name, version, body string) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	content := "---\n" +
		"name: " + name + "\n" +
		"version: " + version + "\n" +
		"supported_agents: kin, codex\n" +
		"permissions: read_files\n" +
		"---\n" + body + "\n"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestLoadPackageValidatesManifestAndTree(t *testing.T) {
	root := t.TempDir()
	dir := writeSkill(t, root, "review-code", "1.2.3", "Inspect code and report risks.")
	got, err := LoadPackage(dir, ScopeUser)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "review-code" || got.Version != "1.2.3" || got.Scope != ScopeUser {
		t.Fatalf("manifest=%+v", got)
	}
	if got.Instructions == "" {
		t.Fatal("missing instructions")
	}
}

func TestLoadPackageRejectsUnsafeDeclarations(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "unsafe")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(
		"---\nname: unsafe\nversion: 1.0.0\npermissions: network\nnetwork_domains: example.com\n---\nuse it\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "escape")); err != nil {
		t.Fatal(err)
	}
	_, err := LoadPackage(dir, ScopeUser)
	if !errors.Is(err, ErrUnsafePackage) {
		t.Fatalf("error=%v want ErrUnsafePackage", err)
	}
}

func TestManagerPrecedenceAndAgentFilter(t *testing.T) {
	bundled := t.TempDir()
	user := t.TempDir()
	project := t.TempDir()
	projectSkills := filepath.Join(project, ".kin", "skills")
	if err := os.MkdirAll(projectSkills, 0o700); err != nil {
		t.Fatal(err)
	}
	writeSkill(t, bundled, "same-skill", "1.0.0", "bundled")
	writeSkill(t, user, "same-skill", "2.0.0", "user")
	writeSkill(t, projectSkills, "same-skill", "3.0.0", "project")
	writeSkill(t, user, "other-skill", "1.0.0", "other")
	dir := filepath.Join(user, "other-skill")
	raw := strings.Replace(string(mustRead(t, filepath.Join(dir, "SKILL.md"))),
		"supported_agents: kin, codex", "supported_agents: codex", 1)
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(Config{BundledDir: bundled, UserDir: user})
	got, err := manager.List(context.Background(), project, "kin")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Version != "3.0.0" || got[0].Scope != ScopeProject {
		t.Fatalf("skills=%+v", got)
	}
}

func TestManagerContextIncludesAuditReferences(t *testing.T) {
	user := t.TempDir()
	writeSkill(t, user, "ship-check", "1.0.0", "Run the release checks.")
	ctx, err := NewManager(Config{UserDir: user}).Context(context.Background(), "", "kin")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ctx.Instructions, "ship-check@1.0.0") || len(ctx.References) != 1 {
		t.Fatalf("context=%+v", ctx)
	}
}

func TestImportLocalSkill(t *testing.T) {
	source := t.TempDir()
	writeSkill(t, source, "local-skill", "1.0.0", "local instructions")
	dest := filepath.Join(t.TempDir(), "imported")
	got, err := NewManager(Config{}).Import(context.Background(), ImportRequest{Source: filepath.Join(source, "local-skill"), Dest: dest})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "local-skill" {
		t.Fatalf("manifest=%+v", got)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
