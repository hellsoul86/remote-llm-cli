package accesskey

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func Generate() (fullKey string, prefix string, secret string, err error) {
	id, err := randomHex(6)
	if err != nil {
		return "", "", "", err
	}
	prefix = "rlm_" + id
	secret, err = randomToken(24)
	if err != nil {
		return "", "", "", err
	}
	return prefix + "." + secret, prefix, secret, nil
}

func HashSecret(secret string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

func VerifySecret(hash string, secret string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(secret)) == nil
}

func ParseFullKey(full string) (prefix string, secret string, ok bool) {
	parts := strings.SplitN(strings.TrimSpace(full), ".", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	if parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func randomHex(byteLen int) (string, error) {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func randomToken(byteLen int) (string, error) {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func Redact(full string) string {
	prefix, _, ok := ParseFullKey(full)
	if !ok {
		return "invalid-key"
	}
	return fmt.Sprintf("%s.***", prefix)
}
