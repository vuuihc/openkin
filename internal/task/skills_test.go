package task

import (
	"context"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/skills"
	"github.com/vuuihc/openkin/internal/store"
)

type fakeSkillResolver struct{}

func (fakeSkillResolver) Context(context.Context, string, string) (skills.Context, error) {
	return skills.Context{
		Instructions: "## Skill test-skill@1.0.0\nUse the test procedure.",
		References: []skills.Reference{{
			Name: "test-skill", Version: "1.0.0", Scope: skills.ScopeUser, Source: "test",
		}},
	}, nil
}

func TestCreateInjectsSkillContextAndAuditsReferences(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	engine := newConfiguredTestEngine(t, st)
	engine.SetSkillResolver(fakeSkillResolver{})
	defer engine.Close()
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	created, err := engine.Create(context.Background(), CreateRequest{
		Agent:  "claude-code",
		Cwd:    t.TempDir(),
		Prompt: "check the release",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(created.Prompt, "test-skill@1.0.0") ||
		!strings.Contains(created.Prompt, "User request:\ncheck the release") {
		t.Fatalf("prompt=%q", created.Prompt)
	}
	events, err := st.ListEvents(context.Background(), created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if event.Type == "skill_context" && strings.Contains(string(event.Payload), "test-skill") {
			found = true
		}
	}
	if !found {
		t.Fatalf("skill audit event missing: %+v", events)
	}
}
