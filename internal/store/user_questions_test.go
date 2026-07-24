package store

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func openUserQuestionStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func seedUQTask(t *testing.T, s *Store, id string) {
	t.Helper()
	now := time.Now().UnixMilli()
	if err := s.InsertTask(context.Background(), Task{
		ID: id, Title: "ask auth", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestUserQuestionInsertGetRoundTrip(t *testing.T) {
	s := openUserQuestionStore(t)
	ctx := context.Background()
	seedUQTask(t, s, "01UQTASK0000000000000001")
	now := time.Now().UnixMilli()
	payload := json.RawMessage(`{"question":"Which auth?","header":"Auth method","options":[{"label":"JWT"},{"label":"Session"}],"multi_select":false}`)
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: "01UQ000000000000000000001", TaskID: "01UQTASK0000000000000001",
		Payload: payload, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetUserQuestion(ctx, "01UQ000000000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != UQStatusPending {
		t.Fatalf("status=%q want pending", got.Status)
	}
	if string(got.Payload) != string(payload) {
		t.Fatalf("payload=%s", got.Payload)
	}
	if got.Response != nil {
		t.Fatalf("response should be null, got %s", got.Response)
	}
	if got.AnsweredVia != nil || got.AnsweredAt != nil {
		t.Fatalf("answered fields should be null: %+v", got)
	}
}

func TestUserQuestionListFiltersAndJoin(t *testing.T) {
	s := openUserQuestionStore(t)
	ctx := context.Background()
	seedUQTask(t, s, "01UQTASK0000000000000002")
	now := time.Now().UnixMilli()
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: "01UQ000000000000000000002", TaskID: "01UQTASK0000000000000002",
		Payload: json.RawMessage(`{"question":"A?","options":[{"label":"1"},{"label":"2"}]}`),
		Status: UQStatusPending, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: "01UQ000000000000000000003", TaskID: "01UQTASK0000000000000002",
		Payload: json.RawMessage(`{"question":"B?","options":[{"label":"1"},{"label":"2"}]}`),
		Status: UQStatusAnswered, CreatedAt: now + 1,
		Response: json.RawMessage(`{"selected":["1"],"other_text":""}`),
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := s.ListUserQuestions(ctx, ListUserQuestionsOpts{Status: UQStatusPending})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].ID != "01UQ000000000000000000002" {
		t.Fatalf("pending=%+v", pending)
	}
	if pending[0].TaskTitle != "ask auth" || pending[0].TaskAgent != "claude-code" {
		t.Fatalf("join fields: title=%q agent=%q", pending[0].TaskTitle, pending[0].TaskAgent)
	}
	all, err := s.ListUserQuestions(ctx, ListUserQuestionsOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("all len=%d", len(all))
	}
	// newest first
	if all[0].ID != "01UQ000000000000000000003" {
		t.Fatalf("order: first=%s", all[0].ID)
	}
}

func TestUserQuestionAnswerOnlyPending(t *testing.T) {
	s := openUserQuestionStore(t)
	ctx := context.Background()
	seedUQTask(t, s, "01UQTASK0000000000000003")
	now := time.Now().UnixMilli()
	id := "01UQ000000000000000000004"
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: id, TaskID: "01UQTASK0000000000000003",
		Payload: json.RawMessage(`{"question":"Pick","options":[{"label":"JWT"},{"label":"Session"}]}`),
		CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	resp := json.RawMessage(`{"selected":["JWT"],"other_text":""}`)
	got, err := s.AnswerUserQuestion(ctx, id, resp, "web", now+10)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != UQStatusAnswered {
		t.Fatalf("status=%q", got.Status)
	}
	if string(got.Response) != string(resp) {
		t.Fatalf("response=%s", got.Response)
	}
	if got.AnsweredVia == nil || *got.AnsweredVia != "web" {
		t.Fatalf("via=%v", got.AnsweredVia)
	}
	if got.AnsweredAt == nil || *got.AnsweredAt != now+10 {
		t.Fatalf("answered_at=%v", got.AnsweredAt)
	}
	_, err = s.AnswerUserQuestion(ctx, id, resp, "web", now+20)
	if !errors.Is(err, ErrAlreadyAnswered) {
		t.Fatalf("second answer err=%v want ErrAlreadyAnswered", err)
	}
	_, err = s.AnswerUserQuestion(ctx, "missing", resp, "web", now)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing err=%v want ErrNotFound", err)
	}
}

func TestUserQuestionListPendingForTaskAndOlderThan(t *testing.T) {
	s := openUserQuestionStore(t)
	ctx := context.Background()
	seedUQTask(t, s, "01UQTASK0000000000000004")
	seedUQTask(t, s, "01UQTASK0000000000000005")
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: "01UQOLD00000000000000001", TaskID: "01UQTASK0000000000000004",
		Payload: json.RawMessage(`{"question":"old","options":[{"label":"a"},{"label":"b"}]}`),
		CreatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: "01UQNEW00000000000000001", TaskID: "01UQTASK0000000000000004",
		Payload: json.RawMessage(`{"question":"new","options":[{"label":"a"},{"label":"b"}]}`),
		CreatedAt: 5000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: "01UQOTHER000000000000001", TaskID: "01UQTASK0000000000000005",
		Payload: json.RawMessage(`{"question":"other","options":[{"label":"a"},{"label":"b"}]}`),
		CreatedAt: 500,
	}); err != nil {
		t.Fatal(err)
	}
	forTask, err := s.ListPendingUserQuestionsForTask(ctx, "01UQTASK0000000000000004")
	if err != nil {
		t.Fatal(err)
	}
	if len(forTask) != 2 {
		t.Fatalf("for task len=%d", len(forTask))
	}
	older, err := s.ListPendingUserQuestionsOlderThan(ctx, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if len(older) != 2 { // old on task4 + other on task5
		t.Fatalf("older len=%d ids=%v", len(older), older)
	}
	n, err := s.CountUserQuestions(ctx, UQStatusPending)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("count pending=%d", n)
	}
}

