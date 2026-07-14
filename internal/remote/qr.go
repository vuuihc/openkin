package remote

import (
	"fmt"
	"io"
	"os"

	qrcode "github.com/skip2/go-qrcode"
)

// PrintQR writes a terminal-scannable QR code of url to w (stdout by default).
func PrintQR(w io.Writer, url string) error {
	if w == nil {
		w = os.Stdout
	}
	qr, err := qrcode.New(url, qrcode.Medium)
	if err != nil {
		return fmt.Errorf("qrcode: %w", err)
	}
	// ToSmallString(false) = black modules as █ on light terminals.
	_, err = fmt.Fprintln(w, qr.ToSmallString(false))
	return err
}
