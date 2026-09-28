using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class RuntimeComponentValidation
    {
        public string Id { get; private set; }
        public string DisplayName { get; private set; }
        public string TargetPath { get; private set; }
        public bool Required { get; private set; }
        public bool Ready { get; private set; }
        public string Reason { get; private set; }
        public string Version { get; private set; }

        public RuntimeComponentValidation(string id, string name, string target, bool required, bool ready, string reason, string version)
        {
            Id = id; DisplayName = name; TargetPath = target; Required = required;
            Ready = ready; Reason = reason; Version = version;
        }
    }

    internal sealed class RuntimeManifestValidation
    {
        private readonly IDictionary<string, RuntimeComponentValidation> components;

        public RuntimeManifestValidation(bool loaded, string error, IDictionary<string, RuntimeComponentValidation> components)
        {
            Loaded = loaded; Error = error; this.components = components;
        }

        public bool Loaded { get; private set; }
        public string Error { get; private set; }
        public IDictionary<string, RuntimeComponentValidation> Components { get { return components; } }

        public RuntimeComponentValidation Get(string id)
        {
            RuntimeComponentValidation component;
            if (components.TryGetValue(id, out component)) return component;
            string reason = !Loaded && !String.IsNullOrWhiteSpace(Error)
                ? Error : "运行时清单未定义组件：" + id + "。";
            return new RuntimeComponentValidation(id, id, null, true, false, reason, null);
        }

        public bool RequiredComponentsReady
        {
            get
            {
                if (!Loaded) return false;
                foreach (RuntimeComponentValidation component in components.Values)
                    if (component.Required && !component.Ready) return false;
                return true;
            }
        }
    }

    // Uses the checked-in runtime-manifest.json also consumed by bootstrap.ps1.
    // This prevents a partial CUDA/cuDNN payload or another Python ABI from being
    // displayed as a usable environment just because a few files happen to exist.
    internal static class RuntimeManifestValidator
    {
        private const int CommandTimeoutMilliseconds = 10000;
        private static readonly string[] RequiredComponentIds =
        {
            "mingit", "node", "python", "cuda", "cudnn"
        };

        public static RuntimeManifestValidation Validate(string projectRoot, string manifestPath)
        {
            Dictionary<string, RuntimeComponentValidation> results = new Dictionary<string, RuntimeComponentValidation>(StringComparer.OrdinalIgnoreCase);
            try
            {
                if (String.IsNullOrWhiteSpace(projectRoot))
                    return new RuntimeManifestValidation(false, "尚未选择项目安装目录。", results);
                if (String.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
                    return new RuntimeManifestValidation(false, "未找到 launcher/runtime-manifest.json。", results);

                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> manifest = serializer.DeserializeObject(File.ReadAllText(manifestPath, Encoding.UTF8)) as Dictionary<string, object>;
                if (manifest == null || ToInt(GetValue(manifest, "schemaVersion"), 0) < 1)
                    return new RuntimeManifestValidation(false, "运行时清单格式无效。", results);

                object[] components = ToArray(GetValue(manifest, "components"));
                if (components.Length == 0) return new RuntimeManifestValidation(false, "运行时清单未包含组件。", results);
                foreach (object raw in components)
                {
                    RuntimeComponentValidation component = ValidateComponent(projectRoot, raw as Dictionary<string, object>);
                    if (String.IsNullOrWhiteSpace(component.Id) || results.ContainsKey(component.Id))
                        return new RuntimeManifestValidation(false, "运行时清单包含缺失或重复的组件 id。", results);
                    results.Add(component.Id, component);
                }
                for (int index = 0; index < RequiredComponentIds.Length; index++)
                {
                    string requiredId = RequiredComponentIds[index];
                    RuntimeComponentValidation requiredComponent;
                    if (!results.TryGetValue(requiredId, out requiredComponent))
                        return new RuntimeManifestValidation(false, "运行时清单缺少必需组件：" + requiredId + "。", results);
                    if (!requiredComponent.Required)
                        return new RuntimeManifestValidation(false, "运行时清单把必需组件标记为可选：" + requiredId + "。", results);
                }
                return new RuntimeManifestValidation(true, null, results);
            }
            catch (Exception error)
            {
                return new RuntimeManifestValidation(false, "读取运行时清单失败：" + error.Message, results);
            }
        }

        private static RuntimeComponentValidation ValidateComponent(string projectRoot, Dictionary<string, object> component)
        {
            string id = GetString(component, "id") ?? String.Empty;
            string name = GetString(component, "displayName") ?? id;
            bool required = ToBool(GetValue(component, "required"));
            string version = GetString(component, "version");
            try
            {
                Dictionary<string, object> install = GetDictionary(component, "install");
                Dictionary<string, object> validation = GetDictionary(component, "validation");
                if (install == null || validation == null) return Fail(id, name, null, required, "组件缺少 install 或 validation 规则。", version);

                string target = ResolveChildPath(projectRoot, GetString(install, "relativePath"));
                object[] files = ToArray(GetValue(validation, "files"));
                if (files.Length == 0) return Fail(id, name, target, required, "组件没有文件校验规则。", version);
                foreach (object rawRule in files)
                {
                    Dictionary<string, object> rule = rawRule as Dictionary<string, object>;
                    if (rule == null) return Fail(id, name, target, required, "组件文件校验规则无效。", version);
                    string relativePath = GetString(rule, "path");
                    string candidate = ResolveChildPath(target, relativePath);
                    if (String.Equals(GetString(rule, "kind") ?? "file", "directory", StringComparison.OrdinalIgnoreCase))
                    {
                        if (!Directory.Exists(candidate)) return Fail(id, name, target, required, "缺少目录：" + relativePath, version);
                    }
                    else
                    {
                        if (!File.Exists(candidate)) return Fail(id, name, target, required, "缺少文件：" + relativePath, version);
                        if (new FileInfo(candidate).Length < ToLong(GetValue(rule, "minBytes"), 0))
                            return Fail(id, name, target, required, "文件过小：" + relativePath, version);
                    }
                }

                Dictionary<string, object> command = GetDictionary(validation, "command");
                if (command != null)
                {
                    string executable = ResolveChildPath(target, GetString(command, "path"));
                    if (!File.Exists(executable)) return Fail(id, name, target, required, "缺少版本校验程序。", version);
                    string output = RunValidationCommand(executable, ToArray(GetValue(command, "arguments")), target);
                    string pattern = GetString(command, "outputRegex");
                    if (String.IsNullOrWhiteSpace(pattern) || !Regex.IsMatch(output, pattern, RegexOptions.CultureInvariant))
                        return Fail(id, name, target, required, "版本校验失败（检测到 '" + output + "'）。", output);
                    version = output;
                }
                return new RuntimeComponentValidation(id, name, target, required, true, "校验通过。", version);
            }
            catch (Exception error)
            {
                return Fail(id, name, null, required, "校验规则无效：" + error.Message, version);
            }
        }

        private static RuntimeComponentValidation Fail(string id, string name, string target, bool required, string reason, string version)
        {
            return new RuntimeComponentValidation(id, name, target, required, false, reason, version);
        }

        private static string RunValidationCommand(string executable, object[] rawArguments, string workingDirectory)
        {
            StringBuilder arguments = new StringBuilder();
            for (int index = 0; index < rawArguments.Length; index++)
            {
                if (index > 0) arguments.Append(' ');
                arguments.Append(QuoteArgument(Convert.ToString(rawArguments[index], CultureInfo.InvariantCulture)));
            }
            ProcessStartInfo startInfo = new ProcessStartInfo(executable, arguments.ToString());
            startInfo.WorkingDirectory = workingDirectory;
            startInfo.UseShellExecute = false; startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true; startInfo.RedirectStandardError = true;
            startInfo.StandardOutputEncoding = Encoding.UTF8; startInfo.StandardErrorEncoding = Encoding.UTF8;
            using (Process process = Process.Start(startInfo))
            {
                Task<string> stdout = Task.Factory.StartNew(delegate { return process.StandardOutput.ReadToEnd(); });
                Task<string> stderr = Task.Factory.StartNew(delegate { return process.StandardError.ReadToEnd(); });
                if (!process.WaitForExit(CommandTimeoutMilliseconds))
                {
                    try { process.Kill(); } catch { }
                    throw new TimeoutException("版本校验命令超时。");
                }
                Task.WaitAll(new Task[] { stdout, stderr });
                string output = String.IsNullOrWhiteSpace(stdout.Result) ? stderr.Result : stdout.Result;
                output = String.IsNullOrWhiteSpace(output) ? String.Empty : output.Trim();
                if (process.ExitCode != 0) throw new InvalidOperationException("版本校验命令退出码为 " + process.ExitCode + "：" + output);
                return output;
            }
        }

        private static string QuoteArgument(string value)
        {
            value = value ?? String.Empty;
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
            StringBuilder result = new StringBuilder("\"");
            int slashCount = 0;
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (character == '\\') slashCount++;
                else if (character == '"') { result.Append('\\', slashCount * 2 + 1); result.Append(character); slashCount = 0; }
                else { result.Append('\\', slashCount); result.Append(character); slashCount = 0; }
            }
            result.Append('\\', slashCount * 2); result.Append('"');
            return result.ToString();
        }

        private static string ResolveChildPath(string root, string relativePath)
        {
            if (String.IsNullOrWhiteSpace(root) || String.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath) || relativePath.IndexOf(':') >= 0)
                throw new InvalidDataException("运行时清单路径无效。");
            string normalized = relativePath.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
            foreach (string part in normalized.Split(Path.DirectorySeparatorChar))
                if (String.IsNullOrWhiteSpace(part) || part == "." || part == "..") throw new InvalidDataException("运行时清单路径越界。");
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullPath = Path.GetFullPath(Path.Combine(fullRoot, normalized));
            if (!fullPath.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("运行时清单路径越界。");
            return fullPath;
        }

        private static object GetValue(Dictionary<string, object> values, string key) { return values == null || !values.ContainsKey(key) ? null : values[key]; }
        private static Dictionary<string, object> GetDictionary(Dictionary<string, object> values, string key) { return GetValue(values, key) as Dictionary<string, object>; }
        private static string GetString(Dictionary<string, object> values, string key) { object value = GetValue(values, key); return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture); }
        private static object[] ToArray(object value) { object[] array = value as object[]; if (array != null) return array; ArrayList list = value as ArrayList; return list == null ? new object[0] : list.ToArray(); }
        private static int ToInt(object value, int fallback) { try { return value == null ? fallback : Convert.ToInt32(value, CultureInfo.InvariantCulture); } catch { return fallback; } }
        private static long ToLong(object value, long fallback) { try { return value == null ? fallback : Convert.ToInt64(value, CultureInfo.InvariantCulture); } catch { return fallback; } }
        private static bool ToBool(object value) { try { return value != null && Convert.ToBoolean(value, CultureInfo.InvariantCulture); } catch { return false; } }
    }
}
