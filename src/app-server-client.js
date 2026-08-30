import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Minimal JSON-RPC 2.0 client for the Codex `app-server`.
 *
 * Transport: newline-delimited JSON over the child process's stdio
 * (`codex app-server` with the default `--listen stdio://`). No
 * Content-Length framing — one JSON object per line.
 *
 * Handshake: an `initialize` request followed by an `initialized`
 * notification, after which regular requests such as
 * `account/usage/read` are accepted.
 */
export class AppServerClient {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #exited = null;

  constructor({ command = 'codex', args = ['app-server'], env, timeoutMs = 30_000 } = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.stderr = '';
  }

  start() {
    if (this.#child) throw new Error('client already started');
    this.#child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env ?? process.env,
    });

    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk) => {
      // Keep a bounded tail of stderr for error reporting.
      this.stderr = (this.stderr + chunk).slice(-8192);
    });

    const lines = createInterface({ input: this.#child.stdout });
    lines.on('line', (line) => this.#onLine(line));

    this.#exited = new Promise((resolve) => {
      this.#child.once('exit', (code, signal) => {
        this.#failAllPending(new Error(`app-server exited (code=${code}, signal=${signal})`));
        resolve({ code, signal });
      });
    });
    this.#child.once('error', (err) => {
      this.#failAllPending(new Error(`failed to spawn ${this.command}: ${err.message}`));
    });
    return this;
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON (stray log line) — ignore
    }
    // Only responses to our requests matter here; server notifications
    // and server-initiated requests are irrelevant for a usage read.
    if (msg.id === undefined || msg.method !== undefined) return;
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const { code, message, data } = msg.error;
      const err = new Error(`app-server error ${code}: ${message}`);
      err.code = code;
      err.data = data;
      pending.reject(err);
    } else {
      pending.resolve(msg.result);
    }
  }

  #failAllPending(err) {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.#pending.clear();
  }

  #send(msg) {
    if (!this.#child || this.#child.exitCode !== null) {
      throw new Error('app-server is not running');
    }
    this.#child.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timed out after ${this.timeoutMs}ms waiting for ${method}`));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
  }

  /** Perform the initialize handshake. Returns the server's initialize result. */
  async initialize({ name = 'codex-usage-script', version = '1.0.0', experimentalApi = true } = {}) {
    const result = await this.request('initialize', {
      clientInfo: { name, title: 'Codex Usage Script', version },
      capabilities: { experimentalApi },
    });
    this.notify('initialized');
    return result;
  }

  /**
   * Call `account/usage/read`. Pass `threadId` to read estimated usage for
   * one thread instead of account-wide token activity.
   */
  readAccountUsage({ threadId } = {}) {
    return this.request('account/usage/read', threadId ? { threadId } : {});
  }

  async close() {
    if (!this.#child) return;
    this.#child.stdin.end();
    const exited = await Promise.race([
      this.#exited,
      new Promise((resolve) => setTimeout(resolve, 2000, null)),
    ]);
    if (exited === null) this.#child.kill('SIGKILL');
    await this.#exited;
  }
}
