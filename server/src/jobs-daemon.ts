import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import {
  acquireJobLock,
  readBootId,
  type JobLock,
} from "./services/job-lock.js";
import { ensureJobsDirs, jobsConfigFromEnv, type JobsConfig } from "./services/job-paths.js";
import {
  JOB_PROTOCOL_VERSION,
  MAX_JOB_FRAME_BYTES,
  JobLineDecoder,
  encodeJobFrame,
  isJobKind,
  isJobState,
  type EventFrame,
  type JobEvent,
  type JobKind,
  type JobState,
} from "./services/job-protocol.js";
import { JobStore } from "./services/job-store.js";
import { JobSupervisor, type StartJobInput } from "./services/job-supervisor.js";
import { readProcessStartId } from "./services/process-supervisor.js";

/**
 * porrima-jobs daemon entry point (docs/design/job-supervisor.md §3/§5).
 *
 * The server is a client. The daemon owns the long-lived process plane and
 * detaches on SIGTERM/SIGINT: a daemon restart must never kill a running job.
 */

export interface StartJobsDaemonOptions extends Partial<JobsConfig> {
  bootId?: string;
  caps?: {
    per_chat?: number;
    box?: number;
    services_per_chat?: number;
    services_box?: number;
  };
}

export interface JobsDaemonHandle {
  server: Server;
  supervisor: JobSupervisor;
  store: JobStore;
  config: JobsConfig;
  close(): Promise<void>;
}

const CAPABILITIES = [
  "start",
  "stop",
  "get",
  "list",
  "wait_for",
  "stats",
  "stop_chat",
  "delete_chat_outputs",
  "stop_all",
  "subscribe",
  "ping",
];

export async function startJobsDaemon(
  options: StartJobsDaemonOptions = {},
): Promise<JobsDaemonHandle> {
  const envConfig = jobsConfigFromEnv();
  const config: JobsConfig = {
    jobsDir: options.jobsDir ?? envConfig.jobsDir,
    dbPath: options.dbPath ?? envConfig.dbPath,
    socketPath: options.socketPath ?? envConfig.socketPath,
    lockPath: options.lockPath ?? envConfig.lockPath,
    journalPath: options.journalPath ?? envConfig.journalPath,
  };
  ensureJobsDirs(config);

  const lock: JobLock = acquireJobLock(config.lockPath, options.bootId ?? readBootId());
  let store: JobStore | null = null;
  let supervisor: JobSupervisor | null = null;
  const clients = new Set<ClientSession>();
  let server: Server | null = null;
  let closed = false;

  try {
    store = JobStore.open(config.dbPath);
    supervisor = new JobSupervisor({
      store,
      jobsDir: config.jobsDir,
      journalPath: config.journalPath,
      bootId: lock.bootId,
      caps: options.caps,
    });
    await supervisor.recover();
    supervisor.startRetentionSweep();

    const startedAt = new Date().toISOString();
    const version = process.env.PORRIMA_JOBS_VERSION || "dev";
    const bootId = lock.bootId;
    server = createServer((socket) => {
      const client = new ClientSession(socket, {
        supervisor: supervisor!,
        config,
        startedAt,
        version,
        bootId,
      });
      clients.add(client);
      socket.once("close", () => clients.delete(client));
    });

    server.on("error", (error) => {
      console.warn("[jobs] socket server error:", error);
    });

    unlinkSocket(config.socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server!.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server!.off("error", onError);
        resolve();
      };
      server!.once("error", onError);
      server!.once("listening", onListening);
      server!.listen(config.socketPath);
    });
    chmodSync(config.socketPath, 0o600);

    const onEvent = (event: JobEvent) => {
      for (const client of clients) client.sendEvent(event);
    };
    supervisor.on("event", onEvent);

    const handle: JobsDaemonHandle = {
      server: server!,
      supervisor: supervisor!,
      store: store!,
      config,
      close: async () => {
        if (closed) return;
        closed = true;
        supervisor!.off("event", onEvent);
        for (const client of clients) client.close();
        clients.clear();
        await new Promise<void>((resolve) => {
          try {
            server!.close(() => resolve());
          } catch {
            resolve();
          }
        });
        supervisor!.close();
        store!.close();
        lock.release();
        unlinkSocket(config.socketPath);
      },
    };
    return handle;
  } catch (error) {
    try {
      server?.close();
    } catch {
      // Not listening yet.
    }
    supervisor?.close();
    store?.close();
    lock.release();
    unlinkSocket(config.socketPath);
    throw error;
  }
}

interface SessionDeps {
  supervisor: JobSupervisor;
  config: JobsConfig;
  startedAt: string;
  version: string;
  bootId: string;
}

class ClientSession {
  private readonly decoder = new JobLineDecoder(MAX_JOB_FRAME_BYTES);
  private queue: Promise<void> = Promise.resolve();
  private subscribed = false;
  private lastSeq = 0;

