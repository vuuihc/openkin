package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
)

// maxUploadBytes caps a single uploaded file (images + common text/binary attachments).
const maxUploadBytes = 20 << 20 // 20 MiB

// allowedImageExt maps a detected/declared image MIME to a stored extension.
var allowedImageExt = map[string]string{
	"image/png":     ".png",
	"image/jpeg":    ".jpg",
	"image/gif":     ".gif",
	"image/webp":    ".webp",
	"image/bmp":     ".bmp",
	"image/svg+xml": ".svg",
}

// allowedFileExt maps non-image MIME types we accept as general attachments.
// Agents receive the absolute path and can open/read these files.
var allowedFileExt = map[string]string{
	"text/plain":               ".txt",
	"text/markdown":            ".md",
	"text/csv":                 ".csv",
	"text/html":                ".html",
	"text/css":                 ".css",
	"text/xml":                 ".xml",
	"application/json":         ".json",
	"application/xml":          ".xml",
	"application/javascript":   ".js",
	"application/typescript":   ".ts",
	"application/pdf":          ".pdf",
	"application/zip":          ".zip",
	"application/gzip":         ".gz",
	"application/x-gzip":       ".gz",
	"application/x-tar":        ".tar",
	"application/x-yaml":       ".yaml",
	"application/yaml":         ".yaml",
	"text/yaml":                ".yaml",
	"application/octet-stream": "", // resolved via original filename extension
}

// allowedExtFallback is used when DetectContentType is unhelpful (text/* as
// application/octet-stream) but the original extension is known-safe.
var allowedExtFallback = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".svg":  "image/svg+xml",
	".txt":  "text/plain",
	".md":   "text/markdown",
	".markdown": "text/markdown",
	".csv":  "text/csv",
	".html": "text/html",
	".htm":  "text/html",
	".css":  "text/css",
	".xml":  "application/xml",
	".json": "application/json",
	".js":   "application/javascript",
	".ts":   "application/typescript",
	".tsx":  "application/typescript",
	".jsx":  "application/javascript",
	".pdf":  "application/pdf",
	".zip":  "application/zip",
	".gz":   "application/gzip",
	".tar":  "application/x-tar",
	".yaml": "application/yaml",
	".yml":  "application/yaml",
	".go":   "text/plain",
	".py":   "text/plain",
	".rs":   "text/plain",
	".rb":   "text/plain",
	".java": "text/plain",
	".c":    "text/plain",
	".h":    "text/plain",
	".cpp":  "text/plain",
	".hpp":  "text/plain",
	".sh":   "text/plain",
	".bash": "text/plain",
	".zsh":  "text/plain",
	".toml": "text/plain",
	".ini":  "text/plain",
	".env":  "text/plain",
	".log":  "text/plain",
	".sql":  "text/plain",
}

// uploadResponse is the body of POST /api/uploads.
type uploadResponse struct {
	ID   string `json:"id"`   // stored filename (id + ext), used in the URL
	Name string `json:"name"` // original client filename
	Mime string `json:"mime"`
	Size int64  `json:"size"`
	URL  string `json:"url"`  // GET path to preview/serve the file
	Path string `json:"path"` // absolute on-disk path (agents read files by path)
}

// uploadsDir returns the configured directory or a sane default under the DB dir.
func (s *Server) uploadsDir() string {
	if strings.TrimSpace(s.UploadsDir) != "" {
		return s.UploadsDir
	}
	return ""
}

