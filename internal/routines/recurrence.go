package routines

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Recurrence is a wall-clock rule: "every weekday at 09:00, Asia/Shanghai".
//
// A routine's interval says how long to wait after the last run, which cannot
// express "at 09:00": a 24h interval drifts by however long each run took, and
// "weekdays only" or "the 1st of the month" are not multiples of anything. A
// recurrence anchors the run to the calendar instead, and the scheduler treats
// the interval as its fallback for routines that do not carry one.
//
// Times are interpreted in TimeZone, not in the daemon's zone: the daemon is
// often a container running in UTC while the user means their own clock.
type Recurrence struct {
	// Kind is one of daily, weekdays, weekly, monthly, minutes, hours, once.
	Kind string `json:"kind"`
	// Hour and Minute are the wall-clock time of day for the four clock kinds:
	// daily, weekdays, weekly and monthly.
	Hour   int `json:"hour"`
	Minute int `json:"minute"`
	// Weekdays selects days for kind=weekly, 0=Sunday … 6=Saturday.
	Weekdays []int `json:"weekdays,omitempty"`
	// Days selects days of the month for kind=monthly, 1-31.
	Days []int `json:"days,omitempty"`
	// Every is the step for kind=minutes and kind=hours: the minute hand lands
	// on every multiple of it, or the hour hand does at :00. The step is
	// aligned to the zone's own clock, which is what makes "every 6 hours"
	// mean 00:00, 06:00, 12:00 and 18:00 rather than six hours after the last
	// run finished.
	Every int `json:"every,omitempty"`
	// At is the single instant for kind=once, in unix milliseconds.
	At int64 `json:"at,omitempty"`
	// TimeZone is an IANA name. Empty means the daemon's local zone.
	TimeZone string `json:"time_zone,omitempty"`
}

// Recurrence kinds. They mirror the shapes a phone user can pick without
// typing a cron expression.
const (
	RecurrenceDaily    = "daily"
	RecurrenceWeekdays = "weekdays"
	RecurrenceWeekly   = "weekly"
	RecurrenceMonthly  = "monthly"
	RecurrenceMinutes  = "minutes"
	RecurrenceHours    = "hours"
	RecurrenceOnce     = "once"
)

// maxRecurrenceLookaheadDays bounds the search for the next occurrence. Every
// valid rule fires at least once a year, so this only stops a malformed rule
// from spinning; Validate rejects those before they are stored.
const maxRecurrenceLookaheadDays = 400

// ParseRecurrence decodes and validates a stored recurrence. An empty string is
// not an error: it means the routine runs on its interval.
func ParseRecurrence(raw string) (*Recurrence, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var r Recurrence
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, fmt.Errorf("recurrence must be a JSON object: %w", err)
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	return &r, nil
}

// Validate rejects a rule the scheduler could not fire.
func (r Recurrence) Validate() error {
	if r.TimeZone != "" {
		if _, err := time.LoadLocation(r.TimeZone); err != nil {
			return fmt.Errorf("recurrence time_zone %q is not a known zone", r.TimeZone)
		}
	}
	switch r.Kind {
	case RecurrenceDaily, RecurrenceWeekdays:
		return r.validateClock()
	case RecurrenceWeekly:
		if err := r.validateClock(); err != nil {
			return err
		}
		if len(r.Weekdays) == 0 {
			return fmt.Errorf("recurrence weekdays are required for kind %q", r.Kind)
		}
		seen := make(map[int]bool, len(r.Weekdays))
		for _, d := range r.Weekdays {
			if d < 0 || d > 6 {
				return fmt.Errorf("recurrence weekday %d is outside 0-6", d)
			}
			if seen[d] {
				return fmt.Errorf("recurrence weekday %d is repeated", d)
			}
			seen[d] = true
		}
		return nil
	case RecurrenceMonthly:
		if err := r.validateClock(); err != nil {
			return err
		}
		if len(r.Days) == 0 {
			return fmt.Errorf("recurrence days are required for kind %q", r.Kind)
		}
		seen := make(map[int]bool, len(r.Days))
		for _, d := range r.Days {
			if d < 1 || d > 31 {
				return fmt.Errorf("recurrence day %d is outside 1-31", d)
			}
			if seen[d] {
				return fmt.Errorf("recurrence day %d is repeated", d)
			}
			seen[d] = true
		}
		return nil
	case RecurrenceMinutes:
		// The five-minute marks are the whole set, not every divisor of the
		// hour: the console offers exactly these, and a routine that spawns an
		// agent session every minute or two is an interval routine at best.
		// Keeping one set on both sides is what stops a stored rule from being
		// valid to the daemon and unshowable in the form.
		switch r.Every {
		case 5, 10, 15, 20, 30:
			return nil
		}
		return fmt.Errorf("recurrence every %d is not a step of 5, 10, 15, 20 or 30 minutes", r.Every)
	case RecurrenceHours:
		if r.Every < 1 || r.Every > 12 || 24%r.Every != 0 {
			return fmt.Errorf("recurrence every %d is not a step of 1-12 hours that divides a day", r.Every)
		}
		return nil
	case RecurrenceOnce:
		if r.At <= 0 {
			return fmt.Errorf("recurrence at is required for kind %q", r.Kind)
		}
		return nil
	case "":
		return fmt.Errorf("recurrence kind is required")
	default:
		return fmt.Errorf("recurrence kind %q is not one of daily, weekdays, weekly, monthly, minutes, hours, once", r.Kind)
	}
}

func (r Recurrence) validateClock() error {
	if r.Hour < 0 || r.Hour > 23 {
		return fmt.Errorf("recurrence hour %d is outside 0-23", r.Hour)
	}
	if r.Minute < 0 || r.Minute > 59 {
		return fmt.Errorf("recurrence minute %d is outside 0-59", r.Minute)
	}
	return nil
}

