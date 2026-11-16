package droid

import (
	"encoding/json"
	"fmt"
)

const (
	jsonRPCVersion         = "2.0"
	factoryAPIVersion      = "1.0.0"
	factoryProtocolVersion = "1.193.0"

	methodInitializeSession   = "droid.initialize_session"
	methodLoadSession         = "droid.load_session"
	methodAddUserMessage      = "droid.add_user_message"
	methodUpdateSettings      = "droid.update_session_settings"
	methodCloseSession        = "droid.close_session"
	methodInterruptSession    = "droid.interrupt_session"
	methodSessionNotification = "droid.session_notification"
	methodRequestPermission   = "droid.request_permission"
	methodAskUser             = "droid.ask_user"
)

type rpcEnvelope struct {
	Type                   string          `json:"type"`
	JSONRPC                string          `json:"jsonrpc"`
	FactoryAPIVersion      string          `json:"factoryApiVersion"`
	FactoryProtocolVersion string          `json:"factoryProtocolVersion"`
	ID                     string          `json:"id,omitempty"`
	Method                 string          `json:"method,omitempty"`
	Params                 json.RawMessage `json:"params,omitempty"`
	Result                 json.RawMessage `json:"result,omitempty"`
	Error                  *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func validateIncomingEnvelope(env rpcEnvelope) error {
	if env.JSONRPC != jsonRPCVersion {
		return fmt.Errorf("jsonrpc %q does not match %q", env.JSONRPC, jsonRPCVersion)
	}
	if env.FactoryAPIVersion != factoryAPIVersion {
		return fmt.Errorf("factoryApiVersion %q does not match %q", env.FactoryAPIVersion, factoryAPIVersion)
	}
	// SDK 0.9.0 explicitly permits this field to be absent while older peers
	// roll forward. Once present, it is the runtime compatibility signal.
	if env.FactoryProtocolVersion != "" && env.FactoryProtocolVersion != factoryProtocolVersion {
		return fmt.Errorf(
			"factoryProtocolVersion %q does not match %q",
			env.FactoryProtocolVersion,
			factoryProtocolVersion,
		)
	}
	return nil
}

func requestEnvelope(id, method string, params any) rpcEnvelope {
	return rpcEnvelope{
		Type:                   "request",
		JSONRPC:                jsonRPCVersion,
		FactoryAPIVersion:      factoryAPIVersion,
		FactoryProtocolVersion: factoryProtocolVersion,
		ID:                     id,
		Method:                 method,
		Params:                 mustMarshal(params),
	}
}

func responseEnvelope(id string, result any) rpcEnvelope {
	return rpcEnvelope{
		Type:                   "response",
		JSONRPC:                jsonRPCVersion,
		FactoryAPIVersion:      factoryAPIVersion,
		FactoryProtocolVersion: factoryProtocolVersion,
		ID:                     id,
		Result:                 mustMarshal(result),
	}
}

func errorResponseEnvelope(id string, code int, message string) rpcEnvelope {
	return rpcEnvelope{
		Type:                   "response",
		JSONRPC:                jsonRPCVersion,
		FactoryAPIVersion:      factoryAPIVersion,
		FactoryProtocolVersion: factoryProtocolVersion,
		ID:                     id,
		Error:                  &rpcError{Code: code, Message: message},
	}
}
