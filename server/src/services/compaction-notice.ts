/**
 * Kernel-state notice appended to every compaction summary.
 *
 * Summary composition is index, notice, then recap (see compaction.ts).
 * The constant lives in this leaf module so the producer (compaction.ts)
 * and the topic-anchor parser (memory-context.ts) can both import it
 * without creating a module cycle.
 */
export const KERNEL_STATE_COMPACT_NOTICE =
  "\n\nKernel note: if this thread used run_python, the kernel namespace survives compaction — variables, imports, and background jobs (checkable via python_jobs) are still live.";
