/** What every adapter knows of a process: whether an id could be one, and whether it is running. */

/** A process id we would be willing to signal: a positive whole number. */
export function validPid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Whether a process exists. A process owned by someone else still exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
