package sleepguard

import (
	"context"
	"errors"
	"testing"
)

type fakeProcess struct{ killed bool }

func (p *fakeProcess) Kill() error {
	p.killed = true
	return nil
}

func TestGuardStartsAndStopsOnce(t *testing.T) {
	var starts int
	process := &fakeProcess{}
	guard := NewWithStarter(func(context.Context) (Process, error) {
		starts++
		return process, nil
	})
	ctx := context.Background()
	if err := guard.SetActive(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := guard.SetActive(ctx, true); err != nil {
		t.Fatal(err)
	}
	if starts != 1 {
		t.Fatalf("starts = %d, want 1", starts)
	}
	if err := guard.SetActive(ctx, false); err != nil {
		t.Fatal(err)
	}
	if !process.killed {
		t.Fatal("sleep inhibitor was not killed")
	}
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestGuardDoesNotMarkActiveWhenStartFails(t *testing.T) {
	want := errors.New("caffeinate unavailable")
	guard := NewWithStarter(func(context.Context) (Process, error) {
		return nil, want
	})
	if err := guard.SetActive(context.Background(), true); !errors.Is(err, want) {
		t.Fatalf("start error = %v", err)
	}
	if err := guard.SetActive(context.Background(), false); err != nil {
		t.Fatal(err)
	}
}
