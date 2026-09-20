//go:build darwin && !cgo

package secret

func newPlatformStore(dir string) (Store, error) {
	return NewFileStore(dir)
}
