package connectors

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"strings"
)

const mcpProtocolVersion = "2024-11-05"

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcNotification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func stdioRequest(ctx context.Context, cfg Config, method string, params any, max int64) (json.RawMessage, error) {
	procCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(procCtx, cfg.Command, cfg.Args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open connector stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open connector stdout: %w", err)
	}
	budget := &byteBudget{max: max}
	cmd.Stderr = &budgetWriter{budget: budget}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start connector: %w", err)
	}
	reader := bufio.NewReader(stdout)
	fail := func(err error) (json.RawMessage, error) {
		cancel()
		_ = cmd.Wait()
		return nil, err
	}
	initialize := rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "initialize",
		Params: map[string]any{
			"protocolVersion": mcpProtocolVersion,
			"capabilities":    map[string]any{},
			"clientInfo": map[string]any{
				"name":    "openkin",
				"version": "dev",
			},
		},
	}
	if err := writeRPCLine(stdin, initialize); err != nil {
		return fail(fmt.Errorf("write connector initialize: %w", err))
	}
	if _, err := readRPCResult(reader, budget, 1); err != nil {
		return fail(err)
	}
	if err := writeRPCLine(stdin, rpcNotification{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}); err != nil {
		return fail(fmt.Errorf("write connector initialized notification: %w", err))
	}
	if err := writeRPCLine(stdin, rpcRequest{
		JSONRPC: "2.0",
		ID:      2,
		Method:  method,
		Params:  params,
	}); err != nil {
		return fail(fmt.Errorf("write connector request: %w", err))
	}
	if err := stdin.Close(); err != nil {
		return fail(fmt.Errorf("close connector stdin: %w", err))
	}
	raw, readErr := readRPCResult(reader, budget, 2)
	cancel()
	_ = cmd.Wait()
	if readErr != nil {
		return nil, readErr
	}
	return raw, nil
}

func writeRPCLine(w io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode MCP request: %w", err)
	}
	data = append(data, '\n')
	_, err = w.Write(data)
	return err
}

func callStdio(ctx context.Context, cfg Config, tool string, args map[string]any, max int64) (Result, error) {
	raw, err := stdioRequest(ctx, cfg, "tools/call", map[string]any{
		"name": tool, "arguments": args,
	}, max)
	if err != nil {
		return Result{}, err
	}
	return decodeResult(raw)
}

func readRPCResult(reader *bufio.Reader, budget *byteBudget, expectedID int64) (json.RawMessage, error) {
	for {
		line, err := readBoundedLine(reader, budget)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, errors.New("connector closed before returning an MCP response")
			}
			return nil, fmt.Errorf("read connector response: %w", err)
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var response rpcResponse
		if err := json.Unmarshal(line, &response); err != nil {
			return nil, fmt.Errorf("decode connector response: %w", err)
		}
		if response.JSONRPC != "2.0" {
			return nil, errors.New("decode connector response: invalid JSON-RPC version")
		}
		var id int64
		if err := json.Unmarshal(response.ID, &id); err != nil || id != expectedID {
			continue
		}
		if response.Error != nil {
			return nil, fmt.Errorf("MCP remote error %d", response.Error.Code)
		}
		if len(response.Result) == 0 || bytes.Equal(response.Result, []byte("null")) {
			return nil, errors.New("connector response has no result")
		}
		return append(json.RawMessage(nil), response.Result...), nil
	}
}

