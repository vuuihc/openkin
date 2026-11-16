//go:build !darwin

package secret

func newPlatformStore(dir string) (Store, error) {
	return NewFileStore(dir)
}
