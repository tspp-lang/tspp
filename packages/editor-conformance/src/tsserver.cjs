// Talks to the built TS++ tsserver the way an editor does, so these checks see what a user sees.
const { spawn } = require("node:child_process");
const path = require("node:path");

const serverPath = path.resolve(__dirname, "../../compiler/built/local/tsserver.js");

/** Maps offsets of a text to the 1-based lines and columns of the tsserver protocol. */
function locator(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const at = offset => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, offset: offset - lineStarts[low] + 1 };
  };
  const offsetOf = ({ line, offset }) => lineStarts[line - 1] + offset - 1;
  return { at, offsetOf };
}

/** A request this slow means the server is stuck, and an editor would be stuck with it. */
const requestTimeoutMs = 60_000;

class TsServer {
  constructor() {
    this.child = spawn(process.execPath, ["--max-old-space-size=1536", serverPath, "--disableAutomaticTypingAcquisition"], { stdio: ["pipe", "pipe", "pipe"] });
    this.errorTail = "";
    this.child.stderr.on("data", data => this.errorTail = (this.errorTail + data).slice(-2000));
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.pending = new Map();
    this.exited = false;
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      const reason = this.errorTail.trim().split("\n").find(line => /error|fatal/i.test(line)) ?? "no error output";
      for (const resolve of this.pending.values()) resolve({ success: false, message: `Server exited (${signal ?? code}): ${reason}` });
      this.pending.clear();
    });
    this.child.stdin.on("error", () => undefined);
    this.child.stdout.on("data", data => this.receive(data));
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const header = this.buffer.indexOf("\r\n\r\n");
      if (header < 0) return;
      const length = Number(/Content-Length: (\d+)/.exec(this.buffer.subarray(0, header).toString())[1]);
      if (this.buffer.length < header + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(header + 4, header + 4 + length).toString());
      this.buffer = this.buffer.subarray(header + 4 + length);
      if (message.type === "response" && this.pending.has(message.request_seq)) {
        this.pending.get(message.request_seq)(message);
        this.pending.delete(message.request_seq);
      }
    }
  }

  request(command, args) {
    if (this.exited) return Promise.resolve({ success: false, message: "Server has exited." });
    return new Promise(resolve => {
      const seq = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve({ success: false, timedOut: true, message: `${command} did not answer within ${requestTimeoutMs / 1000}s.` });
        this.stop();
      }, requestTimeoutMs);
      this.pending.set(seq, response => {
        clearTimeout(timer);
        resolve(response);
      });
      this.child.stdin.write(`${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`);
    });
  }

  open(file, text, projectRootPath) {
    return this.request("updateOpen", { openFiles: [{ file, fileContent: text, projectRootPath }], changedFiles: [], closedFiles: [] });
  }

  close(file) {
    return this.request("updateOpen", { openFiles: [], changedFiles: [], closedFiles: [file] });
  }

  change(file, start, end, newText) {
    return this.request("updateOpen", { openFiles: [], changedFiles: [{ fileName: file, textChanges: [{ start, end, newText }] }], closedFiles: [] });
  }

  /** Packed `[start, length, class]` triples for the whole file. */
  async semanticSpans(file, length) {
    const response = await this.request("encodedSemanticClassifications-full", { file, start: 0, length, format: "2020" });
    return { response, spans: response.body?.spans ?? [] };
  }

  stop() {
    this.exited = true;
    this.child.kill("SIGKILL");
  }
}

module.exports = { TsServer, locator };
