package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// tiny valid 1x1 PNG.
var onePixelPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
	0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
}

func multipartFile(t *testing.T, field, filename, ctype string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(map[string][]string)
	h["Content-Disposition"] = []string{`form-data; name="` + field + `"; filename="` + filename + `"`}
	if ctype != "" {
		h["Content-Type"] = []string{ctype}
	}
	pw, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, mw.FormDataContentType()
}

func TestUploadAndServeImage(t *testing.T) {
	s, token := newTestServer(t)
	s.UploadsDir = t.TempDir()
	h := s.Handler()

	body, ctype := multipartFile(t, "file", "shot.png", "image/png", onePixelPNG)
	req := httptest.NewRequest(http.MethodPost, "/api/uploads", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload status %d: %s", rr.Code, rr.Body.String())
	}
	var resp uploadResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Mime != "image/png" || resp.Size != int64(len(onePixelPNG)) || resp.Path == "" {
		t.Fatalf("bad response: %+v", resp)
	}

	// Serve it back.
	req = httptest.NewRequest(http.MethodGet, resp.URL, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("serve status %d", rr.Code)
	}
	if !bytes.Equal(rr.Body.Bytes(), onePixelPNG) {
		t.Fatalf("served bytes mismatch")
	}
}

func TestUploadRejectsUnsupportedType(t *testing.T) {
	s, token := newTestServer(t)
	s.UploadsDir = t.TempDir()
	h := s.Handler()

	// Random binary with an unknown extension must be rejected.
	payload := []byte{0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x11, 0x22}
	body, ctype := multipartFile(t, "file", "payload.bin", "application/octet-stream", payload)
	req := httptest.NewRequest(http.MethodPost, "/api/uploads", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestServeUploadRejectsTraversal(t *testing.T) {
	s, token := newTestServer(t)
	s.UploadsDir = t.TempDir()
	h := s.Handler()

	req := httptest.NewRequest(http.MethodGet, "/api/uploads/..%2f..%2fkin.db", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code == http.StatusOK {
		t.Fatalf("traversal should not succeed, got 200")
	}
}

func TestUploadTextFile(t *testing.T) {
	s, token := newTestServer(t)
	s.UploadsDir = t.TempDir()
	h := s.Handler()

	data := []byte("hello from kin upload\n")
	body, ctype := multipartFile(t, "file", "notes.txt", "text/plain", data)
	req := httptest.NewRequest(http.MethodPost, "/api/uploads", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload status %d: %s", rr.Code, rr.Body.String())
	}
	var resp uploadResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Mime != "text/plain" || resp.Size != int64(len(data)) {
		t.Fatalf("bad response: %+v", resp)
	}
	if !strings.HasSuffix(resp.ID, ".txt") {
		t.Fatalf("expected .txt id, got %s", resp.ID)
	}
}

func TestUploadRejectsTooLarge(t *testing.T) {
	s, token := newTestServer(t)
	s.UploadsDir = t.TempDir()
	h := s.Handler()

	// Build a multipart body larger than maxUploadBytes.
	big := bytes.Repeat([]byte("a"), maxUploadBytes+1024)
	body, ctype := multipartFile(t, "file", "big.txt", "text/plain", big)
	req := httptest.NewRequest(http.MethodPost, "/api/uploads", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusRequestEntityTooLarge && rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 413/400, got %d: %s", rr.Code, rr.Body.String())
	}
}
