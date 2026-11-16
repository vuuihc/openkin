package droid

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/approvalbridge"
)

type approvalBridge struct {
	client    *approvalbridge.Client
	taskID    string
	execution approvalbridge.Execution
}

func newApprovalBridge(client *approvalbridge.Client, spec adapter.TaskSpec) *approvalBridge {
	return &approvalBridge{
		client: client,
		taskID: spec.ID,
		execution: approvalbridge.Execution{
			ID:    spec.Execution.ID,
			Agent: spec.Execution.Agent,
			Step:  spec.Execution.Step,
			Model: spec.Execution.Model,
		},
	}
}

func (b *approvalBridge) requestPermission(ctx context.Context, params json.RawMessage) string {
	if b == nil || b.client == nil || b.client.DaemonURL == "" || b.client.Token == "" {
		return "cancel"
	}
	id, err := b.client.CreateApproval(ctx, b.taskID, "tool_use", params, b.execution)
	if err != nil {
		return "cancel"
	}
	decision, err := b.client.WaitApproval(ctx, id)
	if err != nil || decision != "approved" {
		return "cancel"
	}
	return "proceed_once"
}

func (b *approvalBridge) askUser(ctx context.Context, params json.RawMessage) map[string]any {
	cancelled := map[string]any{"cancelled": true, "answers": []any{}}
	if b == nil || b.client == nil || b.client.DaemonURL == "" || b.client.Token == "" {
		return cancelled
	}
	var request struct {
		Questions []struct {
			Index       int      `json:"index"`
			Topic       string   `json:"topic"`
			Question    string   `json:"question"`
			Options     []string `json:"options"`
			MultiSelect bool     `json:"multiSelect"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(params, &request); err != nil || len(request.Questions) == 0 {
		return cancelled
	}

	answers := make([]map[string]any, 0, len(request.Questions))
	for _, question := range request.Questions {
		if strings.TrimSpace(question.Question) == "" || len(question.Options) < 2 {
			return cancelled
		}
		options := make([]approvalbridge.QuestionOption, 0, len(question.Options))
		for _, option := range question.Options {
			options = append(options, approvalbridge.QuestionOption{Label: option})
		}
		id, err := b.client.CreateUserQuestion(ctx, b.taskID, approvalbridge.Question{
			Text:        question.Question,
			Header:      question.Topic,
			Options:     options,
			MultiSelect: question.MultiSelect,
		}, b.execution)
		if err != nil {
			return cancelled
		}
		answer, err := b.client.WaitUserQuestion(ctx, id)
		if err != nil || answer.Status != "answered" {
			return cancelled
		}
		text := strings.Join(answer.Selected, ", ")
		if other := strings.TrimSpace(answer.OtherText); other != "" {
			if text != "" {
				text += ", "
			}
			text += other
		}
		if text == "" {
			return cancelled
		}
		answers = append(answers, map[string]any{
			"index":    question.Index,
			"question": question.Question,
			"answer":   text,
		})
	}
	return map[string]any{"answers": answers}
}
