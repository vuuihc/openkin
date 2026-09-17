package connectors

import "errors"

var (
	ErrDisabled       = errors.New("connector is disabled")
	ErrToolDenied     = errors.New("connector tool is not allowlisted")
	ErrInvalidConfig  = errors.New("invalid connector configuration")
	ErrOutputTooLarge = errors.New("connector output exceeds limit")
	ErrUnsafeURL      = errors.New("connector URL is not allowed")
)
