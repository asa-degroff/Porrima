/**
 * Manual CLI for the job supervisor (L2a smoke path).
 *
 *   npx tsx src/scripts/jobs-cli.ts stats
 *   npx tsx src/scripts/jobs-cli.ts start --chat demo --command "echo hello"
 *   npx tsx src/scripts/jobs-cli.ts list --chat demo
 *   npx tsx src/scripts/jobs-cli.ts tail <job-id>
 *   npx tsx src/scripts/jobs-cli.ts stop <job-id>
 *   npx tsx src/scripts/jobs-cli.ts stop-all
 *
 * The daemon must be running (npx tsx src/jobs-daemon.ts, or the systemd unit).
 */
import { open } from "node:fs/promises";
import { JobsClient } from "../services/jobs-client.js";
import type { JobRecord } from "../services/job-protocol.js";

interface CliOptions {
  socket?: string;
  chat?: string;
  command?: string;
  cwd?: string;
  timeoutSec?: number;
  service?: boolean;
  force?: boolean;
  json?: boolean;
  pattern?: string;
  bytes?: number;
  stderr?: boolean;
}

function parseArgs(argv: string[]): { positional: string[]; options: CliOptions } {
  const positional: string[] = [];
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--socket":
        options.socket = next();
        break;
      case "--chat":
        options.chat = next();
        break;
      case "--command":
        options.command = next();
        break;
      case "--cwd":
        options.cwd = next();
        break;
      case "--timeout": {
        const value = Number(next());
        options.timeoutSec = Number.isFinite(value) && value > 0 ? value : undefined;
        break;
      }
      case "--service":
        options.service = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--pattern":
        options.pattern = next();
        break;
      case "--bytes": {
        const value = Number(next());
        options.bytes = Number.isFinite(value) && value > 0 ? value : undefined;
        break;
      }
      case "--stderr":
        options.stderr = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  return { positional, options };
}

function printHelp(): void {
  console.log(`Usage: jobs-cli <command> [options]

Commands:
  stats                       Supervisor uptime, counts, caps
  list [--chat <id>]          List recent jobs
  get <job-id>                Show one job
  start --chat <id> --command <cmd> [--cwd <dir>] [--timeout <sec>] [--service]
  stop <job-id> [--force]     Stop a job
  stop-chat <chat-id>         Stop every job in a chat
  stop-all                    Stop every job
  tail <job-id> [--bytes N] [--stderr]
  wait <job-id> --pattern P [--timeout <sec>]

Options:
  --socket <path>             Override the supervisor socket
  --json                      Machine-readable output`);
}

function printValue(value: unknown, json: boolean): void {
  if (json || typeof value !== "string") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(value);
}

function printJobs(jobs: JobRecord[]): void {
  if (jobs.length === 0) {
    console.log("no jobs");
    return;
  }
  for (const job of jobs) {
    const duration = job.duration_ms != null ? `${(job.duration_ms / 1000).toFixed(1)}s` : "-";
    console.log(
      `${job.id}  ${job.state.padEnd(8)}  ${job.kind.padEnd(7)}  ${job.chat_id}  ` +
        `${job.started_at ?? "-"}  ${duration}  ${job.command}`,
    );
  }
}

async function readTail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(Math.max(1, bytes), stat.size);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command) {
    printHelp();
    process.exit(2);
  }

  const client = new JobsClient({ socketPath: options.socket });
  try {
    switch (command) {
      case "stats": {
        printValue(await client.stats(), Boolean(options.json));
        return;
      }
      case "list": {
        const jobs = await client.listJobs({ chat_id: options.chat });
        if (options.json) printValue(jobs, true);
        else printJobs(jobs);
        return;
      }
      case "get": {
        const id = positional[1];
        if (!id) throw new Error("get requires a job id");
        const job = await client.getJob(id);
        if (!job) throw new Error(`job ${id} not found`);
        printValue(job, Boolean(options.json));
        return;
      }
      case "start": {
        if (!options.chat) throw new Error("start requires --chat");
        if (!options.command) throw new Error("start requires --command");
        const job = await client.startJob({
          chat_id: options.chat,
          kind: options.service ? "service" : "command",
          command: options.command,
          cwd: options.cwd ?? process.cwd(),
          env: process.env,
          timeout_ms: options.timeoutSec ? options.timeoutSec * 1000 : undefined,
        });
        printValue(job, Boolean(options.json));
        return;
      }
      case "stop": {
        const id = positional[1];
        if (!id) throw new Error("stop requires a job id");
        const job = await client.stopJob(id, Boolean(options.force));
        printValue(job, Boolean(options.json));
        return;
      }
      case "stop-chat": {
        const chat = positional[1] ?? options.chat;
        if (!chat) throw new Error("stop-chat requires a chat id");
        const count = await client.stopChat(chat);
        printValue({ stopped: count }, Boolean(options.json));
        return;
      }
      case "stop-all": {
        const count = await client.stopAll();
        printValue({ stopped: count }, Boolean(options.json));
        return;
      }
      case "tail": {
        const id = positional[1];
        if (!id) throw new Error("tail requires a job id");
        const job = await client.getJob(id);
        if (!job) throw new Error(`job ${id} not found`);
        const path = options.stderr ? job.stderr_path : job.stdout_path;
        const text = await readTail(path, options.bytes ?? 16 * 1024);
        if (options.json) {
          printValue({ job, path, text }, true);
        } else {
          process.stdout.write(text);
          if (text && !text.endsWith("\n")) process.stdout.write("\n");
        }
        return;
      }
      case "wait": {
        const id = positional[1];
        if (!id) throw new Error("wait requires a job id");
        if (!options.pattern) throw new Error("wait requires --pattern");
        const result = await client.waitFor(
          id,
          options.pattern,
          (options.timeoutSec ?? 30) * 1000,
        );
        printValue(result, Boolean(options.json));
        if (!result.matched) process.exitCode = 1;
        return;
      }
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("[jobs-cli]", error instanceof Error ? error.message : error);
  process.exit(1);
});