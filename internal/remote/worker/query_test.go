package worker

import (
	"errors"
	"strings"
	"testing"
)

// A question's envelope is checked here; which questions exist is the answering
// machine's business.
//
// A Hub on a newer version asks something an older Node has never heard of, and
// the useful outcome is that Node saying so — an envelope that refused the
// question before it could be read would leave the Hub waiting for an answer
// that is never coming.
func TestQueryValidationChecksShapeNotVocabulary(t *testing.T) {
	for _, tc := range []struct {
		name  string
		query Query
		// field is the word the refusal has to name, or empty when the question
		// is one this package accepts.
		field string
	}{
		{name: "no id", query: Query{Method: QueryListDirs}, field: "id"},
		{name: "blank id", query: Query{ID: "  ", Method: QueryListDirs}, field: "id"},
		{name: "no method", query: Query{ID: "q-1"}, field: "method"},
		{name: "id over the bound", query: Query{ID: strings.Repeat("i", MaxQueryID+1), Method: QueryListDirs}, field: "id"},
		{name: "method over the bound", query: Query{ID: "q-1", Method: strings.Repeat("m", MaxMethod+1)}, field: "method"},
		{name: "params over the bound", query: Query{ID: "q-1", Method: QueryListDirs, Params: make([]byte, MaxQueryParams+1)}, field: "params"},
		{name: "a method this package does not know", query: Query{ID: "q-1", Method: "fs.wat"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.query.Validate()
			if tc.field == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want the envelope to accept it", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() accepted a question with %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("Validate() = %q, want it to name %q", err, tc.field)
			}
		})
	}
}

// An answer is a payload or a reason, and a Hub reads the reason as one.
func TestQueryResultCarriesAnAnswerOrAReason(t *testing.T) {
	answer, err := Answer("q-1", ListDirsResult{Path: "/code", Entries: []string{"kin"}})
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if err := answer.Validate(); err != nil {
		t.Fatalf("Answer produced an invalid result: %v", err)
	}
	var listed ListDirsResult
	if err := answer.Into(&listed); err != nil {
		t.Fatalf("Into: %v", err)
	}
	if listed.Path != "/code" || len(listed.Entries) != 1 {
		t.Fatalf("Into decoded %+v", listed)
	}

	refused, err := Refuse("q-2", errors.New("/etc is not a directory this machine works in"))
	if err != nil {
		t.Fatalf("Refuse: %v", err)
	}
	if err := refused.Validate(); err != nil {
		t.Fatalf("Refuse produced an invalid result: %v", err)
	}
	if err := refused.Into(&listed); err == nil {
		t.Fatal("Into accepted a refusal as an answer")
	} else if !strings.Contains(err.Error(), "not a directory this machine works in") {
		t.Fatalf("Into = %q, want the machine's own reason", err)
	}

	// An answer with neither half is a machine that is broken, not a question
	// that was refused. It is a valid envelope — refusing the frame would turn a
	// broken answer into a Hub waiting for one that never comes — and it fails
	// where it is read, with a sentence.
	empty := QueryResult{ID: "q-3"}
	if err := empty.Validate(); err != nil {
		t.Fatalf("an empty answer is a readable frame: %v", err)
	}
	if err := empty.Into(&listed); err == nil {
		t.Fatal("Into accepted an answer with no payload and no reason")
	} else if !strings.Contains(err.Error(), "q-3") {
		t.Fatalf("Into = %q, want it to name the answer it could not read", err)
	}
	if _, err := Answer("  ", ListDirsResult{}); err == nil {
		t.Fatal("Answer built a result for an unnamed question")
	}
}

// The path rule is the same one Executor.allowedCwd states for a dispatch: the
// Hub speaks in paths on the machine, so a relative path is not a question this
// protocol accepts — it would resolve against whatever directory the daemon was
// started in, which is not a choice the Hub gets to make.
func TestListDirsParamsRequireAnAbsolutePath(t *testing.T) {
	if err := (ListDirsParams{}).Validate(); err != nil {
		t.Fatalf("an empty path is the machine's own roots, not an error: %v", err)
	}
	if err := (ListDirsParams{Path: "/code/kin"}).Validate(); err != nil {
		t.Fatalf("an absolute path was refused: %v", err)
	}
	if err := (ListDirsParams{Path: "code/kin"}).Validate(); err == nil {
		t.Fatal("a relative path was accepted")
	}
	if err := (ListDirsParams{Path: strings.Repeat("p", MaxCwd+1)}).Validate(); err == nil {
		t.Fatal("an oversized path was accepted")
	}
}

// A repository and a branch are names, and a name must not be able to become an
// option.
//
// Both end up as arguments to git on a machine the Hub is not: `ls-remote
// --upload-pack=` runs whatever it is pointed at, and `checkout -f` throws away
// work in a directory somebody is using. The Hub is the other party on this
// channel, so this is decided here, before the question is sent, rather than
// trusted to the side that did not choose the name.
func TestRepoQuestionsRefuseANameThatIsAnOption(t *testing.T) {
	for _, tc := range []struct {
		name   string
		params interface{ Validate() error }
		// field is the word the refusal has to name, or empty when the question
		// is one this package accepts.
		field string
	}{
		{name: "an ordinary shorthand", params: RepoBranchesParams{Repo: "owner/repo"}},
		{name: "a full url", params: RepoBranchesParams{Repo: "https://github.com/owner/repo.git"}},
		{name: "a local path", params: RepoBranchesParams{Repo: "/srv/git/repo.git"}},

		{name: "no repo", params: RepoBranchesParams{}, field: "repo"},
		{name: "blank repo", params: RepoBranchesParams{Repo: "  "}, field: "repo"},
		{name: "repo over the bound", params: RepoBranchesParams{Repo: strings.Repeat("r", MaxRepo+1)}, field: "repo"},
		{name: "repo that is an option", params: RepoBranchesParams{Repo: "--upload-pack=/bin/sh"}, field: "dash"},
		{name: "repo with a newline", params: RepoBranchesParams{Repo: "owner/repo\n--upload-pack=/bin/sh"}, field: "control"},

		{name: "prepare without a branch", params: RepoPrepareParams{Repo: "owner/repo"}},
		{name: "prepare with a branch", params: RepoPrepareParams{Repo: "owner/repo", Branch: "main"}},

		{name: "prepare with no repo", params: RepoPrepareParams{Branch: "main"}, field: "repo"},
		{name: "branch that is an option", params: RepoPrepareParams{Repo: "owner/repo", Branch: "-f"}, field: "dash"},
		{name: "branch with a newline", params: RepoPrepareParams{Repo: "owner/repo", Branch: "main\n-f"}, field: "control"},
		{name: "branch over the bound", params: RepoPrepareParams{Repo: "owner/repo", Branch: strings.Repeat("b", MaxBranch+1)}, field: "branch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.params.Validate()
			if tc.field == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want it accepted", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("Validate() = %q, want it to name %q", err, tc.field)
			}
		})
	}
}
