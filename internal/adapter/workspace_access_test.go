package adapter

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// fakeAdapter returns a minimal adapter for testing middleware.
func fakeAdapter(ok bool) Adapter {
	return &mockAdapter{ok: ok}
}

type mockAdapter struct {
	ok bool
}

func (m *mockAdapter) Start(_ context.Context, spec TaskSpec) (RunHandle, error) {
	if !m.ok {
		return nil, nil
	}
	return nil, nil
}

func TestWithCwdValidation_AcceptsDirectory(t *testing.T) {
	dir := t.TempDir()
	inner := fakeAdapter(true)
	wrapped := WithCwdValidation(inner)

	_, err := wrapped.Start(context.Background(), TaskSpec{
		Cwd: dir,
	})
	if err != nil {
		t.Fatalf("expected no error for valid directory, got: %v", err)
	}
}

func TestWithCwdValidation_RejectsMissing(t *testing.T) {
	inner := fakeAdapter(true)
	wrapped := WithCwdValidation(inner)

	_, err := wrapped.Start(context.Background(), TaskSpec{
		Cwd: filepath.Join(t.TempDir(), "nonexistent"),
	})
	if err == nil {
		t.Fatal("expected error for missing directory, got nil")
	}
}

func TestWithCwdValidation_RejectsFile(t *testing.T) {
	dir := t.TempDir()
	f, err := os.CreateTemp(dir, "file")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	inner := fakeAdapter(true)
	wrapped := WithCwdValidation(inner)

	_, err = wrapped.Start(context.Background(), TaskSpec{
		Cwd: f.Name(),
	})
	if err == nil {
		t.Fatal("expected error for file path, got nil")
	}
}
