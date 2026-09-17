package routing

import "testing"

func TestClassifyPromptAndPhases(t *testing.T) {
	light := ClassifyPrompt("fix the typo", false)
	if light.Floor != QualityLight {
		t.Fatalf("light floor = %q, want %q", light.Floor, QualityLight)
	}
	if got := PhasesFor(light, nil); len(got) != 1 || got[0] != PhaseExecute {
		t.Fatalf("light phases = %v, want execute only", got)
	}

	heavy := ClassifyPrompt("Please refactor the architecture and debug the security migration across the repository with browser and tool support.", false)
	if heavy.Floor != QualityHeavy {
		t.Fatalf("heavy floor = %q, want %q (score=%d)", heavy.Floor, QualityHeavy, heavy.Score)
	}
	want := []RoutePhase{PhasePlan, PhaseExecute, PhaseReview}
	got := PhasesFor(heavy, nil)
	if len(got) != len(want) {
		t.Fatalf("heavy phases = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("heavy phases = %v, want %v", got, want)
		}
	}
}

func TestPhasesForHonorsForcedPhases(t *testing.T) {
	got := PhasesFor(Complexity{Floor: QualityLight}, []RoutePhase{PhasePlan, PhaseExecute, PhasePlan})
	want := []RoutePhase{PhasePlan, PhaseExecute}
	if len(got) != len(want) {
		t.Fatalf("forced phases = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("forced phases = %v, want %v", got, want)
		}
	}
}
