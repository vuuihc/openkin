package skills

import (
	"fmt"
	"io"
)

func ioReadBounded(r io.Reader, max int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, fmt.Errorf("read imported Skill: %w", err)
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("%w: imported Skill exceeds %d bytes", ErrUnsafePackage, max)
	}
	return data, nil
}
