/**
 * Fake TTS worker for tts-worker-pool tests.
 *
 * Speaks the same JSON-lines protocol as kokoro_worker.py /
 * supertonic_worker.py, but is a plain Node script so tests can spawn it
 * via the mocked resolveTtsPython (pythonPath = process.execPath).
 *
 * Behavior:
 *  - Sends {"ready": true} immediately on startup.
 *  - Responds to any request whose text does NOT start with "HANG".
 *  - Silently ignores "HANG" requests — simulates a wedged worker so the
 *    request-timeout escalation path can be exercised in ~300ms.
 *  - Appends a line to $FAKE_WORKER_COUNT_FILE on each process start, so
 *    tests can assert how many times the pool spawned a worker.
 */
import { appendFileSync } from "node:fs";

if (process.env.FAKE_WORKER_COUNT_FILE) {
  appendFileSync(process.env.FAKE_WORKER_COUNT_FILE, "1\n");
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

send({ ready: true });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.ping) {
      send({ pong: true });
      continue;
    }
    if (typeof req.id === "number") {
      if (typeof req.text === "string" && req.text.startsWith("HANG")) {
        continue; // wedged: never answer
      }
      const audio = Buffer.from(`fake-audio:${req.id}`).toString("base64");
      send({ id: req.id, audio, duration: 1.0, sampleRate: 24000, size: 12 });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
