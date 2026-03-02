package executor

import "testing"

func TestLimitedBufferTruncation(t *testing.T) {
	b := newLimitedBuffer(5)
	n, err := b.Write([]byte("hello-world"))
	if err != nil {
		t.Fatalf("write error: %v", err)
	}
	if n != 11 {
		t.Fatalf("write n=%d want=11", n)
	}
	if b.String() != "hello" {
		t.Fatalf("buffer=%q want=hello", b.String())
	}
	if !b.Truncated() {
		t.Fatalf("expected truncated=true")
	}
	if b.TotalBytes() != 11 {
		t.Fatalf("total=%d want=11", b.TotalBytes())
	}
}

func TestNormalizeExecOptions(t *testing.T) {
	opts := normalizeExecOptions(ExecOptions{})
	if opts.MaxStdoutBytes <= 0 || opts.MaxStderrBytes <= 0 {
		t.Fatalf("normalized max bytes should be > 0: %+v", opts)
	}
}
