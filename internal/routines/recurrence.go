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
	// Kind is one of daily, weekdays, weekly, monthly, once.
	Kind string `json:"kind"`
	// Hour and Minute are the wall-clock time of day for every kind but once.
	Hour   int `json:"hour"`
	Minute int `json:"minute"`
	// Weekdays selects days for kind=weekly, 0=Sunday … 6=Saturday.
	Weekdays []int `json:"weekdays,omitempty"`
	// Days selects days of the month for kind=monthly, 1-31.
	Days []int `json:"days,omitempty"`
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
	case RecurrenceOnce:
		if r.At <= 0 {
			return fmt.Errorf("recurrence at is required for kind %q", r.Kind)
		}
		return nil
	case "":
		return fmt.Errorf("recurrence kind is required")
	default:
		return fmt.Errorf("recurrence kind %q is not one of daily, weekdays, weekly, monthly, once", r.Kind)
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
