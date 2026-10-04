import { spawn } from "node:child_process";

// The key travels over stdin/stdout only. It is never part of a command line,
// environment variable, shell interpolation or diagnostic message.
function dpapi(action, value) {
  const method = action === "seal" ? "Protect" : "Unprotect";
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
$bytes = ${action === "seal" ? "[Text.Encoding]::UTF8.GetBytes($value)" : "[Convert]::FromBase64String($value)"}
$result = [Security.Cryptography.ProtectedData]::${method}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write(${action === "seal" ? "[Convert]::ToBase64String($result)" : "[Text.Encoding]::UTF8.GetString($result)"})
`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error("本机密钥加密服务不可用，请重新填写 API Key"));
      else resolve(Buffer.concat(output).toString("utf8"));
    };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 15_000);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 32_768) { child.kill(); finish(true); }
      else output.push(chunk);
    });
    child.stdin.on("error", () => finish(true));
    child.once("error", () => finish(true));
    child.once("close", (code) => finish(code !== 0));
    child.stdin.end(value, "utf8");
  });
}

export function localImageCredentialCodec(platform = process.platform) {
  if (platform !== "win32") {
    return { persistence: "session-only", seal: async () => null, unseal: async () => "" };
  }
  return {
    persistence: "windows-dpapi",
    async seal(value) {
      return { scheme: "dpapi-current-user", ciphertext: await dpapi("seal", value) };
    },
    async unseal(envelope) {
      if (envelope?.scheme !== "dpapi-current-user" || typeof envelope.ciphertext !== "string"
        || envelope.ciphertext.length > 32_768) throw new Error("本机密钥格式无效");
      return dpapi("unseal", envelope.ciphertext);
    },
  };
}
