import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  JOB_PROTOCOL_MIN_SUPPORTED,
  JOB_PROTOCOL_VERSION,
  MAX_JOB_FRAME_BYTES,
  JobLineDecoder,
  encodeJobFrame,
  negotiateProtocol,
  type EventFrame,
  type JobEvent,
  type JobRecord,
  type JobState,
  type SupervisorStats,
  type WaitForRequest,
  type WelcomeReply,
} from "./job-protocol.js";
import { jobsConfigFromEnv } from "./job-paths.js";

/**
 * Server-side client for the job supervisor (docs/design/job-supervisor.md §5).
 * Lazy connect; a failed handshake or a closed socket rejects pending requests
 * and the next call reconnects. The server integration decides the retry policy.
 */

export interface JobsClientOptions {
  socketPath?: string;
  requestTimeoutMs?: number;
  /**
   * The protocol range this side can speak. Defaults to the built version; a
   * test can stand in for a build one protocol ahead to exercise a skew that
   * a real deploy reaches by keeping the daemon running.
   */
  protocolMax?: number;
  protocolMin?: number;
}

export interface StartJobClientInput {
  job_id?: string;
  chat_id: string;
  kind: "command" | "service";
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timeout_ms?: number;
  origin_turn_id?: string;
}

export interface ClientWaitForResult {
  matched: boolean;
  line: string | null;
  finished: boolean;
}

