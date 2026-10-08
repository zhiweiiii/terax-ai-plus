import { IS_WINDOWS } from "./platform";

export type ShellKind = "powershell" | "posix" | "fish" | "cmd" | "unknown";

export function quoteForShell(value: string, shell: ShellKind): string {
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new Error(
      "Paths containing control characters cannot be sent to a shell",
    );
  switch (shell) {
    case "powershell":
      return `'${value.replace(/['\u2018\u2019]/g, "$&$&")}'`;
    case "posix":
      return `'${value.replace(/'/g, "'\\''")}'`;
    case "fish":
      return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "cmd":
      if (/["%!]/.test(value))
        throw new Error(
          "Command Prompt cannot safely quote this path; use PowerShell",
        );
      return `"${value}"`;
    default:
      throw new Error(
        "Shell type is unavailable; wait for the terminal to start",
      );
  }
}

export function quoteShellArg(value: string, windows = IS_WINDOWS): string {
  return quoteForShell(value, windows ? "powershell" : "posix");
}