func TestUserQuestionExecutionRoundTrip(t *testing.T) {
	s := openUserQuestionStore(t)
	ctx := context.Background()
	seedUQTask(t, s, "01UQTASK0000000000000006")
	now := time.Now().UnixMilli()
	execID := "01UQEXEC0000000000000001"
	agent := "claude-code"
	step := 2
	model := "claude-sonnet"
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: "01UQEXECROW0000000000001", TaskID: "01UQTASK0000000000000006",
		Payload: json.RawMessage(`{"question":"x","options":[{"label":"a"},{"label":"b"}]}`),
		CreatedAt: now,
		ExecutionID: &execID, ExecutionAgent: &agent, ExecutionStep: &step, ExecutionModel: &model,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetUserQuestion(ctx, "01UQEXECROW0000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.ExecutionID == nil || *got.ExecutionID != execID {
		t.Fatalf("exec id=%v", got.ExecutionID)
	}
	if got.ExecutionAgent == nil || *got.ExecutionAgent != agent {
		t.Fatalf("exec agent=%v", got.ExecutionAgent)
	}
	if got.ExecutionStep == nil || *got.ExecutionStep != step {
		t.Fatalf("exec step=%v", got.ExecutionStep)
	}
	if got.ExecutionModel == nil || *got.ExecutionModel != model {
		t.Fatalf("exec model=%v", got.ExecutionModel)
	}
	list, err := s.ListUserQuestions(ctx, ListUserQuestionsOpts{Status: UQStatusPending})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ExecutionID == nil || *list[0].ExecutionID != execID {
		t.Fatalf("list exec=%+v", list)
	}
}

func TestUserQuestionHistoricalNullExecution(t *testing.T) {
	s := openUserQuestionStore(t)
	ctx := context.Background()
	seedUQTask(t, s, "01UQTASK0000000000000007")
	now := time.Now().UnixMilli()
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: "01UQHIST0000000000000001", TaskID: "01UQTASK0000000000000007",
		Payload: json.RawMessage(`{"question":"x","options":[{"label":"a"},{"label":"b"}]}`),
		CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetUserQuestion(ctx, "01UQHIST0000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.ExecutionID != nil || got.ExecutionAgent != nil || got.ExecutionStep != nil || got.ExecutionModel != nil {
		t.Fatalf("expected null execution fields, got %+v", got)
	}
}

func TestUserQuestionExpire(t *testing.T) {
	s := openUserQuestionStore(t)
	ctx := context.Background()
	seedUQTask(t, s, "01UQTASK0000000000000008")
	now := time.Now().UnixMilli()
	id := "01UQEXP00000000000000001"
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID: id, TaskID: "01UQTASK0000000000000008",
		Payload: json.RawMessage(`{"question":"x","options":[{"label":"a"},{"label":"b"}]}`),
		CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.ExpireUserQuestion(ctx, id, "timeout", now+100)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != UQStatusExpired {
		t.Fatalf("status=%q", got.Status)
	}
	if got.AnsweredVia == nil || *got.AnsweredVia != "timeout" {
		t.Fatalf("via=%v", got.AnsweredVia)
	}
	_, err = s.ExpireUserQuestion(ctx, id, "timeout", now+200)
	if !errors.Is(err, ErrAlreadyAnswered) {
		t.Fatalf("err=%v", err)
	}
}
