package routines

import (
	"testing"
	"time"
)

func mustLoad(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	return loc
}

func at(t *testing.T, loc *time.Location, y int, m time.Month, d, hh, mm int) time.Time {
	t.Helper()
	return time.Date(y, m, d, hh, mm, 0, 0, loc)
}

func TestRecurrenceDailyPicksTheNextTimeOfDay(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")
	r := Recurrence{Kind: RecurrenceDaily, Hour: 9, Minute: 0, TimeZone: "Asia/Shanghai"}

	// Before today's time: today.
	got, ok := r.Next(at(t, shanghai, 2026, time.March, 2, 8, 30))
	if !ok || !got.Equal(at(t, shanghai, 2026, time.March, 2, 9, 0)) {
		t.Fatalf("before the hour = %v, %v", got, ok)
	}
	// After today's time: tomorrow.
	got, ok = r.Next(at(t, shanghai, 2026, time.March, 2, 9, 30))
	if !ok || !got.Equal(at(t, shanghai, 2026, time.March, 3, 9, 0)) {
		t.Fatalf("after the hour = %v, %v", got, ok)
	}
	// Exactly on the occurrence: the rule is strictly future, so tomorrow.
	got, ok = r.Next(at(t, shanghai, 2026, time.March, 2, 9, 0))
	if !ok || !got.Equal(at(t, shanghai, 2026, time.March, 3, 9, 0)) {
		t.Fatalf("on the occurrence = %v, %v", got, ok)
	}
}

func TestRecurrenceWeekdaysSkipsTheWeekend(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")
	r := Recurrence{Kind: RecurrenceWeekdays, Hour: 9, Minute: 0, TimeZone: "Asia/Shanghai"}
	// 2026-03-06 is a Friday; the next weekday occurrence is Monday the 9th.
	friday := at(t, shanghai, 2026, time.March, 6, 10, 0)
	if friday.Weekday() != time.Friday {
		t.Fatalf("test fixture is not a Friday: %v", friday.Weekday())
	}
	got, ok := r.Next(friday)
	if !ok || !got.Equal(at(t, shanghai, 2026, time.March, 9, 9, 0)) {
		t.Fatalf("friday afternoon = %v, %v", got, ok)
	}
}

func TestRecurrenceWeeklyUsesTheChosenDays(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")
	// Mondays and Wednesdays at 18:00.
	r := Recurrence{Kind: RecurrenceWeekly, Hour: 18, Weekdays: []int{1, 3}, TimeZone: "Asia/Shanghai"}
	tuesday := at(t, shanghai, 2026, time.March, 3, 12, 0)
	got, ok := r.Next(tuesday)
	if !ok || !got.Equal(at(t, shanghai, 2026, time.March, 4, 18, 0)) {
		t.Fatalf("from tuesday = %v, %v", got, ok)
	}
	// From Wednesday after the time: the next one is Monday.
	wednesday := at(t, shanghai, 2026, time.March, 4, 19, 0)
	got, ok = r.Next(wednesday)
	if !ok || !got.Equal(at(t, shanghai, 2026, time.March, 9, 18, 0)) {
		t.Fatalf("from wednesday evening = %v, %v", got, ok)
	}
}

func TestRecurrenceMonthlyClampsToTheLastDay(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")
	r := Recurrence{Kind: RecurrenceMonthly, Hour: 9, Days: []int{31}, TimeZone: "Asia/Shanghai"}
	// January has a 31st.
	got, ok := r.Next(at(t, shanghai, 2026, time.January, 1, 0, 0))
	if !ok || !got.Equal(at(t, shanghai, 2026, time.January, 31, 9, 0)) {
		t.Fatalf("january = %v, %v", got, ok)
	}
	// February does not, so the rule fires on its last day rather than skipping
	// the month entirely.
	got, ok = r.Next(at(t, shanghai, 2026, time.January, 31, 9, 0))
	if !ok || !got.Equal(at(t, shanghai, 2026, time.February, 28, 9, 0)) {
		t.Fatalf("february = %v, %v", got, ok)
	}
	// A leap year still lands on the last day.
	got, ok = r.Next(at(t, shanghai, 2028, time.January, 31, 9, 0))
	if !ok || !got.Equal(at(t, shanghai, 2028, time.February, 29, 9, 0)) {
		t.Fatalf("leap february = %v, %v", got, ok)
	}
}

func TestRecurrenceMonthlyTakesTheEarliestChosenDay(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")
	r := Recurrence{Kind: RecurrenceMonthly, Hour: 9, Days: []int{15, 1}, TimeZone: "Asia/Shanghai"}
	got, ok := r.Next(at(t, shanghai, 2026, time.March, 2, 0, 0))
	if !ok || !got.Equal(at(t, shanghai, 2026, time.March, 15, 9, 0)) {
		t.Fatalf("march = %v, %v", got, ok)
	}
}

