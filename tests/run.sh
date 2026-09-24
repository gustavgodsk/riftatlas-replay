#!/usr/bin/env bash
# Build a replay from a capture and run every check against it.
#
#   tests/run.sh path/to/capture.har
#
# Derived artifacts land in tests/tmp/, which is gitignored: captures and the
# replays built from them carry player names and are never committed.
set -euo pipefail
HAR="${1:?usage: tests/run.sh <capture.har>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$ROOT/tests/tmp"
mkdir -p "$TMP"

echo "== extract frames =="
python3 "$ROOT/tools/har_to_jsonl.py" "$HAR" "$TMP/frames.jsonl"

echo
echo "== python reducer =="
(cd "$ROOT/tools" && python3 verify.py "$TMP/frames.jsonl")

echo
echo "== javascript reducer (must match the python output above) =="
node "$ROOT/tests/reducer-parity.mjs" "$TMP/frames.jsonl"

echo
echo "== build replay =="
(cd "$ROOT/tools" && python3 har_to_replay.py "$HAR" "$TMP/replay.ratlas.json")

echo
echo "== who won =="
node "$ROOT/tests/outcome.mjs"

echo
echo "== match-end detector =="
node "$ROOT/tests/finish-detector.mjs"

echo
echo "== frames arriving after a recording closes =="
node "$ROOT/tests/late-frames.mjs"

echo
echo "== a best-of-three game settled between games =="
node "$ROOT/tests/series-ledger.mjs"

echo
echo "== a closing socket ends one match, not all of them =="
node "$ROOT/tests/socket-close.mjs"

echo
echo "== in-game notes =="
node "$ROOT/tests/notes.mjs"

echo
echo "== send to site: export string, filename, retry backoff =="
node "$ROOT/tests/upload.mjs"

echo
echo "== the detector must not fire before the real ending =="
node --input-type=module -e "
import fs from 'node:fs';
const { looksFinished } = await import('$ROOT/extension/background/recorder.js');
const hits = [];
for (const line of fs.readFileSync('$TMP/frames.jsonl','utf8').split('\n').filter(Boolean)) {
  const { msg } = JSON.parse(line);
  if (looksFinished(msg)) hits.push(msg.sequence);
}
// The detector may fire more than once at the end - a concession shows up in
// every snapshot after it - so what matters is that it never fires early.
const first = hits[0];
const seqs = [...new Set(hits)];
if (seqs.length === 0) {
  console.log('ok   never fires (this capture has no ending)');
} else if (first >= 300) {
  console.log('ok   first fires at sequence ' + first + ', at the end of the match');
} else {
  console.log('FAIL fires early, at sequence ' + first + ' — the initiative roll bug is back');
  process.exit(1);
}
"

echo
echo "== replay structure (any replay) =="
node "$ROOT/tests/replay-smoke.mjs" "$TMP/replay.ratlas.json"

echo
echo "== navigation index (reference match only) =="
node "$ROOT/tests/index-shape.mjs" "$TMP/replay.ratlas.json"

echo
echo "== no credentials in the replay =="
if grep -qE 'eyJ[A-Za-z0-9_-]{20,}' "$TMP/replay.ratlas.json"; then
  echo "FAIL: JWT-shaped string found in replay"; exit 1
fi
if grep -q '"authToken"' "$TMP/replay.ratlas.json"; then
  echo "FAIL: authToken key found in replay"; exit 1
fi
echo "ok   no JWT-shaped strings, no authToken key"

echo
echo "all checks passed"
