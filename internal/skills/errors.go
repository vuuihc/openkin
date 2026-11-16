package skills

import "errors"

var (
	ErrInvalidManifest = errors.New("invalid skill manifest")
	ErrDuplicateSkill  = errors.New("duplicate skill")
	ErrUnsafePackage   = errors.New("unsafe skill package")
	ErrUnsupported     = errors.New("unsupported skill source")
)
