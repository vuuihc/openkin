//go:build darwin && cgo

package secret

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
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
	service := []byte(keychainService)
	account := []byte(ref)
	var passwordLen C.UInt32
	var passwordData unsafe.Pointer
	var item C.SecKeychainItemRef
	status := C.SecKeychainFindGenericPassword(
		C.CFTypeRef(0),
		C.UInt32(len(service)), charPtr(service),
		C.UInt32(len(account)), charPtr(account),
		&passwordLen, &passwordData, &item,
	)
	if item != 0 {
		C.CFRelease(C.CFTypeRef(item))
	}
	if status != C.errSecSuccess {
		return "", keychainError("find", status)
	}
	defer C.SecKeychainItemFreeContent(nil, passwordData)
	return C.GoStringN((*C.char)(passwordData), C.int(passwordLen)), nil
}

func (s *platformStore) Put(ref, value string) error {
	if !validReference(ref) {
		return errors.New("invalid secret reference")
	}
	service := []byte(keychainService)
	account := []byte(ref)
	secret := []byte(value)
	var item C.SecKeychainItemRef
	status := C.SecKeychainFindGenericPassword(
		C.CFTypeRef(0),
		C.UInt32(len(service)), charPtr(service),
		C.UInt32(len(account)), charPtr(account),
		nil, nil, &item,
	)
	if status == C.errSecSuccess {
		defer C.CFRelease(C.CFTypeRef(item))
		status = C.SecKeychainItemModifyAttributesAndData(
			item,
			nil,
			C.UInt32(len(secret)), bytePtr(secret),
		)
		if status != C.errSecSuccess {
			return keychainError("update", status)
		}
		return nil
	}
	if status != C.errSecItemNotFound {
		return keychainError("find", status)
	}
	status = C.SecKeychainAddGenericPassword(
		C.SecKeychainRef(0),
		C.UInt32(len(service)), charPtr(service),
		C.UInt32(len(account)), charPtr(account),
		C.UInt32(len(secret)), bytePtr(secret),
		nil,
	)
	if status != C.errSecSuccess {
		return keychainError("add", status)
	}
	return nil
}

func (s *platformStore) Delete(ref string) error {
	if !validReference(ref) {
		return errors.New("invalid secret reference")
	}
	service := []byte(keychainService)
	account := []byte(ref)
	var item C.SecKeychainItemRef
	status := C.SecKeychainFindGenericPassword(
		C.CFTypeRef(0),
		C.UInt32(len(service)), charPtr(service),
		C.UInt32(len(account)), charPtr(account),
		nil, nil, &item,
	)
	if status == C.errSecItemNotFound {
		return nil
	}
	if status != C.errSecSuccess {
		return keychainError("find", status)
	}
	defer C.CFRelease(C.CFTypeRef(item))
	status = C.SecKeychainItemDelete(item)
	if status != C.errSecSuccess {
		return keychainError("delete", status)
	}
	return nil
}

func bytePtr(value []byte) unsafe.Pointer {
	if len(value) == 0 {
		return nil
	}
	return unsafe.Pointer(&value[0])
}

func charPtr(value []byte) *C.char {
	return (*C.char)(bytePtr(value))
}

func keychainError(op string, status C.OSStatus) error {
	return fmt.Errorf("%s keychain item: OSStatus %d", op, int32(status))
}