// Location is the zone the rule is expressed in. An unknown name falls back to
// the daemon's local zone; Validate has already rejected those, so this only
// guards against a stored row that predates validation.
func (r Recurrence) Location() *time.Location {
	if r.TimeZone == "" {
		return time.Local
	}
	loc, err := time.LoadLocation(r.TimeZone)
	if err != nil {
		return time.Local
	}
	return loc
}

// Next returns the first occurrence strictly after `after`, and false when the
// rule has no further occurrence (a once rule in the past).
func (r Recurrence) Next(after time.Time) (time.Time, bool) {
	if r.Validate() != nil {
		return time.Time{}, false
	}
	if r.Kind == RecurrenceOnce {
		at := time.UnixMilli(r.At)
		if !at.After(after) {
			return time.Time{}, false
		}
		return at, true
	}
	if r.Kind == RecurrenceMinutes || r.Kind == RecurrenceHours {
		return r.nextStep(after), true
	}

	loc := r.Location()
	local := after.In(loc)
	// Start from the local calendar day of `after`; the candidate for that day
	// may still be ahead of `after`.
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	for i := 0; i < maxRecurrenceLookaheadDays; i++ {
		if candidate, ok := r.occurrenceOn(day); ok && candidate.After(after) {
			return candidate, true
		}
		day = day.AddDate(0, 0, 1)
	}
	return time.Time{}, false
}

// nextStep is the next aligned instant of a step rule. Alignment is to the
// rule's own clock, so "every 6 hours" fires at 00:00, 06:00, 12:00 and 18:00
// there — which is the whole difference from an interval routine, whose runs
// drift by however long each run took.
//
// The candidates are walked in absolute time and every one is required to be
// strictly after `after`. That matters at a fall-back, where the local clock
// repeats an hour: rebuilding the wall clock would resolve the ambiguous time
// to its first occurrence and could hand back an instant an hour in the past.
// The minute rule starts from absolute time directly, which keeps the minute
// hand's alignment exact in every zone (offsets are whole minutes). The hour
// rule starts from the local top of the hour so that "every 6 hours" stays on
// :00 local in zones whose offset is not a whole hour. (A zone whose DST shift
// is itself 30 minutes, such as Lord Howe, can land on :30 for the rest of that
// day; the next occurrence realigns.)
func (r Recurrence) nextStep(after time.Time) time.Time {
	loc := r.Location()
	if r.Kind == RecurrenceHours {
		local := after.In(loc)
		t := time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), 0, 0, 0, loc)
		// One extra day of scan absorbs a fall-back's repeated hour.
		for i := 0; i < 48; i++ {
			t = t.Add(time.Hour)
			if t.After(after) && t.In(loc).Hour()%r.Every == 0 {
				return t
			}
		}
		return t
	}
	t := after.Truncate(time.Minute).Add(time.Minute)
	for i := 0; i < 60; i++ {
		if t.In(loc).Minute()%r.Every == 0 {
			return t
		}
		t = t.Add(time.Minute)
	}
	return t
}

// period returns the nominal gap between two consecutive occurrences starting
// at or after `after`. The scheduler uses it as the "how overdue is too
// overdue" threshold that an interval routine gets from interval_secs.
func (r Recurrence) period(after time.Time) time.Duration {
	first, ok := r.Next(after)
	if !ok {
		return 0
	}
	second, ok := r.Next(first)
	if !ok {
		return 0
	}
	return second.Sub(first)
}

// NominalIntervalSeconds is the routine's pace in seconds, for the column that
// every routine still carries. A wall-clock rule does not need one, so the API
// derives it rather than asking the user for a number they would not recognise
// as their own choice.
func (r Recurrence) NominalIntervalSeconds(now time.Time) int64 {
	if r.Kind == RecurrenceOnce {
		if first, ok := r.Next(now); ok {
			if secs := int64(first.Sub(now).Seconds()); secs > 0 {
				return secs
			}
		}
		return 60
	}
	if period := r.period(now); period > 0 {
		return int64(period.Seconds())
	}
	return 60
}

// occurrenceOn returns the rule's time of day on `day`, if that day matches.
func (r Recurrence) occurrenceOn(day time.Time) (time.Time, bool) {
	loc := day.Location()
	switch r.Kind {
	case RecurrenceDaily:
		return time.Date(day.Year(), day.Month(), day.Day(), r.Hour, r.Minute, 0, 0, loc), true
	case RecurrenceWeekdays:
		if wd := int(day.Weekday()); wd == 0 || wd == 6 {
			return time.Time{}, false
		}
		return time.Date(day.Year(), day.Month(), day.Day(), r.Hour, r.Minute, 0, 0, loc), true
	case RecurrenceWeekly:
		wd := int(day.Weekday())
		for _, want := range r.Weekdays {
			if want == wd {
				return time.Date(day.Year(), day.Month(), day.Day(), r.Hour, r.Minute, 0, 0, loc), true
			}
		}
		return time.Time{}, false
	case RecurrenceMonthly:
		// A day the month does not have means the month's last day, so a
		// "the 31st" routine still runs in February instead of skipping it.
		last := time.Date(day.Year(), day.Month()+1, 0, 0, 0, 0, 0, loc).Day()
		days := append([]int(nil), r.Days...)
		sort.Ints(days)
		for _, want := range days {
			if want > last {
				want = last
			}
			if want == day.Day() {
				return time.Date(day.Year(), day.Month(), day.Day(), r.Hour, r.Minute, 0, 0, loc), true
			}
		}
		return time.Time{}, false
	}
	return time.Time{}, false
}