  constructor(
    private readonly socket: Socket,
    private readonly deps: SessionDeps,
  ) {
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of this.decoder.push(chunk)) {
          this.queue = this.queue
            .then(() => this.handleLine(line))
            .catch((error: any) => {
              this.send({ type: "error", error: error?.message ?? String(error) });
            });
        }
      } catch (error: any) {
        this.send({ type: "error", error: error?.message ?? String(error) });
        this.close();
      }
    });
    socket.on("error", (error) => {
      console.warn("[jobs] client socket error:", error.message);
    });
  }

  close(): void {
    if (!this.socket.destroyed) this.socket.destroy();
  }

  sendEvent(event: JobEvent): void {
    if (!this.subscribed) return;
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    const frame: EventFrame = {
      type: "event",
      seq: event.seq,
      event: event.event,
      job_id: event.job_id,
      at: event.at,
      job: event.job,
    };
    this.send(frame);
  }

  private send(value: unknown): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeJobFrame(value));
  }

  private async handleLine(line: string): Promise<void> {
    let request: Record<string, any>;
    try {
      request = JSON.parse(line) as Record<string, any>;
    } catch {
      this.send({ type: "error", error: "malformed protocol frame" });
      return;
    }
    if (!request || typeof request !== "object" || typeof request.type !== "string") {
      this.send({ type: "error", error: "request requires type" });
      return;
    }
    const id = typeof request.id === "string" ? request.id : undefined;
    try {
      switch (request.type) {
        case "hello":
          this.send({
            type: "welcome",
            id,
            protocol: JOB_PROTOCOL_VERSION,
            pid: process.pid,
            start_id: readProcessStartId(process.pid) ?? null,
            boot_id: this.deps.bootId,
            started_at: this.deps.startedAt,
            version: this.deps.version,
            capabilities: CAPABILITIES,
          });
          return;
        case "start": {
          const job = await this.deps.supervisor.start(toStartInput(request));
          this.send({ type: "started", id, job });
          return;
        }
        case "stop": {
          requireString(request.job_id, "job_id");
          const job = await this.deps.supervisor.stop(request.job_id, {
            force: request.force === true,
          });
          this.send({ type: "stopped", id, job });
          return;
        }
        case "get": {
          requireString(request.job_id, "job_id");
          this.send({ type: "job", id, job: this.deps.supervisor.get(request.job_id) });
          return;
        }
        case "list": {
          const states = Array.isArray(request.states)
            ? request.states.filter((state: unknown): state is JobState => isJobState(state))
            : undefined;
          const jobs = this.deps.supervisor.list({
            chat_id: typeof request.chat_id === "string" ? request.chat_id : undefined,
            states,
            limit: typeof request.limit === "number" ? request.limit : undefined,
          });
          this.send({ type: "jobs", id, jobs });
          return;
        }
        case "wait_for": {
          requireString(request.job_id, "job_id");
          requireString(request.pattern, "pattern");
          const timeout = Number(request.timeout_ms);
          if (!Number.isFinite(timeout) || timeout < 0) {
            throw new Error("wait_for requires a non-negative timeout_ms");
          }
          const result = await this.deps.supervisor.waitFor(
            request.job_id,
            request.pattern,
            Math.min(timeout, 300_000),
          );
          this.send({
            type: "waited",
            id,
            job_id: request.job_id,
            matched: result.matched,
            line: result.line,
            finished: result.finished,
          });
          return;
        }
        case "stats":
          this.send({
            type: "stats",
            id,
            supervisor: this.deps.supervisor.stats(
              this.deps.config.socketPath,
              this.deps.config.dbPath,
            ),
          });
          return;
        case "stop_chat": {
          requireString(request.chat_id, "chat_id");
          const count = await this.deps.supervisor.stopChat(request.chat_id);
          this.send({ type: "stopped_all", id, count });
          return;
        }
        case "delete_chat_outputs": {
          requireString(request.chat_id, "chat_id");
          const result = await this.deps.supervisor.deleteChatOutputs(request.chat_id);
          this.send({
            type: "chat_outputs_deleted",
            id,
            deleted: result.deleted,
            reason: result.reason,
          });
          return;
        }
        case "stop_all": {
          const count = await this.deps.supervisor.stopAll();
          this.send({ type: "stopped_all", id, count });
          return;
        }
        case "subscribe": {
          this.subscribed = true;
          const since = Number(request.since_seq ?? 0);
          this.lastSeq = Number.isFinite(since) ? Math.max(0, since) : 0;
          for (const event of this.deps.supervisor.eventsSince(this.lastSeq)) {
            this.sendEvent(event);
          }
          this.send({ type: "subscribed", id, since_seq: this.lastSeq });
          return;
        }
        case "ping":
          this.send({ type: "pong", id });
          return;
        default:
          throw new Error(`unknown request type: ${request.type}`);
      }
    } catch (error: any) {
      this.send({ type: "error", id, error: error?.message ?? String(error) });
    }
  }
}

function toStartInput(request: Record<string, any>): StartJobInput {
  requireString(request.job_id, "job_id");
  requireString(request.chat_id, "chat_id");
  requireString(request.command, "command");
  requireString(request.cwd, "cwd");
  if (!isJobKind(request.kind)) throw new Error("kind must be command|service");
  const env =
    request.env && typeof request.env === "object"
      ? (request.env as Record<string, string | undefined>)
      : undefined;
  return {
    job_id: request.job_id,
    chat_id: request.chat_id,
    kind: request.kind as JobKind,
    command: request.command,
    cwd: request.cwd,
    env,
    timeout_ms:
      typeof request.timeout_ms === "number" && Number.isFinite(request.timeout_ms)
        ? request.timeout_ms
        : undefined,
    origin_turn_id:
      typeof request.origin_turn_id === "string" ? request.origin_turn_id : undefined,
  };
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
}

function unlinkSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Absent or already gone.
  }
}

async function main(): Promise<void> {
  // All job files/DB/socket are private to the user.
  process.umask(0o077);
  const handle = await startJobsDaemon();
  console.log(`[jobs] listening on ${handle.config.socketPath}`);
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[jobs] ${signal}: detaching without stopping jobs`);
    await handle.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[jobs] fatal:", error);
    process.exit(1);
  });
}