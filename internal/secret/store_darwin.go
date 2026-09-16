//go:build darwin

package secret

import (
	"errors"
	"os/exec"
	"strings"
)

const keychainService = "OpenKin Provider Secret"

type platformStore struct{}

func newPlatformStore(_ string) (Store, error) {
	return &platformStore{}, nil
}

func (s *platformStore) Get(ref string) (string, error) {
	if !validReference(ref) {
		return "", errors.New("invalid secret reference")
	}
	out, err := exec.Command("security", "find-generic-password", "-a", ref, "-s", keychainService, "-w").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(string(out), "\n"), nil
}

func (s *platformStore) Put(ref, value string) error {
	if !validReference(ref) {
		return errors.New("invalid secret reference")
	}
	// Keep the secret out of argv; security prompts on stdin when -w is last.
	cmd := exec.Command("security", "add-generic-password", "-a", ref, "-s", keychainService, "-U", "-w")
	cmd.Stdin = strings.NewReader(value + "\n")
	return cmd.Run()
}

func (s *platformStore) Delete(ref string) error {
	if !validReference(ref) {
		return errors.New("invalid secret reference")
	}
	cmd := exec.Command("security", "delete-generic-password", "-a", ref, "-s", keychainService)
	return cmd.Run()
}