func TestRecurrenceOnceFiresOneInstant(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")
	when := at(t, shanghai, 2026, time.April, 1, 12, 0)
	r := Recurrence{Kind: RecurrenceOnce, At: when.UnixMilli()}
	got, ok := r.Next(at(t, shanghai, 2026, time.March, 31, 0, 0))
	if !ok || !got.Equal(when) {
		t.Fatalf("future once = %v, %v", got, ok)
	}
	if _, ok := r.Next(when); ok {
		t.Fatal("a once rule that already fired reported another occurrence")
	}
	if _, ok := r.Next(when.Add(time.Hour)); ok {
		t.Fatal("a once rule in the past reported an occurrence")
	}
}

func TestRecurrenceUsesItsOwnZoneNotTheCallers(t *testing.T) {
	// 09:00 in Shanghai is 01:00 UTC. A daemon running in UTC must still fire
	// at the user's morning, not at its own.
	r := Recurrence{Kind: RecurrenceDaily, Hour: 9, Minute: 0, TimeZone: "Asia/Shanghai"}
	utc := time.UTC
	after := at(t, utc, 2026, time.March, 2, 0, 30)
	got, ok := r.Next(after)
	if !ok {
		t.Fatal("no occurrence")
	}
	if !got.Equal(at(t, utc, 2026, time.March, 2, 1, 0)) {
		t.Fatalf("next = %v, want 01:00Z", got.UTC())
	}
	if got.In(mustLoad(t, "Asia/Shanghai")).Hour() != 9 {
		t.Fatalf("wall clock = %v", got.In(mustLoad(t, "Asia/Shanghai")))
	}
}

func TestRecurrenceKeepsWallClockAcrossDST(t *testing.T) {
	// US daylight saving begins 2026-03-08. A 09:00 daily rule must stay at
	// 09:00 local, so the absolute gap that day is 23 hours, not 24.
	r := Recurrence{Kind: RecurrenceDaily, Hour: 9, Minute: 0, TimeZone: "America/New_York"}
	ny := mustLoad(t, "America/New_York")
	first, ok := r.Next(at(t, ny, 2026, time.March, 6, 10, 0))
	if !ok || !first.Equal(at(t, ny, 2026, time.March, 7, 9, 0)) {
		t.Fatalf("first = %v, %v", first, ok)
	}
	second, ok := r.Next(first)
	if !ok || !second.Equal(at(t, ny, 2026, time.March, 8, 9, 0)) {
		t.Fatalf("second = %v, %v", second, ok)
	}
	if gap := second.Sub(first); gap != 23*time.Hour {
		t.Fatalf("gap across spring forward = %v, want 23h", gap)
	}
}

func TestRecurrencePeriodMeasuresTheCalendar(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")
	from := at(t, shanghai, 2026, time.March, 2, 0, 0)
	cases := []struct {
		name string
		r    Recurrence
		want time.Duration
	}{
		{"daily", Recurrence{Kind: RecurrenceDaily, Hour: 9, TimeZone: "Asia/Shanghai"}, 24 * time.Hour},
		{"weekdays", Recurrence{Kind: RecurrenceWeekdays, Hour: 9, TimeZone: "Asia/Shanghai"}, 24 * time.Hour},
		{"weekly", Recurrence{Kind: RecurrenceWeekly, Hour: 9, Weekdays: []int{1}, TimeZone: "Asia/Shanghai"}, 7 * 24 * time.Hour},
		// The first two occurrences are 1 April and 1 May, both 30 days apart.
		{"monthly", Recurrence{Kind: RecurrenceMonthly, Hour: 9, Days: []int{1}, TimeZone: "Asia/Shanghai"}, 30 * 24 * time.Hour},
	}
	for _, tc := range cases {
		if got := tc.r.period(from); got != tc.want {
			t.Fatalf("%s period = %v, want %v", tc.name, got, tc.want)
		}
	}
	// A once rule has no period.
	once := Recurrence{Kind: RecurrenceOnce, At: from.Add(time.Hour).UnixMilli()}
	if got := once.period(from); got != 0 {
		t.Fatalf("once period = %v", got)
	}
}

