package execcap

import (
	"testing"
	"time"
)

func TestIssueAndVerify(t *testing.T) {
	iss := NewIssuer()
	token, err := iss.Issue("task-1", "exec-1", "codex", 0, "", []string{"workspace:request"}, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if token == "" {
		t.Fatal("empty token")
	}

	claims, err := iss.Verify(token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.TaskID != "task-1" {
		t.Fatalf("task_id=%q", claims.TaskID)
	}
	if claims.ExecutionID != "exec-1" {
		t.Fatalf("execution_id=%q", claims.ExecutionID)
	}
	if claims.Agent != "codex" {
		t.Fatalf("agent=%q", claims.Agent)
	}
}

func TestVerifyRejectsTampered(t *testing.T) {
	iss := NewIssuer()
	token, err := iss.Issue("task-1", "exec-1", "codex", 0, "", nil, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	// Tamper with the payload
	_, err = iss.Verify(token + "x")
	if err == nil {
		t.Fatal("expected error for tampered token")
	}
}

func TestVerifyExpired(t *testing.T) {
	iss := NewIssuer()
	// Use a very short TTL (1ms) and sleep to ensure expiry
	token, err := iss.Issue("task-1", "exec-1", "codex", 0, "", nil, 1*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}

	time.Sleep(5 * time.Millisecond)

	_, err = iss.Verify(token)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
}

func TestRotateInvalidatesPrevious(t *testing.T) {
	iss := NewIssuer()
	token, err := iss.Issue("task-1", "exec-1", "codex", 0, "", nil, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	iss.Rotate()

	_, err = iss.Verify(token)
	if err == nil {
		t.Fatal("expected error after rotation")
	}
}

func TestVerifyRejectsWrongExecution(t *testing.T) {
	iss := NewIssuer()
	token, err := iss.Issue("task-1", "exec-1", "codex", 0, "", nil, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	// Verify with same issuer should pass
	claims, err := iss.Verify(token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.ExecutionID != "exec-1" {
		t.Fatalf("execution_id=%q", claims.ExecutionID)
	}
}

func TestIssueRejectsEmptyTaskID(t *testing.T) {
	iss := NewIssuer()
	_, err := iss.Issue("", "exec-1", "codex", 0, "", nil, 5*time.Minute)
	if err == nil {
		t.Fatal("expected error for empty task_id")
	}
}

func TestIssueRejectsEmptyExecutionID(t *testing.T) {
	iss := NewIssuer()
	_, err := iss.Issue("task-1", "", "codex", 0, "", nil, 5*time.Minute)
	if err == nil {
		t.Fatal("expected error for empty execution_id")
	}
}

func TestSecondIssuerRejectsFirstTokens(t *testing.T) {
	iss1 := NewIssuer()
	token, err := iss1.Issue("task-1", "exec-1", "codex", 0, "", nil, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	iss2 := NewIssuer()
	_, err = iss2.Verify(token)
	if err == nil {
		t.Fatal("expected error verifying with different issuer")
	}
}
