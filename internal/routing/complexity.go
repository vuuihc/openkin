package routing

import "strings"

// QualityFloor is the minimum model capability a route may use.
type QualityFloor string

const (
	QualityLight  QualityFloor = "light"
	QualityMedium QualityFloor = "medium"
	QualityHeavy  QualityFloor = "heavy"
)

// Complexity is a deterministic, local-only classification used before any
// provider call. Features are deliberately explainable and audit-friendly.
type Complexity struct {
	Score    int            `json:"score"`
	Floor    QualityFloor   `json:"floor"`
	Features map[string]int `json:"features"`
}

// ClassifyPrompt maps prompt shape to a quality floor.
func ClassifyPrompt(prompt string, routine bool) Complexity {
	p := strings.ToLower(strings.TrimSpace(prompt))
	features := map[string]int{}
	score := 0
	if len([]rune(p)) > 1200 {
		features["prompt_size"] = 2
		score += 2
	} else if len([]rune(p)) > 400 {
		features["prompt_size"] = 1
		score++
	}
	for _, word := range []string{"refactor", "migrate", "architecture", "security", "debug", "design"} {
		if strings.Contains(p, word) {
			features["complex_operation"]++
			score += 2
		}
	}
	for _, word := range []string{"browser", "screenshot", "image", "tool", "repository", "multiple files"} {
		if strings.Contains(p, word) {
			features["tool_or_scope"]++
			score++
		}
	}
	if routine {
		features["routine"] = 1
		score--
	}
	floor := QualityLight
	if score >= 3 {
		floor = QualityMedium
	}
	if score >= 7 {
		floor = QualityHeavy
	}
	return Complexity{Score: score, Floor: floor, Features: features}
}

func NormalizeQualityFloor(raw string) QualityFloor {
	switch QualityFloor(strings.ToLower(strings.TrimSpace(raw))) {
	case QualityLight:
		return QualityLight
	case QualityHeavy:
		return QualityHeavy
	case QualityMedium:
		return QualityMedium
	default:
		return ""
	}
}

func qualityMeetsFloor(tier string, floor QualityFloor) bool {
	switch floor {
	case QualityHeavy:
		return tier == "smart"
	case QualityMedium:
		return tier == "smart" || tier == "balanced"
	default:
		return true
	}
}

// PhasesFor returns the minimum useful phase plan for a classified task.
func PhasesFor(c Complexity, forced []RoutePhase) []RoutePhase {
	if len(forced) > 0 {
		out := make([]RoutePhase, 0, len(forced))
		for _, phase := range forced {
			if ValidRoutePhase(phase) && !containsPhase(out, phase) {
				out = append(out, phase)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	if c.Floor == QualityLight {
		return []RoutePhase{PhaseExecute}
	}
	if c.Floor == QualityHeavy {
		return []RoutePhase{PhasePlan, PhaseExecute, PhaseReview}
	}
	return []RoutePhase{PhasePlan, PhaseExecute}
}

func containsPhase(phases []RoutePhase, target RoutePhase) bool {
	for _, phase := range phases {
		if phase == target {
			return true
		}
	}
	return false
}
