use super::{
    events::{arr, s, timestamp},
    process::{self, Program},
    storage::{self, Storage},
    CoreResult,
};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};
pub const IDS: [&str; 5] = ["claude", "codex", "antigravity", "kimi", "gemini"];
pub const ENABLED: [&str; 4] = ["claude", "codex", "antigravity", "kimi"];
pub fn require_enabled(id: &str) -> Result<(), String> {
    if ENABLED.contains(&id) {
        Ok(())
    } else if id == "gemini" {
        Err("Gemini is disabled. Select Claude, Codex, Antigravity or Kimi.".into())
    } else {
        Err("Unknown provider".into())
    }
}
pub fn label(id: &str) -> &str {
    match id {
        "claude" => "Claude",
        "codex" => "Codex",
        "antigravity" => "Antigravity",
        "kimi" => "Kimi",
        "gemini" => "Gemini",
        _ => id,
    }
}
pub fn caps(id: &str) -> Value {
    if id=="kimi" {return json!({"steer":true,"interrupt":true,"images":true,"fork":true,"rollback":"turns","rewindFiles":false,"subagents":true,"backgroundTasks":true,"contextUsage":true,"slashCommands":true,"segments":false,"chrome":false,"deskTools":true,"mcpManagement":true,"interactiveApprovals":true,"modes":["default","auto","plan","bypassPermissions"]})}
    let claude = id == "claude";
    let codex = id == "codex";
    let google = !claude && !codex;
    json!({"steer":!google,"interrupt":true,"images":!google,"fork":!google,"rollback":if claude{"anchor"}else{"turns"},"rewindFiles":claude,"subagents":true,"backgroundTasks":claude,"contextUsage":!google,"slashCommands":!google,"segments":claude,"chrome":claude,"deskTools":!google,"mcpManagement":!google,"interactiveApprovals":!google,"modes":["default","acceptEdits","auto","plan","bypassPermissions"]})
}
pub fn brand(id: &str) -> Value {
    let (color, mark) = match id {
        "claude" => ("#D97757", "C"),
        "codex" => ("#10A37F", "X"),
        "antigravity" => ("#4285f4", "A"),
        "kimi" => ("#ffffff", "K"),
        _ => ("#8e75ff", "G"),
    };
    json!({"color":color,"mark":mark})
}
pub fn node_roots(st: &Storage) -> Vec<PathBuf> {
    let mut r = vec![st.runtime.join("node_modules")];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        r.push(PathBuf::from(appdata).join("npm/node_modules"))
    }
    if let Some(node) = process::which("node") {
        if let Some(parent) = node.parent() {
            r.push(parent.join("node_modules"));
            r.push(parent.join("../lib/node_modules"));
        }
    }
    r.push(st.home.join(".local/lib/node_modules"));
    r.push(PathBuf::from("/usr/local/lib/node_modules"));
    r.push(PathBuf::from("/usr/lib/node_modules"));
    r
}
pub fn find(st: &Storage, id: &str) -> Result<Program, String> {
    let env = match id {
        "claude" => "DUET_CLAUDE_BIN",
        "codex" => "DUET_CODEX_BIN",
        "kimi" => "DUET_KIMI_BIN",
        "antigravity" => "DUET_ANTIGRAVITY_BIN",
        "gemini" => "DUET_GEMINI_BIN",
        _ => return Err(format!("Unknown provider {id}")),
    };
    if let Some(p) = std::env::var_os(env) {
        let p = PathBuf::from(p);
        if !p.is_file() {
            return Err(format!("{env} is not a file"));
        }
        return from_path(p);
    }
    let os = if cfg!(windows) { "win32" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let exe = |name: &str| {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        }
    };
    let mut candidates = vec![];
    match id {
        "claude" => {
            candidates.push(st.runtime.join("bin").join(exe("claude")));
            for root in node_roots(st) {
                for suffix in [format!("{os}-{arch}"), format!("{os}-{arch}-musl")] {
                    candidates.push(
                        root.join(format!("@anthropic-ai/claude-agent-sdk-{suffix}"))
                            .join(exe("claude")),
                    );
                }
            }
        }
        "codex" => {
            candidates.push(st.runtime.join("bin").join(exe("codex")));
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                if let Ok(rd) = fs::read_dir(PathBuf::from(local).join("OpenAI/Codex/bin")) {
                    for e in rd.flatten() {
                        candidates.push(e.path().join("codex.exe"));
                    }
                }
            }
            let triple = format!(
                "{}-{}",
                if arch == "arm64" { "aarch64" } else { "x86_64" },
                if cfg!(windows) {
                    "pc-windows-msvc"
                } else {
                    "unknown-linux-musl"
                }
            );
            for root in node_roots(st) {
                for vendor in [
                    root.join(format!("@openai/codex-{os}-{arch}/vendor")),
                    root.join(format!(
                        "@openai/codex/node_modules/@openai/codex-{os}-{arch}/vendor"
                    )),
                    root.join("@openai/codex/vendor"),
                ] {
                    for dir in ["bin", "codex"] {
                        candidates.push(vendor.join(&triple).join(dir).join(exe("codex")));
                    }
                }
            }
        }
        "antigravity" => {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                candidates.push(PathBuf::from(local).join("agy/bin/agy.exe"))
            }
            candidates.push(st.home.join(".local/bin/agy"));
        }
        "kimi" => {candidates.push(st.runtime.join("bin").join(exe("kimi")));candidates.push(super::kimi::home(st).join("bin").join(exe("kimi")));candidates.push(st.home.join(".local/bin").join(exe("kimi")));},
        "gemini" => {
            for root in node_roots(st) {
                candidates.push(root.join("@google/gemini-cli/bundle/gemini.js"));
            }
        }
        _ => {}
    }
    let name = if id == "antigravity" { "agy" } else { id };
    if let Some(p) = process::which(name) {
        candidates.push(p)
    }
    candidates.retain(|p| p.is_file());
    if id == "codex" {
        let re = regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").unwrap();
        let mut scored = vec![];
        for p in candidates {
            if let Ok(program) = from_path(p) {
                if let Ok(v) = process::run(
                    &program,
                    &["--version".into()],
                    None,
                    None,
                    Duration::from_secs(10),
                    65536,
                )
                .and_then(|v| v.text())
                {
                    let version = re
                        .captures(&v)
                        .map(|c| {
                            (
                                c[1].parse::<u32>().unwrap_or(0),
                                c[2].parse::<u32>().unwrap_or(0),
                                c[3].parse::<u32>().unwrap_or(0),
                            )
                        })
                        .unwrap_or_default();
                    scored.push((version, program))
                }
            }
        }
        scored.sort_by_key(|(v, _)| *v);
        return scored
            .pop()
            .map(|(_, p)| p)
            .ok_or("Codex CLI not found".into());
    }
    for p in candidates {
        if let Ok(v) = from_path(p) {
            return Ok(v);
        }
    }
    Err(format!(
        "{} CLI not found. Install it and sign in with your subscription.",
        label(id)
    ))
}
fn from_path(p: PathBuf) -> Result<Program, String> {
    if p.extension()
        .is_some_and(|e| e == "js" || e == "mjs" || e == "cjs")
    {
        let mut program = Program::new(
            process::which("node").ok_or("Node is required by the installed provider CLI")?,
        );
        program.prefix.push(p.to_string_lossy().into());
        Ok(program)
    } else {
        process::resolve(&p.to_string_lossy())
            .ok_or_else(|| format!("Cannot launch {}", p.display()))
    }
}
pub fn subscription(st: &Storage, id: &str, mut program: Program) -> Result<Program, String> {
    let read = |p: PathBuf| -> Result<Value, String> {
        if !p.exists() {
            Ok(json!({}))
        } else {
            serde_json::from_slice(&storage::read_limited(&p, 2 * 1024 * 1024)?)
                .map_err(|e| format!("Cannot verify subscription settings: {e}"))
        }
    };
    let blocked: &[&str] = match id {
        "claude" => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ],
        "codex" => &["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
        "kimi" => &["KIMI_API_KEY","MOONSHOT_API_KEY","KIMI_BASE_URL","KIMI_MODEL_NAME","KIMI_MODEL_PROVIDER","KIMI_MODEL_BASE_URL","KIMI_MODEL_API_KEY","KIMI_CODE_CUSTOM_HEADERS","ANTHROPIC_API_KEY","ANTHROPIC_BASE_URL","OPENAI_API_KEY","OPENAI_BASE_URL"],
        "gemini" => {
            let v = read(st.home.join(".gemini/settings.json"))?;
            for p in [
                v["security"]["auth"]["selectedType"]
                    .as_str()
                    .or(v["selectedAuthType"].as_str()),
                v["security"]["auth"]["enforcedType"].as_str(),
            ]
            .into_iter()
            .flatten()
            {
                if p != "oauth-personal" {
                    return Err("Gemini must use Login with Google (oauth-personal), not an API key or Vertex AI".into());
                }
            }
            program
                .env
                .push(("GOOGLE_GENAI_USE_GCA".into(), "true".into()));
            program.env.push(("NO_BROWSER".into(), "true".into()));
            &[
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "GOOGLE_GENAI_USE_VERTEXAI",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "GOOGLE_CLOUD_PROJECT",
                "GOOGLE_CLOUD_PROJECT_ID",
                "GOOGLE_CLOUD_LOCATION",
                "GOOGLE_GEMINI_BASE_URL",
                "GEMINI_CLI_USE_COMPUTE_ADC",
                "CLOUD_SHELL",
            ]
        }
        "antigravity" => {
            let settings = read(st.home.join(".gemini/antigravity-cli/settings.json"))?;
            let config = read(st.home.join(".gemini/config/config.json"))?;
            if !s(&settings, "modelProvider").is_empty()
                && s(&settings, "modelProvider") != "antigravity"
            {
                return Err("Antigravity must use a subscription provider".into());
            }
            if config["userSettings"]["enableAdc"] == true {
                return Err("Antigravity is configured for ADC billing; sign in with your personal Google account".into());
            }
            &[
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "GOOGLE_GENAI_USE_VERTEXAI",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "GOOGLE_GEMINI_BASE_URL",
                "AGY_ADC_AUTH",
            ]
        }
        _ => &[],
    };
    for (key, _) in std::env::vars() {
        if blocked.iter().any(|b| b.eq_ignore_ascii_case(&key)) || (id=="kimi"&&key.to_uppercase().starts_with("KIMI_MODEL_")) {
            program.unset.push(key)
        }
    }
    for k in blocked {
        program.unset.push((*k).into())
    }
    Ok(program)
}
pub fn run(st: &Storage, id: &str, args: &[&str]) -> Result<String, String> {
    let p = subscription(st, id, find(st, id)?)?;
    process::run(
        &p,
        &args.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
        Some(&st.home),
        None,
        Duration::from_secs(60),
        8 * 1024 * 1024,
    )?
    .text()
}
pub fn google_usage(st: &Storage, id: &str) -> CoreResult {
    // agy exposes the same Google subscription quota buckets without starting a model turn.
    let envelope: Value = serde_json::from_str(&run(
        st,
        "antigravity",
        &["-p", "/usage", "--output-format", "json"],
    )?)
    .map_err(|e| e.to_string())?;
    parse_google_usage(st, id, &envelope)
}
pub fn parse_google_usage(st: &Storage, id: &str, e: &Value) -> CoreResult {
    if e["status"] != "SUCCESS" {
        return Err(e["error"]
            .as_str()
            .unwrap_or("Subscription quota is unavailable")
            .into());
    }
    let mut groups = vec![];
    for group in arr(&e["command"]["data"]["groups"]) {
        if id == "gemini" && !s(group, "name").to_lowercase().contains("gemini") {
            continue;
        }
        let mut item = json!({"name":group["name"],"description":group["description"]});
        for b in arr(&group["buckets"]) {
            let k = match s(b, "window") {
                "weekly" => "weekly",
                "5h" => "session",
                _ => continue,
            };
            let Some(frac) = b["remaining_fraction"].as_f64() else {
                continue;
            };
            let pct = ((1. - frac) * 100.).clamp(0., 100.);
            if item[k].is_null() || pct > item[k]["pct"].as_f64().unwrap_or(0.) {
                item[k] =
                    json!({"pct":pct,"resetsAt":timestamp(&b["reset_time"]),"label":group["name"]})
            }
        }
        if !item["session"].is_null() || !item["weekly"].is_null() {
            groups.push(item)
        }
    }
    if groups.is_empty() {
        return Err(format!("{} did not report subscription quotas", label(id)));
    }
    groups.sort_by(|a, b| {
        b["session"]["pct"]
            .as_f64()
            .unwrap_or(-1.)
            .partial_cmp(&a["session"]["pct"].as_f64().unwrap_or(-1.))
            .unwrap()
    });
    let mut out = json!({"plan":label(id),"groups":groups});
    let primary = &groups[0];
    for k in ["session", "weekly"] {
        let v = if !primary[k].is_null() {
            primary[k].clone()
        } else {
            groups
                .iter()
                .max_by(|a, b| {
                    a[k]["pct"]
                        .as_f64()
                        .unwrap_or(-1.)
                        .partial_cmp(&b[k]["pct"].as_f64().unwrap_or(-1.))
                        .unwrap()
                })
                .map(|v| v[k].clone())
                .unwrap_or(Value::Null)
        };
        if !v.is_null() {
            out[k] = v
        }
    }
    let email = storage::read_json(&st.home.join(".gemini/google_accounts.json"));
    if !s(&email, "active").is_empty() {
        out["email"] = email["active"].clone()
    }
    Ok(out)
}
pub fn google_probe(st: &Storage, id: &str) -> CoreResult {
    let version = run(st, id, &["--version"])?;
    let p = subscription(st, id, find(st, id)?)?;
    let help_output = process::run(
        &p,
        &["--help".into()],
        Some(&st.home),
        None,
        Duration::from_secs(30),
        8 * 1024 * 1024,
    )?;
    let errors = String::from_utf8_lossy(&help_output.stderr).into_owned();
    let help = format!("{}\n{}", help_output.text()?, errors);
    if !help.contains("--output-format") {
        return Err(format!("Update {} CLI: stream-json is required", label(id)));
    }
    let usage = google_usage(st, id).unwrap_or(Value::Null);
    let mut models = vec![
        json!({"value":"default","displayName":"Default","description":"CLI default","supportedEffortLevels":[]}),
    ];
    if id == "antigravity" {
        for line in run(st, id, &["models"])?.lines() {
            if let Some((v, n)) = line.split_once('\t') {
                models.push(json!({"value":v,"displayName":n.trim(),"supportedEffortLevels":[]}))
            }
        }
    } else {
        for model in [
            "gemini-3.1-pro-preview",
            "gemini-3-pro-preview",
            "gemini-3-flash-preview",
            "gemini-2.5-pro",
            "gemini-3.5-flash",
            "gemini-3.1-flash-lite",
        ] {
            models.push(json!({"value":model,"displayName":model,"supportedEffortLevels":[]}))
        }
    }
    Ok(
        json!({"available":true,"version":version.trim(),"loggedIn":!s(&usage,"email").is_empty(),"account":{"subscriptionType":label(id),"email":usage["email"]},"models":models,"commands":[],"usage":usage}),
    )
}
