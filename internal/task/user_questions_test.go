package task

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
)

func longRunningAdapter() *fakeAdapter {
	return &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 30 * time.Second,
	}
}

func TestRequestUserQuestionTransition(t *testing.T) {
	ctx := context.Background()
	e, _ := testEngine(t, 4, longRunningAdapter())

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	busCh := e.Bus().Subscribe()
	defer e.Bus().Unsubscribe(busCh)

	q, err := e.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID:   task.ID,
		Question: "Which auth method?",
		Header:   "Auth method",
		Options: []UserQuestionOption{
			{Label: "JWT", Description: "stateless"},
			{Label: "Session"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if q.Status != store.UQStatusPending {
		t.Fatalf("status=%s", q.Status)
	}

	got, err := e.Get(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusWaitingInput {
		t.Fatalf("task status=%s want waiting_input", got.Status)
	}

	evs, _ := e.Events(ctx, task.ID, 0)
	var sawRequested bool
	for _, ev := range evs {
		if ev.Type == "user_question_requested" {
			sawRequested = true
			break
		}
	}
	if !sawRequested {
		t.Fatal("missing user_question_requested event")
	}

	var sawTask, sawQ bool
	deadline := time.After(time.Second)
	for !sawTask || !sawQ {
		select {
		case msg := <-busCh:
			switch msg.Kind {
			case "task_update":
				sawTask = true
			case "user_question_update":
				sawQ = true
			}
		case <-deadline:
			t.Fatalf("bus messages: task=%v q=%v", sawTask, sawQ)
		}
	}

	ans, err := e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{Selected: []string{"JWT"}}, "web")
	if err != nil {
		t.Fatal(err)
	}
	if ans.Status != store.UQStatusAnswered {
		t.Fatalf("answer status=%s", ans.Status)
	}
	got, _ = e.Get(ctx, task.ID)
	if got.Status != StatusRunning {
		t.Fatalf("after answer status=%s want running", got.Status)
	}

	_, err = e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{Selected: []string{"Session"}}, "web")
	if !errors.Is(err, ErrAlreadyAnswered) {
		t.Fatalf("second answer err=%v", err)
	}
}

func TestAnswerUserQuestionKeepsWaitingWhenOtherPending(t *testing.T) {
	ctx := context.Background()
	e, _ := testEngine(t, 4, longRunningAdapter())

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	q1, err := e.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID: task.ID, Question: "Q1?",
		Options: []UserQuestionOption{{Label: "A"}, {Label: "B"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	q2, err := e.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID: task.ID, Question: "Q2?",
		Options: []UserQuestionOption{{Label: "C"}, {Label: "D"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.AnswerUserQuestion(ctx, q1.ID, AnswerUserQuestionRequest{Selected: []string{"A"}}, "web"); err != nil {
		t.Fatal(err)
	}
	got, _ := e.Get(ctx, task.ID)
	if got.Status != StatusWaitingInput {
		t.Fatalf("status=%s want still waiting_input (q2 pending)", got.Status)
	}
	if _, err := e.AnswerUserQuestion(ctx, q2.ID, AnswerUserQuestionRequest{Selected: []string{"C"}}, "web"); err != nil {
		t.Fatal(err)
	}
	got, _ = e.Get(ctx, task.ID)
	if got.Status != StatusRunning {
		t.Fatalf("status=%s want running", got.Status)
	}
}

func TestWaitUserQuestionUnblocksOnAnswer(t *testing.T) {
	ctx := context.Background()
	e, _ := testEngine(t, 4, longRunningAdapter())

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	q, err := e.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID: task.ID, Question: "Pick?",
		Options: []UserQuestionOption{{Label: "Yes"}, {Label: "No"}},
	})
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	var waited store.UserQuestion
	var waitErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		waited, waitErr = e.WaitUserQuestion(ctx, q.ID, 5*time.Second)
	}()

	time.Sleep(50 * time.Millisecond)
	if _, err := e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{Selected: []string{"Yes"}}, "web"); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if waitErr != nil {
		t.Fatal(waitErr)
	}
	if waited.Status != store.UQStatusAnswered {
		t.Fatalf("waited status=%s", waited.Status)
	}
}

func TestExpireStaleUserQuestions(t *testing.T) {
	ctx := context.Background()
	e, _ := testEngine(t, 4, longRunningAdapter())
	base := time.Now()
	e.SetClock(func() time.Time { return base })

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	q, err := e.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID: task.ID, Question: "Old?",
		Options: []UserQuestionOption{{Label: "A"}, {Label: "B"}},
	})
	if err != nil {
		t.Fatal(err)
	}

	e.SetClock(func() time.Time { return base.Add(store.DefaultUserQuestionTTL + time.Minute) })
	n, err := e.ExpireStaleUserQuestions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expired n=%d", n)
	}
	got, err := e.GetUserQuestion(ctx, q.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.UQStatusExpired {
		t.Fatalf("status=%s want expired", got.Status)
	}
	if got.AnsweredVia == nil || *got.AnsweredVia != "timeout" {
		t.Fatalf("via=%v", got.AnsweredVia)
	}
}

func TestFollowUpInterruptResolvesUserQuestion(t *testing.T) {
	ctx := context.Background()
	e, _ := testEngine(t, 4, longRunningAdapter())

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	q, err := e.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID: task.ID, Question: "Still?",
		Options: []UserQuestionOption{{Label: "A"}, {Label: "B"}},
	})
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	var waited store.UserQuestion
	var waitErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		waited, waitErr = e.WaitUserQuestion(ctx, q.ID, 5*time.Second)
	}()
	time.Sleep(30 * time.Millisecond)

	if _, err := e.FollowUp(ctx, task.ID, "stop and do this instead"); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if waitErr != nil {
		t.Fatal(waitErr)
	}
	if waited.Status != store.UQStatusAnswered {
		t.Fatalf("status=%s want answered (interrupt)", waited.Status)
	}
	if waited.AnsweredVia == nil || *waited.AnsweredVia != "interrupt" {
		t.Fatalf("via=%v want interrupt", waited.AnsweredVia)
	}
}


func TestCancelResolvesUserQuestion(t *testing.T) {
	ctx := context.Background()
	e, _ := testEngine(t, 4, longRunningAdapter())

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	q, err := e.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID: task.ID, Question: "Cancel me?",
		Options: []UserQuestionOption{{Label: "A"}, {Label: "B"}},
	})
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	var waited store.UserQuestion
	var waitErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		waited, waitErr = e.WaitUserQuestion(ctx, q.ID, 5*time.Second)
	}()
	time.Sleep(30 * time.Millisecond)

	if _, err := e.Cancel(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if waitErr != nil {
		t.Fatal(waitErr)
	}
	if waited.Status != store.UQStatusAnswered {
		t.Fatalf("status=%s want answered (interrupt via cancel)", waited.Status)
	}
	if waited.AnsweredVia == nil || *waited.AnsweredVia != "interrupt" {
		t.Fatalf("via=%v want interrupt", waited.AnsweredVia)
	}

	// Must not remain pending in list.
	pending, err := e.ListUserQuestions(ctx, store.ListUserQuestionsOpts{Status: store.UQStatusPending})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range pending {
		if p.ID == q.ID {
			t.Fatalf("question still pending after cancel: %+v", p)
		}
	}
}