export interface ClientChatOutputDeletionResult {
  deleted: boolean;
  reason?: string;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class JobsClient {
  private readonly socketPath: string;
  private readonly defaultTimeoutMs: number;
  private socket: Socket | null = null;
  private readonly protocolMax: number;
  private readonly protocolMin: number;
  private decoder = new JobLineDecoder(MAX_JOB_FRAME_BYTES);
  private pending = new Map<string, Pending>();
  private eventHandlers = new Set<(event: JobEvent) => void>();
  private connectPromise: Promise<void> | null = null;
  private peerDegradation: string | null = null;
  private negotiatedProtocol: number | null = null;
  private peerCapabilities = new Set<string>();
  private helloId: string | null = null;
  private helloResolve: (() => void) | null = null;
  private helloReject: ((error: Error) => void) | null = null;

  constructor(options: JobsClientOptions = {}) {
    this.socketPath = options.socketPath ?? jobsConfigFromEnv().socketPath;
    this.defaultTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.protocolMax = options.protocolMax ?? JOB_PROTOCOL_VERSION;
    this.protocolMin =
      options.protocolMin ?? Math.min(JOB_PROTOCOL_MIN_SUPPORTED, this.protocolMax);
  }

  get connected(): boolean {
    return this.socket != null && !this.socket.destroyed;
  }

  /** Why the daemon is holding instead of serving, as the daemon reported it. */
  get degradedReason(): string | null {
    return this.peerDegradation;
  }

  /** The protocol the handshake settled on, if a handshake has happened. */
  get supervisorProtocol(): number | null {
    return this.negotiatedProtocol;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = connect(this.socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`job supervisor handshake timed out (${this.socketPath})`));
      }, this.defaultTimeoutMs);
      timeout.unref?.();

      const fail = (error: Error) => {
        clearTimeout(timeout);
        this.connectPromise = null;
        reject(error);
      };

      socket.once("connect", () => {
        const helloId = `hello-${randomUUID()}`;
        this.helloId = helloId;
        this.helloResolve = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.helloReject = fail;
        socket.write(
          encodeJobFrame({
            type: "hello",
            id: helloId,
            client: "porrima-server",
            protocol: this.protocolMax,
            protocol_min: this.protocolMin,
          }),
        );
      });
      socket.once("error", fail);
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("close", () => this.onClose());
      this.socket = socket;
      this.decoder = new JobLineDecoder(MAX_JOB_FRAME_BYTES);
    });
    return this.connectPromise;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.rejectPending(new Error("job supervisor client closed"));
    socket?.destroy();
  }

  async startJob(input: StartJobClientInput): Promise<JobRecord> {
    const jobId = input.job_id ?? randomUUID();
    const reply = await this.request(
      {
        type: "start",
        job_id: jobId,
        chat_id: input.chat_id,
        kind: input.kind,
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        timeout_ms: input.timeout_ms,
        origin_turn_id: input.origin_turn_id,
      },
      10_000,
    );
    return reply.job as JobRecord;
  }

  async stopJob(jobId: string, force = false): Promise<JobRecord> {
    const reply = await this.request({ type: "stop", job_id: jobId, force });
    return reply.job as JobRecord;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const reply = await this.request({ type: "get", job_id: jobId });
    return (reply.job as JobRecord | null) ?? null;
  }

  async listJobs(
    filter: { chat_id?: string; states?: JobState[]; limit?: number } = {},
  ): Promise<JobRecord[]> {
    const reply = await this.request({ type: "list", ...filter });
    return reply.jobs as JobRecord[];
  }

  async waitFor(
    jobId: string,
    pattern: string,
    timeoutMs: number,
  ): Promise<ClientWaitForResult> {
    const request: WaitForRequest = {
      type: "wait_for",
      job_id: jobId,
      pattern,
      timeout_ms: timeoutMs,
    };
    const reply = await this.request(request, timeoutMs + 2000);
    return {
      matched: Boolean(reply.matched),
      line: typeof reply.line === "string" ? reply.line : null,
      finished: Boolean(reply.finished),
    };
  }

  async stats(): Promise<SupervisorStats> {
    const reply = await this.request({ type: "stats" });
    return reply.supervisor as SupervisorStats;
  }

  async stopChat(chatId: string): Promise<number> {
    const reply = await this.request({ type: "stop_chat", chat_id: chatId });
    return Number(reply.count ?? 0);
  }

  async stopAll(): Promise<number> {
    const reply = await this.request({ type: "stop_all" });
    return Number(reply.count ?? 0);
  }

  async deleteChatOutputs(chatId: string): Promise<ClientChatOutputDeletionResult> {
    const reply = await this.request({ type: "delete_chat_outputs", chat_id: chatId });
    return {
      deleted: reply.deleted === true,
      reason: typeof reply.reason === "string" ? reply.reason : undefined,
    };
  }

  async subscribe(
    handler: (event: JobEvent) => void,
    sinceSeq = 0,
  ): Promise<() => void> {
    this.eventHandlers.add(handler);
    await this.request({ type: "subscribe", since_seq: sinceSeq });
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private request(payload: Record<string, any>, timeoutMs = this.defaultTimeoutMs): Promise<Record<string, any>> {
    return this.connect().then(() => {
      if (this.peerDegradation) {
        throw new Error(`job supervisor is degraded: ${this.peerDegradation}`);
      }
      const capability = typeof payload.type === "string" ? payload.type : "";
      if (capability && this.peerCapabilities.size > 0 && !this.peerCapabilities.has(capability)) {
        // Refused by name, one request at a time: the rest of the connection
        // still answers, so the stale view keeps refreshing.
        throw new Error(
          `job supervisor at protocol ${this.negotiatedProtocol ?? "?"} does not advertise "${capability}"`,
        );
      }
      return new Promise<Record<string, any>>((resolve, reject) => {
        const socket = this.socket;
        if (!socket || socket.destroyed) {
          reject(new Error("job supervisor is not connected"));
          return;
        }
        const id = typeof payload.id === "string" ? payload.id : randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`job supervisor request timed out: ${String(payload.type)}`));
        }, timeoutMs);
        timer.unref?.();
        this.pending.set(id, { resolve, reject, timer });
        socket.write(encodeJobFrame({ ...payload, id }));
      });
    });
  }

  private onData(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (error: any) {
      this.rejectPending(new Error(error?.message ?? String(error)));
      this.socket?.destroy();
      return;
    }
    for (const line of lines) {
      let frame: Record<string, any>;
      try {
        frame = JSON.parse(line) as Record<string, any>;
      } catch {
        continue;
      }
      if (frame.type === "welcome") {
        const welcome = frame as unknown as WelcomeReply;
        if (welcome.id !== this.helloId) continue;
        const daemonMax = Number(welcome.protocol);
        const daemonMin = Number(welcome.protocol_min ?? welcome.protocol);
        const negotiated = negotiateProtocol(
          this.protocolMin,
          this.protocolMax,
          daemonMin,
          daemonMax,
        );
        if (negotiated == null) {
          this.helloReject?.(
            new Error(
              `job supervisor speaks protocol ${daemonMin}-${daemonMax}; this server speaks ` +
                `${this.protocolMin}-${this.protocolMax}. Restart porrima-jobs to match the deployed server.`,
            ),
          );
          this.socket?.destroy();
          continue;
        }
        this.negotiatedProtocol = negotiated;
        this.peerCapabilities = new Set(
          Array.isArray(welcome.capabilities) ? welcome.capabilities : [],
        );
        if (negotiated < this.protocolMax) {
          console.warn(
            `[jobs] speaking protocol ${negotiated} to a supervisor at ${daemonMin}-${daemonMax}; ` +
              `requests it does not advertise are refused`,
          );
        }
        this.peerDegradation =
          typeof welcome.degraded === "string" && welcome.degraded ? welcome.degraded : null;
        this.helloResolve?.();
        this.helloResolve = null;
        this.helloReject = null;
        continue;
      }
      if (frame.type === "event") {
        const event = frame as unknown as EventFrame;
        for (const handler of this.eventHandlers) {
          try {
            handler(event);
          } catch {
            // A subscriber must never break the client loop.
          }
        }
        continue;
      }
      if (frame.type === "error" && frame.id === this.helloId) {
        this.helloReject?.(
          new Error(String(frame.error ?? "job supervisor rejected the handshake")),
        );
        this.socket?.destroy();
        continue;
      }
      const id = typeof frame.id === "string" ? frame.id : null;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.type === "error") {
        pending.reject(new Error(String(frame.error ?? "job supervisor error")));
      } else {
        pending.resolve(frame);
      }
    }
  }

  private onClose(): void {
    this.socket = null;
    this.connectPromise = null;
    this.peerDegradation = null;
    this.negotiatedProtocol = null;
    this.peerCapabilities = new Set<string>();
    const rejectHello = this.helloReject;
    this.helloResolve = null;
    this.helloReject = null;
    rejectHello?.(new Error("job supervisor connection closed before handshake"));
    this.rejectPending(new Error("job supervisor connection closed"));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}