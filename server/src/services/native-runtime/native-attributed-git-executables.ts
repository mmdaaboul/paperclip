import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";

/** Match the actual host Git implementation, not Apple's SDK dispatch shim.
 * No package install, shell evaluation, agent PATH or agent-selected executable.
 */
export async function resolveNativeAttributedGitBinary(privateWorkingDirectory: string): Promise<string> {
  let selected: string;
  if (process.platform === "darwin") {
    selected = await new Promise<string>((resolve, reject) => execFile("/usr/bin/xcrun", ["--find", "git"], {
      cwd: privateWorkingDirectory, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000, maxBuffer: 4096,
    }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  } else if (process.platform === "linux") selected = "/usr/bin/git";
  else throw new Error("native_git_host_unqualified");
  if (!isAbsolute(selected) || /[\x00-\x1f\x7f]/.test(selected)) throw new Error("native_git_executable_unavailable");
  const executable = await realpath(selected);
  if (!(await stat(executable)).isFile()) throw new Error("native_git_executable_unavailable");
  await access(executable, constants.X_OK);
  return executable;
}
