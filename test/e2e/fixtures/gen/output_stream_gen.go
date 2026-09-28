//go:build ignore

// output_stream_gen writes test/e2e/fixtures/output-stream.json: a Worker-signed OUTPUT stream
// (TRUEOPEN_OUTPUT_CHUNK_V1 frames plus a TRUEOPEN_OUTPUT_FIN_V1 Fin) for the task the e2e full
// flow places. It is fixture tooling, not part of the test run.
//
// It uses nexus's own digest and MMR code (github.com/TrueOpen/nexus internal/nodecontract and
// internal/mmr) and signs the way a Worker does: direct-digest secp256k1, RFC 6979, low-S, raw
// 64-byte R||S. Before writing anything it reproduces a stream captured from a real Worker for a
// different task, byte for byte (signatures included, since RFC 6979 is deterministic), so the
// output is exactly what a Worker would have signed.
//
// Regenerate (only needed when the e2e order, and so its task_hash, changes):
//
//	cp test/e2e/fixtures/gen/output_stream_gen.go <nexus checkout>/internal/e2egen/
//	cd <nexus checkout> && go run ./internal/e2egen/output_stream_gen.go \
//	    -task-hash <hex> -session <hex> -task <hex> > <sdk>/test/e2e/fixtures/output-stream.json
//	rm -r internal/e2egen
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"

	"github.com/TrueOpen/nexus/internal/mmr"
	"github.com/TrueOpen/nexus/internal/nodecontract"
)

const (
	chainID = "trueopen-interop-1"
	// Worker service key used by the e2e world (and by the captured reference stream).
	workerKeyHex = "3131313131313131313131313131313131313131313131313131313131313131"
	finishEOS    = 1
)

// Frame cuts land next to multi-byte UTF-8 sequences on purpose (2-, 3- and 4-byte ones).
var chunks = []string{"Hello, \u4e16", "\u754c\U0001f642\u00e9", "\u2014ok na\u00efve", "\u2713"}

// Reference: the same chunks signed by a real Worker for task_hash sha256("interop-accepted-task").
const (
	refTaskHash = "4a35b63be7e59edcdb301200873df91cf65f93ad3a77e0b63f7127c4e0ba7e09"
	refSig0     = "eb321eef138d7bacf2da20d9f0a598693e52f793429fef4c0069f1d5b77cd6d433b0ea63ff79472d1434c3944fd8c7dd4531fa700f84aface6d03b57f4b4e36f"
	refSig3     = "44d7cb100131244beeb08dc04f300c3cd7fa2a9c1aac9ea816e206d260dc70746ac271645c5d19184d71c23ff77b62090c371e953c096028f4bd9502251c877e"
	refFinSig   = "c004dd8e9880e608e3660d776e6e3c58eed948a4ecc4b2ee413f88258eeab680767188157445b2bfbd338f93b175833f0fb1e25c9ee81bd8d9253d46708d7ea5"
	refRoot     = "0a5a7d5ed29841c52ad95fd5016ed2bd1b7619d5864d8ddb5a8b033b5ff283ec"
)

type frame struct {
	Seq  uint64 `json:"seq"`
	Text string `json:"text_b64"`
	Root string `json:"root_hex"`
	Sig  string `json:"sig_hex"`
}

type fin struct {
	FinalSeq     uint64 `json:"final_seq"`
	Root         string `json:"root_hex"`
	FinishReason uint32 `json:"finish_reason"`
	Sig          string `json:"sig_hex"`
}

func sign(key *secp256k1.PrivateKey, digest [32]byte) []byte {
	sig := ecdsa.Sign(key, digest[:])
	r, s := sig.R(), sig.S()
	rb, sb := r.Bytes(), s.Bytes()
	return append(append([]byte{}, rb[:]...), sb[:]...)
}

func build(taskHash []byte) ([]frame, fin, []uint64, []byte) {
	keyBytes, _ := hex.DecodeString(workerKeyHex)
	key := secp256k1.PrivKeyFromBytes(keyBytes)
	acc, err := mmr.New(nodecontract.DomainOutputMMRV1)
	must(err)
	var frames []frame
	var lengths []uint64
	var output bytes.Buffer
	var root mmr.Hash
	for i, c := range chunks {
		acc.Append([]byte(c))
		root = acc.Root()
		digest, err := nodecontract.OutputChunkSigningDigest(chainID, taskHash, uint64(i), root[:])
		must(err)
		frames = append(frames, frame{
			Seq: uint64(i), Text: base64.StdEncoding.EncodeToString([]byte(c)),
			Root: hex.EncodeToString(root[:]), Sig: hex.EncodeToString(sign(key, digest)),
		})
		lengths = append(lengths, uint64(len(c)))
		output.WriteString(c)
	}
	last := uint64(len(chunks) - 1)
	finDigest, err := nodecontract.OutputFinSigningDigest(chainID, taskHash, last, root[:], finishEOS)
	must(err)
	return frames, fin{FinalSeq: last, Root: hex.EncodeToString(root[:]), FinishReason: finishEOS,
		Sig: hex.EncodeToString(sign(key, finDigest))}, lengths, output.Bytes()
}

func main() {
	taskHashHex := flag.String("task-hash", "", "accepted task_hash, 64 hex")
	sessionID := flag.String("session", "", "session id, 64 hex")
	taskID := flag.String("task", "", "task id, 64 hex")
	flag.Parse()

	ref, _ := hex.DecodeString(refTaskHash)
	rf, rfin, _, _ := build(ref)
	if rf[0].Sig != refSig0 || rf[3].Sig != refSig3 || rfin.Sig != refFinSig || rfin.Root != refRoot {
		fmt.Fprintln(os.Stderr, "reference stream not reproduced; refusing to write a fixture")
		os.Exit(1)
	}

	taskHash, err := hex.DecodeString(*taskHashHex)
	if err != nil || len(taskHash) != 32 || len(*sessionID) != 64 || len(*taskID) != 64 {
		fmt.Fprintln(os.Stderr, "need -task-hash, -session and -task as 64 hex each")
		os.Exit(2)
	}
	frames, f, lengths, output := build(taskHash)
	keyBytes, _ := hex.DecodeString(workerKeyHex)
	pub := secp256k1.PrivKeyFromBytes(keyBytes).PubKey().SerializeCompressed()
	out := map[string]any{
		"note":              "Worker-signed OUTPUT stream for the e2e full-flow task; generated by fixtures/gen/output_stream_gen.go",
		"chain_id":          chainID,
		"session_id":        *sessionID,
		"task_id":           *taskID,
		"task_hash":         *taskHashHex,
		"worker_pubkey_hex": hex.EncodeToString(pub),
		"frames":            frames,
		"fin":               f,
		"chunk_lengths":     lengths,
		"output_b64":        base64.StdEncoding.EncodeToString(output),
		"output_hash":       f.Root,
		"output_size_bytes": len(output),
		"output_leaf_count": len(lengths),
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	must(enc.Encode(out))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
