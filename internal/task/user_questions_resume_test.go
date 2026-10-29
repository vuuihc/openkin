package task

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

// Answering a card after the turn ended must not drag the task back to
// running. The resume is guarded in the UPDATE, so the same call that would
// have raced a finishing turn here simply finds nothing to resume.
func TestAnsweringAfterTheTurnEndedLeavesTheTaskTerminal(t *testing.T) {
	ctx := context.Background()
	e, st := testEngine(t, 1, &fakeAdapter{events: successEvents()})
	task := store.Task{
		ID: "01ANSWERAFTEREND0000000001", Title: "ended", Agent: "kin",
		Cwd: "/tmp", Prompt: "p", Status: StatusSucceeded,
		CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	question := store.UserQuestion{
		ID: "01QUESTIONAFTEREND000000001", TaskID: task.ID,
		Payload: json.RawMessage(`{"question":"Pick?"}`),
		Status:  store.UQStatusPending, CreatedAt: store.NowMilli(),
	}
	if err := st.InsertUserQuestion(ctx, question); err != nil {
		t.Fatal(err)
	}

	if _, err := e.AnswerUserQuestion(ctx, question.ID, AnswerUserQuestionRequest{Selected: []string{"A"}}, "web"); err != nil {
		t.Fatalf("answer: %v", err)
	}

	got, err := e.Get(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusSucceeded {
		t.Fatalf("status=%q want succeeded", got.Status)
	}
}
