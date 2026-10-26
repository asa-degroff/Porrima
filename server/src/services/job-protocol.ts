/**
 * Job supervisor wire protocol (docs/design/job-supervisor.md §5).
 *
 * Newline-delimited JSON over a Unix socket. Frames are small: output never
 * crosses the socket; job output lives in files and the client reads them.
 */

import { StringDecoder } from "node:string_decoder";

export const JOB_PROTOCOL_VERSION = 1;
export const MAX_JOB_FRAME_BYTES = 1024 * 1024;

export type JobKind = "command" | "service";

export type JobState = "starting" | "running" | "finished" | "stopped" | "lost" | "failed";

export type JobStopReason =
  | "user"
  | "user-force"
  | "timeout"
  | "shutdown"
  | "system-stop"
  | "log-cap"
  | "chat-deleted"
  | "workspace-change"
  | "daemonized"
  | "memory-cap"
  | "spawn-failed";

export type JobEventType =
  | "job_started"
  | "job_finished"
  | "job_stopped"
  | "job_lost";

export interface JobRecord {
  id: string;
  chat_id: string;
  kind: JobKind;
  command: string;
  cwd: string;
  state: JobState;
  pid: number | null;
  pgid: number | null;
  start_id: string | null;
  boot_id: string | null;
  exit_code: number | null;
  signal: string | null;
  stop_reason: JobStopReason | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  stdout_path: string;
  stderr_path: string;
  status_path: string;
  /** True when the output cap discarded bytes. Independent of `stop_reason`. */
  output_capped?: boolean;
  origin_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEvent {
  seq: number;
  event: JobEventType;
  job_id: string;
  at: string;
  job: JobRecord;
}

export interface HelloRequest {
  type: "hello";
  id?: string;
  client?: string;
}

export interface WelcomeReply {
  type: "welcome";
  id?: string;
  protocol: number;
  pid: number;
  start_id: string | null;
  boot_id: string;
  started_at: string;
  version: string;
  capabilities: string[];
  /** Set when the daemon is holding instead of serving: what went wrong. */
  degraded?: string | null;
}

export interface StartRequest {
  type: "start";
  id?: string;
  job_id: string;
  chat_id: string;
  kind: JobKind;
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timeout_ms?: number;
  origin_turn_id?: string;
}

export interface StartedReply {
  type: "started";
  id?: string;
  job: JobRecord;
}

export interface StopRequest {
  type: "stop";
  id?: string;
  job_id: string;
  force?: boolean;
}

export interface StoppedReply {
  type: "stopped";
  id?: string;
  job: JobRecord;
}

export interface GetRequest {
  type: "get";
  id?: string;
  job_id: string;
}

export interface JobGetReply {
  type: "job";
  id?: string;
  job: JobRecord | null;
}

export interface ListRequest {
  type: "list";
  id?: string;
  chat_id?: string;
  states?: JobState[];
  limit?: number;
}

export interface JobsReply {
  type: "jobs";
  id?: string;
  jobs: JobRecord[];
}

export interface WaitForRequest {
  type: "wait_for";
  id?: string;
  job_id: string;
  pattern: string;
  timeout_ms: number;
}

export interface WaitedReply {
  type: "waited";
  id?: string;
  job_id: string;
  matched: boolean;
  line: string | null;
  finished: boolean;
}

export interface StatsRequest {
  type: "stats";
  id?: string;
}

export interface SupervisorStats {
  protocol: number;
  pid: number;
  start_id: string | null;
  boot_id: string;
  started_at: string;
  uptime_ms: number;
  socket_path: string;
  jobs_dir: string;
  db_path: string;
  jobs: Record<JobState, number>;
  db_bytes: number;
  max_output_bytes: number;
  caps: {
    per_chat: number;
    box: number;
    services_per_chat: number;
    services_box: number;
  };
}

export interface StatsReply {
  type: "stats";
  id?: string;
  supervisor: SupervisorStats;
}

export interface StopChatRequest {
  type: "stop_chat";
  id?: string;
  chat_id: string;
}

export interface DeleteChatOutputsRequest {
  type: "delete_chat_outputs";
  id?: string;
  chat_id: string;
}

export interface ChatOutputsDeletedReply {
  type: "chat_outputs_deleted";
  id?: string;
  deleted: boolean;
  reason?: string;
}

export interface StopAllRequest {
  type: "stop_all";
  id?: string;
}

export interface StoppedAllReply {
  type: "stopped_all";
  id?: string;
  count: number;
}

export interface SubscribeRequest {
  type: "subscribe";
  id?: string;
  since_seq?: number;
}

export interface SubscribedReply {
  type: "subscribed";
  id?: string;
  since_seq: number;
}

export interface PingRequest {
  type: "ping";
  id?: string;
}

export interface PongReply {
  type: "pong";
  id?: string;
}

export interface EventFrame {
  type: "event";
  seq: number;
  event: JobEventType;
  job_id: string;
  at: string;
  job: JobRecord;
}

export interface ErrorReply {
  type: "error";
  id?: string;
  error: string;
}

export type JobRequest =
  | HelloRequest
  | StartRequest
  | StopRequest
  | GetRequest
  | ListRequest
  | WaitForRequest
  | StatsRequest
  | StopChatRequest
  | DeleteChatOutputsRequest
  | StopAllRequest
  | SubscribeRequest
  | PingRequest;

export type JobReply =
  | WelcomeReply
  | StartedReply
  | StoppedReply
  | JobGetReply
  | JobsReply
  | WaitedReply
  | StatsReply
  | StoppedAllReply
  | ChatOutputsDeletedReply
  | SubscribedReply
  | PongReply
  | EventFrame
  | ErrorReply;

export function encodeJobFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Incremental newline decoder with a hard frame cap. Throws on an oversized
 * frame so the caller can close the connection instead of buffering forever.
 */
export class JobLineDecoder {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly maxBytes = MAX_JOB_FRAME_BYTES) {}

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > this.maxBytes && !this.buffer.includes("\n")) {
      throw new Error(`job protocol frame exceeds ${this.maxBytes} bytes`);
    }
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) lines.push(line);
    }
    if (this.buffer.length > this.maxBytes) {
      throw new Error(`job protocol frame exceeds ${this.maxBytes} bytes`);
    }
    return lines;
  }
}

export function isJobState(value: unknown): value is JobState {
  return (
    value === "starting" ||
    value === "running" ||
    value === "finished" ||
    value === "stopped" ||
    value === "lost" ||
    value === "failed"
  );
}

export function isJobKind(value: unknown): value is JobKind {
  return value === "command" || value === "service";
}