func decodeResult(raw json.RawMessage) (Result, error) {
	var payload struct {
		Content json.RawMessage `json:"content"`
		IsError bool            `json:"isError"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return Result{}, fmt.Errorf("decode connector tool result: %w", err)
	}
	var content any
	if len(payload.Content) > 0 && !bytes.Equal(payload.Content, []byte("null")) {
		if err := json.Unmarshal(payload.Content, &content); err != nil {
			return Result{}, fmt.Errorf("decode connector tool content: %w", err)
		}
	} else {
		// Keep non-standard but valid MCP implementations usable. Some tools
		// return a scalar result instead of the canonical content array.
		if err := json.Unmarshal(raw, &content); err != nil {
			return Result{}, fmt.Errorf("decode connector tool result: %w", err)
		}
	}
	return Result{Content: content, IsError: payload.IsError}, nil
}

func readJSONBody(resp *http.Response, max int64) (json.RawMessage, error) {
	messages, err := readJSONMessages(resp, max)
	if err != nil {
		return nil, err
	}
	return messages[len(messages)-1], nil
}

func readJSONMessages(resp *http.Response, max int64) ([]json.RawMessage, error) {
	budget := &byteBudget{max: max}
	data, err := io.ReadAll(&budgetReader{reader: resp.Body, budget: budget})
	if err != nil {
		if errors.Is(err, ErrOutputTooLarge) {
			return nil, ErrOutputTooLarge
		}
		return nil, fmt.Errorf("read connector HTTP response: %w", err)
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return nil, errors.New("connector HTTP response is empty")
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") {
		return sseJSONMessages(data)
	}
	if !json.Valid(data) {
		return nil, errors.New("connector HTTP response is not valid JSON")
	}
	return []json.RawMessage{append(json.RawMessage(nil), data...)}, nil
}

func readJSONRPCResponse(resp *http.Response, max int64, expectedID int64) (json.RawMessage, error) {
	messages, err := readJSONMessages(resp, max)
	if err != nil {
		return nil, err
	}
	for _, message := range messages {
		var response rpcResponse
		if err := json.Unmarshal(message, &response); err != nil {
			continue
		}
		var id int64
		if err := json.Unmarshal(response.ID, &id); err == nil && id == expectedID {
			return message, nil
		}
	}
	return nil, fmt.Errorf("connector response does not contain JSON-RPC id %d", expectedID)
}

func sseJSONMessages(data []byte) ([]json.RawMessage, error) {
	var event bytes.Buffer
	var messages []json.RawMessage
	flush := func() {
		if event.Len() == 0 {
			return
		}
		candidate := bytes.TrimSpace(event.Bytes())
		if json.Valid(candidate) {
			messages = append(messages, append(json.RawMessage(nil), candidate...))
		}
		event.Reset()
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1024), len(data)+1)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if event.Len() > 0 {
				event.WriteByte('\n')
			}
			event.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("decode connector event stream: %w", err)
	}
	flush()
	if len(messages) == 0 {
		return nil, errors.New("connector event stream contains no JSON data")
	}
	return messages, nil
}

func lastSSEData(data []byte) ([]byte, error) {
	messages, err := sseJSONMessages(data)
	if err != nil {
		return nil, err
	}
	return messages[len(messages)-1], nil
}

func safeDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{}
	for _, resolved := range ips {
		if !isPublicIP(resolved.IP) {
			continue
		}
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(resolved.IP.String(), port))
		if dialErr == nil {
			return conn, nil
		}
		err = dialErr
	}
	if err == nil {
		err = errors.New("connector host resolves only to private addresses")
	}
	return nil, err
}

func isPublicIP(ip net.IP) bool {
	return !ip.IsLoopback() &&
		!ip.IsPrivate() &&
		!ip.IsLinkLocalUnicast() &&
		!ip.IsLinkLocalMulticast() &&
		!ip.IsUnspecified() &&
		!ip.IsMulticast()
}

type byteBudget struct {
	max  int64
	used int64
}

func (b *byteBudget) add(n int) error {
	b.used += int64(n)
	if b.max > 0 && b.used > b.max {
		return ErrOutputTooLarge
	}
	return nil
}

type budgetWriter struct {
	budget *byteBudget
}

func (w *budgetWriter) Write(p []byte) (int, error) {
	if err := w.budget.add(len(p)); err != nil {
		return 0, err
	}
	return len(p), nil
}

type budgetReader struct {
	reader io.Reader
	budget *byteBudget
}

func (r *budgetReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n > 0 {
		if budgetErr := r.budget.add(n); budgetErr != nil {
			return n, budgetErr
		}
	}
	return n, err
}

func readBoundedLine(reader *bufio.Reader, budget *byteBudget) ([]byte, error) {
	var line bytes.Buffer
	for {
		part, err := reader.ReadSlice('\n')
		if len(part) > 0 {
			if budgetErr := budget.add(len(part)); budgetErr != nil {
				return nil, budgetErr
			}
			line.Write(part)
		}
		if err == nil {
			return line.Bytes(), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && line.Len() > 0 {
			return line.Bytes(), nil
		}
		return nil, err
	}
}
