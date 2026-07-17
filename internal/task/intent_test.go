package task

import "testing"

func TestLooksLikeCodingTask(t *testing.T) {
	yes := []string{
		"fix the auth bug in internal/api",
		"实现 sidebar 的 new session 按钮",
		"refactor TaskDetailPage.tsx and run tests",
		"排查 go test ./internal/task 失败",
		"Add unit tests for PlanWaves",
	}
	no := []string{
		"hello",
		"什么是 mutex？",
		"explain how TCP works",
		"谢谢",
		"why does the sky look blue",
	}
	for _, s := range yes {
		if !LooksLikeCodingTask(s) {
			t.Errorf("expected coding task: %q", s)
		}
	}
	for _, s := range no {
		if LooksLikeCodingTask(s) {
			t.Errorf("expected chat, not coding: %q", s)
		}
	}
}
