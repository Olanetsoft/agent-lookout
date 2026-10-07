// Paths as the tests write them, on every system.
//
// The tests name the folders of a pretend computer as macOS and Linux write
// them, such as `/Users/example/.codex`. On Windows the code under test joins
// and resolves those with Windows' rules, so the same folder reaches a stand-in
// as `D:\Users\example\.codex`. The stand-ins that hold files in memory key
// them by the path as the tests write it, so both sides meet.

/**
 * A path as the tests write it: on Windows with no drive letter and with `/`
 * between its names, and anywhere else as it is.
 */
export function asWritten(target: string): string {
  if (process.platform !== "win32") return target;
  return target.replace(/^[A-Za-z]:(?=[\\/])/, "").replaceAll("\\", "/");
}