func TestNominalIntervalSeconds(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")
	now := at(t, shanghai, 2026, time.March, 2, 0, 0)
	cases := []struct {
		name string
		r    Recurrence
		want int64
	}{
		{"daily", Recurrence{Kind: RecurrenceDaily, Hour: 9, TimeZone: "Asia/Shanghai"}, 86400},
		{"weekdays", Recurrence{Kind: RecurrenceWeekdays, Hour: 9, TimeZone: "Asia/Shanghai"}, 86400},
		{"weekly", Recurrence{Kind: RecurrenceWeekly, Hour: 9, Weekdays: []int{1}, TimeZone: "Asia/Shanghai"}, 7 * 86400},
		// Two hours from midnight to 02:00 for a one-off.
		{"once", Recurrence{Kind: RecurrenceOnce, At: now.Add(2 * time.Hour).UnixMilli()}, 7200},
	}
	for _, tc := range cases {
		if got := tc.r.NominalIntervalSeconds(now); got != tc.want {
			t.Fatalf("%s = %d, want %d", tc.name, got, tc.want)
		}
	}
	// A once instant that has passed still needs a positive pace: the column
	// requires one, and the routine is retired the moment it fires.
	past := Recurrence{Kind: RecurrenceOnce, At: now.Add(-time.Hour).UnixMilli()}
	if got := past.NominalIntervalSeconds(now); got <= 0 {
		t.Fatalf("past once = %d, want a positive pace", got)
	}
}

func TestRecurrenceValidateRejectsWhatItCannotFire(t *testing.T) {
	cases := []struct {
		name string
		r    Recurrence
	}{
		{"no kind", Recurrence{}},
		{"unknown kind", Recurrence{Kind: "hourly"}},
		{"hour too big", Recurrence{Kind: RecurrenceDaily, Hour: 24}},
		{"negative hour", Recurrence{Kind: RecurrenceDaily, Hour: -1}},
		{"minute too big", Recurrence{Kind: RecurrenceDaily, Minute: 60}},
		{"weekly without days", Recurrence{Kind: RecurrenceWeekly, Hour: 9}},
		{"weekday out of range", Recurrence{Kind: RecurrenceWeekly, Hour: 9, Weekdays: []int{7}}},
		{"repeated weekday", Recurrence{Kind: RecurrenceWeekly, Hour: 9, Weekdays: []int{1, 1}}},
		{"monthly without days", Recurrence{Kind: RecurrenceMonthly, Hour: 9}},
		{"day zero", Recurrence{Kind: RecurrenceMonthly, Hour: 9, Days: []int{0}}},
		{"day thirty-two", Recurrence{Kind: RecurrenceMonthly, Hour: 9, Days: []int{32}}},
		{"once without an instant", Recurrence{Kind: RecurrenceOnce}},
		{"unknown zone", Recurrence{Kind: RecurrenceDaily, Hour: 9, TimeZone: "Mars/Olympus"}},
	}
	for _, tc := range cases {
		if err := tc.r.Validate(); err == nil {
			t.Fatalf("%s was accepted", tc.name)
		}
		if _, ok := tc.r.Next(time.Now()); ok {
			t.Fatalf("%s produced an occurrence", tc.name)
		}
	}
	// The valid shapes pass.
	for _, ok := range []Recurrence{
		{Kind: RecurrenceDaily, Hour: 0, Minute: 0},
		{Kind: RecurrenceWeekdays, Hour: 23, Minute: 59},
		{Kind: RecurrenceWeekly, Hour: 9, Weekdays: []int{0, 6}},
		{Kind: RecurrenceMonthly, Hour: 9, Days: []int{1, 31}},
		{Kind: RecurrenceOnce, At: 1},
	} {
		if err := ok.Validate(); err != nil {
			t.Fatalf("%+v rejected: %v", ok, err)
		}
	}
}

func TestParseRecurrence(t *testing.T) {
	if r, err := ParseRecurrence(""); err != nil || r != nil {
		t.Fatalf("empty = %v, %v; want nil, nil", r, err)
	}
	if r, err := ParseRecurrence("   "); err != nil || r != nil {
		t.Fatalf("blank = %v, %v; want nil, nil", r, err)
	}
	r, err := ParseRecurrence(`{"kind":"daily","hour":9,"time_zone":"Asia/Shanghai"}`)
	if err != nil || r == nil || r.Kind != RecurrenceDaily || r.Hour != 9 {
		t.Fatalf("daily = %+v, %v", r, err)
	}
	if _, err := ParseRecurrence(`not json`); err == nil {
		t.Fatal("invalid json accepted")
	}
	// A stored rule that fails validation is an error, not a silent fallback
	// to interval behaviour: that would run at the wrong time forever.
	if _, err := ParseRecurrence(`{"kind":"sometimes","hour":9}`); err == nil {
		t.Fatal("unknown kind accepted")
	}
}