// handleUpload accepts a single file via multipart/form-data (field "file"),
// validates type/size, stores it under UploadsDir, and returns its URL+path.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	dir := s.uploadsDir()
	if dir == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "uploads not configured"})
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "create uploads dir: " + err.Error()})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+1024)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("file too large (max %d MiB)", maxUploadBytes>>20),
		})
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing file field"})
		return
	}
	defer file.Close()

	if hdr.Size > 0 && hdr.Size > maxUploadBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("file too large (max %d MiB)", maxUploadBytes>>20),
		})
		return
	}

	// Sniff the leading bytes to determine the true content type.
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	head = head[:n]
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "seek: " + err.Error()})
		return
	}

	detected := http.DetectContentType(head)
	ext, mimeType, ok := resolveUploadType(detected, hdr.Header.Get("Content-Type"), hdr.Filename, head)
	if !ok {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{
			"error": "unsupported file type (images and common text/docs only)",
		})
		return
	}

	id, err := randomID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	storedName := id + ext
	dst := filepath.Join(dir, storedName)
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "create file: " + err.Error()})
		return
	}
	size, err := io.Copy(out, io.LimitReader(file, maxUploadBytes+1))
	closeErr := out.Close()
	if err != nil || closeErr != nil {
		_ = os.Remove(dst)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "write file"})
		return
	}
	if size > maxUploadBytes {
		_ = os.Remove(dst)
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("file too large (max %d MiB)", maxUploadBytes>>20),
		})
		return
	}

	writeJSON(w, http.StatusCreated, uploadResponse{
		ID:   storedName,
		Name: sanitizeOriginalName(hdr.Filename),
		Mime: mimeType,
		Size: size,
		URL:  "/api/uploads/" + storedName,
		Path: dst,
	})
}

// resolveUploadType picks a stored extension + MIME for an upload.
func resolveUploadType(detected, declared, filename string, head []byte) (ext, mimeType string, ok bool) {
	// 1) Detected image MIME is authoritative.
	if e, hit := allowedImageExt[detected]; hit {
		return e, detected, true
	}
	// 2) Detected non-image allowed MIME.
	if e, hit := allowedFileExt[detected]; hit {
		if e != "" {
			return e, detected, true
		}
	}
	// 3) Declared Content-Type (SVG often sniffs as octet-stream).
	declared = strings.TrimSpace(strings.Split(declared, ";")[0])
	if e, hit := allowedImageExt[declared]; hit {
		return e, declared, true
	}
	if e, hit := allowedFileExt[declared]; hit && e != "" {
		return e, declared, true
	}
	// 4) Original filename extension.
	origExt := strings.ToLower(filepath.Ext(filename))
	if mimeFromExt, hit := allowedExtFallback[origExt]; hit {
		// Prefer the extension's canonical MIME; keep original extension when possible.
		return origExt, mimeFromExt, true
	}
	// 5) UTF-8 text with no extension → .txt (clipboard paste of text is rare; keep safe).
	if isMostlyText(head) && origExt == "" {
		return ".txt", "text/plain", true
	}
	return "", "", false
}

func isMostlyText(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	// Reject NULs (binary).
	for _, c := range b {
		if c == 0 {
			return false
		}
	}
	return utf8.Valid(b)
}

func sanitizeOriginalName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "upload"
	}
	return name
}

// handleServeUpload serves a previously uploaded file by its stored filename.
func (s *Server) handleServeUpload(w http.ResponseWriter, r *http.Request) {
	dir := s.uploadsDir()
	if dir == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	name := chi.URLParam(r, "name")
	if !safeUploadName(name) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	full := filepath.Join(dir, name)
	// Defense in depth: ensure the resolved path stays inside the uploads dir.
	if rel, err := filepath.Rel(dir, full); err != nil || strings.HasPrefix(rel, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	if _, err := os.Stat(full); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if ct := mimeByExt(name); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	// Private + short cache: URL is token-gated (Bearer or ?token=).
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, full)
}

// safeUploadName allows only <hex>.<ext> filenames (no separators, no traversal).
func safeUploadName(name string) bool {
	if name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return false
	}
	base := filepath.Base(name)
	if base != name {
		return false
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return false
	}
	if _, ok := allowedExtFallback[ext]; ok {
		return true
	}
	// Also accept any extension we may have stored from allowed maps.
	for _, e := range allowedImageExt {
		if e == ext {
			return true
		}
	}
	for _, e := range allowedFileExt {
		if e != "" && e == ext {
			return true
		}
	}
	return false
}

// mimeByExt returns the MIME for a filename's extension, or "".
func mimeByExt(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if m, ok := allowedExtFallback[ext]; ok {
		return m
	}
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".svg":
		return "image/svg+xml"
	}
	// Fall back to the stdlib table for anything else.
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return ""
}

func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("random id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
