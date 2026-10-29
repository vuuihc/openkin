package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// A decision that lands as the turn ends must not reopen a finished row.
//
// The approval path reads the task, then writes "running" when it was waiting.
// Between those two statements the turn can finish; an unconditional update
// then moves a succeeded row back to running with nothing left to finish it
// again, and the task sits in the list forever. The predicate belongs in the
// UPDATE.
func TestResumeTaskFromWaitRefusesAFinishedRow(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	now := time.Now().UnixMilli()

	cases := []struct {
		name   string
		status string
		want   string
		wantOK bool
	}{
		{name: "waiting approval resumes", status: "waiting_approval", want: "running", wantOK: true},
		{name: "waiting input resumes", status: "waiting_input", want: "running", wantOK: true},
		{name: "succeeded stays finished", status: "succeeded", want: "succeeded"},
		{name: "canceled stays canceled", status: "canceled", want: "canceled"},
		{name: "failed stays failed", status: "failed", want: "failed"},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id := taskIDForCase(i)
			if err := s.InsertTask(ctx, Task{
				ID: id, Title: "resume", Agent: "kin", Cwd: "/tmp",
				Prompt: "p", Status: tc.status, CreatedAt: now,
			}); err != nil {
				t.Fatal(err)
			}
			err := s.ResumeTaskFromWait(ctx, id, "running", "waiting_approval", "waiting_input")
			if tc.wantOK && err != nil {
				t.Fatalf("resume: %v", err)
			}
			if !tc.wantOK && !errors.Is(err, ErrConflict) {
				t.Fatalf("resume %s err=%v want ErrConflict", tc.status, err)
			}
			got, err := s.GetTask(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != tc.want {
				t.Fatalf("status=%q want %q", got.Status, tc.want)
			}
		})
	}
}

func TestResumeTaskFromWaitRejectsAnEmptyArgument(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.ResumeTaskFromWait(context.Background(), "", "running", "waiting_approval"); err == nil {
		t.Fatal("an empty task id must be refused")
	}
	if err := s.ResumeTaskFromWait(context.Background(), "01X", "running"); err == nil {
		t.Fatal("a resume with no wait state must be refused")
	}
}

func taskIDForCase(i int) string {
	return "01RESUMEWAIT000000000000" + string(rune('A'+i))
}
