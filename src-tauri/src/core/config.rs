//! Editors for the files consumed by the CLIs. No transcript or SDK process is involved.
use super::{
    events::{arr, s},
    storage::{self, Storage},
    CoreResult, Emit,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
const MAX: u64 = 2 * 1024 * 1024;
fn text(path: &Path) -> Result<String, String> {
    String::from_utf8(storage::read_limited(path, MAX)?).map_err(|e| e.to_string())
}
fn safe(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}
fn filename(p: &Path) -> &str {
    p.file_name().and_then(|v| v.to_str()).unwrap_or("")
}
pub fn frontmatter(source: &str) -> (Value, String) {
    let source = source.trim_start_matches('\u{feff}');
    let mut lines = source.lines();
    if lines.next() != Some("---") {
        return (json!({}), source.into());
    }
    let mut data = json!({});
    let mut consumed = source.find('\n').map(|i| i + 1).unwrap_or(source.len());
    let mut key = String::new();
    let mut block = false;
    let mut folded = false;
    for line in source[consumed..].lines() {
        consumed += line.len() + 1;
        if line.trim() == "---" {
            return (
                data,
                source
                    .get(consumed.min(source.len())..)
                    .unwrap_or("")
                    .into(),
            );
        }
        if (line.starts_with(' ') || line.starts_with('\t') || line.starts_with("- "))
            && !key.is_empty()
        {
            let previous = data[&key].as_str().unwrap_or("");
            let part = line.trim().trim_start_matches("- ");
            data[&key] = json!(format!(
                "{previous}{}{part}",
                if previous.is_empty() {
                    ""
                } else if block && !folded {
                    "\n"
                } else if line.trim().starts_with("- ") {
                    ", "
                } else {
                    " "
                }
            ));
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                key = k.into();
                let v = v.trim();
                block = v.starts_with('|') || v.starts_with('>');
                folded = v.starts_with('>');
                data[k] = json!(if block {
                    String::new()
                } else if v.starts_with('"') {
                    serde_json::from_str::<String>(v).unwrap_or(v.trim_matches('"').into())
                } else {
                    v.trim_matches('\'').replace("''", "'")
                });
            }
        }
    }
    (json!({}), source.into())
}
fn description(source: &str) -> Value {
    let (d, b) = frontmatter(source);
    let desc = s(&d, "description");
    let desc = if desc.is_empty() {
        b.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim_start_matches('#')
            .trim()
            .chars()
            .take(120)
            .collect::<String>()
    } else {
        desc.into()
    };
    json!({"description":desc,"argumentHint":s(&d,"argument-hint"),"model":s(&d,"model")})
}
fn roots(st: &Storage, cwd: &str, agent: &str) -> Value {
    let codex = agent == "codex";
    let base = if codex {
        st.codex_home()
    } else {
        st.claude_home()
    };
    let commands = if codex { "prompts" } else { "commands" };
    let mut r = json!({"home":st.home,"trash":base.join(".desk-trash"),"user":{"commands":base.join(commands),"skills":base.join("skills")}});
    if !cwd.is_empty()
        && safe(Path::new(cwd))
        && storage::norm(Path::new(cwd)) != storage::norm(&st.home)
    {
        let p = Path::new(cwd).join(if codex { ".codex" } else { ".claude" });
        r["project"] = json!({"commands":if codex{Value::Null}else{json!(p.join(commands))},"skills":p.join("skills")})
    }
    r
}
struct Location {
    scope: String,
    kind: String,
    name: String,
    item: PathBuf,
}
fn locate(roots: &Value, file: &Path) -> Result<Location, String> {
    if !safe(file) {
        return Err("Invalid command path".into());
    }
    for scope in ["user", "project"] {
        for (kind, k) in [("command", "commands"), ("skill", "skills")] {
            let Some(root) = roots[scope][k].as_str().map(PathBuf::from) else {
                continue;
            };
            let Ok(rel) = file.strip_prefix(&root) else {
                continue;
            };
            let parts = rel
                .components()
                .map(|p| p.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            if parts.is_empty() || parts.iter().any(|p| p.starts_with('.')) {
                continue;
            }
            let valid = if kind == "command" {
                parts.len() <= 5
                    && filename(file).to_lowercase().ends_with(".md")
                    && !filename(file).eq_ignore_ascii_case("SKILL.md")
            } else {
                parts.len() == 2 && parts[1] == "SKILL.md"
            };
            if !valid {
                continue;
            }
            let name = if kind == "skill" {
                parts[0].clone()
            } else {
                parts.join(":").trim_end_matches(".md").into()
            };
            return Ok(Location {
                scope: scope.into(),
                kind: kind.into(),
                name,
                item: if kind == "skill" {
                    file.parent().unwrap().into()
                } else {
                    file.into()
                },
            });
        }
    }
    Err("File is outside command/skill roots".into())
}
fn target(roots: &Value, scope: &str, kind: &str, name: &str) -> Result<PathBuf, String> {
    let parts = name.split(':').collect::<Vec<_>>();
    if name.is_empty()
        || parts.len() > 5
        || (kind == "skill" && parts.len() != 1)
        || parts.iter().any(|p| {
            p.is_empty()
                || p.len() > 64
                || !p
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        })
    {
        return Err("Use 1–64 lowercase letters, digits, _ or - per name component".into());
    }
    if kind != "command" && kind != "skill" {
        return Err("Unknown command kind".into());
    }
    if kind == "command" && parts.last() == Some(&"skill") {
        return Err("SKILL.md is reserved".into());
    }
    let root = roots[scope][if kind == "skill" {
        "skills"
    } else {
        "commands"
    }]
    .as_str()
    .ok_or("Scope is unavailable")?;
    let mut p = PathBuf::from(root);
    for part in parts {
        p.push(part)
    }
    if kind == "skill" {
        p.push("SKILL.md")
    } else {
        p.set_extension("md");
    }
    Ok(p)
}
fn entry(roots: &Value, p: &Path) -> Result<Value, String> {
    let l = locate(roots, p)?;
    let mut e = description(&text(p).unwrap_or_default());
    e["scope"] = json!(l.scope);
    e["kind"] = json!(l.kind);
    e["name"] = json!(l.name);
    e["path"] = json!(p);
    Ok(e)
}
fn walk(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || out.len() >= 10000 {
        return;
    }
    let Ok(rd) = fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(t) = e.file_type() else { continue };
        if filename(&p).starts_with('.') || t.is_symlink() {
            continue;
        }
        if t.is_dir() {
            walk(&p, depth - 1, out)
        } else if t.is_file() && filename(&p).to_lowercase().ends_with(".md") {
            out.push(p)
        }
    }
}
pub fn commands(st: &Storage, ch: &str, args: &[Value], emit: &Emit) -> CoreResult {
    let a = |i| args.get(i).unwrap_or(&Value::Null);
    let o = a(0);
    let writing = ch == "cmd:write";
    let cwd = if writing {
        s(o, "cwd")
    } else if ch == "cmd:rename" {
        a(2).as_str().unwrap_or("")
    } else if ch == "cmd:list" || ch == "cmd:paths" {
        a(0).as_str().unwrap_or("")
    } else {
        a(1).as_str().unwrap_or("")
    };
    let agent = if writing {
        s(o, "agent")
    } else if ch == "cmd:rename" {
        a(3).as_str().unwrap_or("")
    } else if ch == "cmd:list" || ch == "cmd:paths" {
        a(1).as_str().unwrap_or("")
    } else {
        a(2).as_str().unwrap_or("")
    };
    let r = roots(st, cwd, agent);
    let file = Path::new(a(0).as_str().unwrap_or(""));
    match ch {
        "cmd:paths" => Ok(r),
        "cmd:list" => {
            let mut files = vec![];
            for scope in ["user", "project"] {
                for key in ["commands", "skills"] {
                    if let Some(root) = r[scope][key].as_str() {
                        walk(
                            Path::new(root),
                            if key == "skills" { 2 } else { 5 },
                            &mut files,
                        )
                    }
                }
            }
            let mut entries = files
                .iter()
                .filter_map(|p| entry(&r, p).ok())
                .collect::<Vec<_>>();
            entries.sort_by_key(|e| (s(e, "scope") == "project", s(e, "name").to_lowercase()));
            Ok(json!(entries))
        }
        "cmd:read" => {
            let mut e = entry(&r, file)?;
            e["text"] = json!(text(file)?);
            Ok(e)
        }
        "cmd:write" => {
            let p = if !s(o, "path").is_empty() {
                let p = PathBuf::from(s(o, "path"));
                locate(&r, &p)?;
                if !p.is_file() {
                    return Err("Command has been deleted".into());
                }
                p
            } else {
                let p = target(&r, s(o, "scope"), s(o, "kind"), s(o, "name"))?;
                if p.exists() && o["overwrite"] != true {
                    return Err("Command already exists".into());
                }
                p
            };
            let content = o["text"].as_str().ok_or("Missing command text")?;
            if content.len() > MAX as usize {
                return Err("Command is too large".into());
            }
            let created = !p.exists();
            storage::atomic_write(&p, content.as_bytes())?;
            let mut e = entry(&r, &p)?;
            e["created"] = json!(created);
            emit("cmd:changed", json!({"op":"write","path":p}));
            Ok(e)
        }
        "cmd:delete" => {
            let loc = locate(&r, file)?;
            let to = Path::new(s(&r, "trash")).join(format!(
                "{}_{}",
                uuid::Uuid::new_v4(),
                filename(&loc.item)
            ));
            fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::rename(&loc.item, &to).map_err(|e| e.to_string())?;
            emit("cmd:changed", json!({"op":"delete","path":file}));
            Ok(json!({"ok":true,"trashed":to}))
        }
        "cmd:rename" => {
            let l = locate(&r, file)?;
            let p = target(&r, &l.scope, &l.kind, a(1).as_str().unwrap_or(""))?;
            let item = if l.kind == "skill" {
                p.parent().unwrap()
            } else {
                &p
            };
            if item != l.item {
                if item.exists() {
                    return Err("Command already exists".into());
                }
                fs::create_dir_all(item.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::rename(&l.item, item).map_err(|e| e.to_string())?;
            }
            if l.kind == "skill" {
                let src = text(&p)?;
                let (d, _) = frontmatter(&src);
                if s(&d, "name") == l.name {
                    let re = regex::Regex::new(r"(?m)^name:[^\r\n]*").unwrap();
                    storage::atomic_write(
                        &p,
                        re.replace(&src, format!("name: {}", a(1).as_str().unwrap_or("")))
                            .as_bytes(),
                    )?;
                }
            }
            emit("cmd:changed", json!({"op":"rename","path":p,"from":file}));
            entry(&r, &p)
        }
        _ => Err(format!("Unknown command channel {ch}")),
    }
}
fn memory(st: &Storage, cwd: &str) -> PathBuf {
    let encoded = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let root = st.claude_home().join("projects");
    if encoded.len() > 200 {
        if let Ok(rd) = fs::read_dir(&root) {
            if let Some(e) = rd
                .flatten()
                .find(|e| e.file_name().to_string_lossy().starts_with(&encoded[..200]))
            {
                return e.path().join("memory");
            }
        }
    }
    root.join(encoded).join("memory")
}
fn allowed(st: &Storage, p: &Path) -> bool {
    if !safe(p) {
        return false;
    }
    let b = filename(p);
    let parent = p.parent().unwrap_or(Path::new(""));
    matches!(b, "CLAUDE.md" | "CLAUDE.local.md" | "AGENTS.md")
        || (b == "config.toml" && filename(parent) == ".codex")
        || (matches!(b, "settings.json" | "settings.local.json")
            && (filename(parent) == ".claude" || parent == st.claude_home()))
        || (b.ends_with(".md")
            && filename(parent) == "memory"
            && parent.parent().and_then(Path::parent)
                == Some(st.claude_home().join("projects").as_path()))
}
pub fn instructions(st: &Storage, ch: &str, args: &[Value]) -> CoreResult {
    let a = |i| args.get(i).unwrap_or(&Value::Null);
    let cwd = a(0).as_str().unwrap_or("");
    match ch {
        "instr:list" => {
            let mut docs = vec![];
            let mut add = |agent: &str, group: &str, label: &str, p: PathBuf| {
                let md = fs::metadata(&p).ok().filter(|m| m.is_file());
                docs.push(json!({"id":p,"path":p,"agent":agent,"group":group,"label":label,"exists":md.is_some(),"kind":p.extension().and_then(|v|v.to_str()).unwrap_or("md"),"size":md.map(|m|m.len()).unwrap_or(0)}));
            };
            for (agent, base, file, label) in [
                (
                    "claude",
                    st.claude_home(),
                    "CLAUDE.md",
                    "Global instructions",
                ),
                ("claude", st.claude_home(), "settings.json", "User settings"),
                ("codex", st.codex_home(), "AGENTS.md", "Global instructions"),
                ("codex", st.codex_home(), "config.toml", "Codex config"),
            ] {
                add(agent, "global", label, base.join(file))
            }
            if !cwd.is_empty() {
                for (agent, file) in [
                    ("claude", "CLAUDE.md"),
                    ("claude", "CLAUDE.local.md"),
                    ("claude", ".claude/settings.json"),
                    ("claude", ".claude/settings.local.json"),
                    ("codex", "AGENTS.md"),
                    ("codex", ".codex/config.toml"),
                ] {
                    add(agent, "project", file, Path::new(cwd).join(file))
                }
                if let Ok(rd) = fs::read_dir(memory(st, cwd)) {
                    let mut names = rd
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| p.is_file() && filename(p).ends_with(".md"))
                        .collect::<Vec<_>>();
                    names.sort_by_key(|p| (filename(p) != "MEMORY.md", filename(p).to_owned()));
                    for p in names {
                        add("claude", "memory", filename(&p), p.clone())
                    }
                }
            }
            Ok(json!(docs))
        }
        "instr:read" | "instr:write" => {
            let p = Path::new(cwd);
            if !allowed(st, p) {
                return Err("This is not an instruction/settings file".into());
            }
            if ch == "instr:read" {
                if !p.exists() {
                    return Ok(json!({"text":"","exists":false}));
                }
                return Ok(json!({"text":text(p)?,"exists":true}));
            }
            let content = a(1).as_str().ok_or("Missing content")?;
            if content.len() > MAX as usize {
                return Err("Instruction file is too large".into());
            }
            if p.extension().is_some_and(|x| x == "json") {
                serde_json::from_str::<Value>(content).map_err(|e| format!("Invalid JSON: {e}"))?;
            }
            if p.exists() {
                fs::copy(p, format!("{}.bak", p.display())).map_err(|e| e.to_string())?;
            }
            storage::atomic_write(p, content.as_bytes())?;
            Ok(json!({"ok":true,"size":content.len()}))
        }
        "instr:hooksSummary" => {
            let mut out = vec![];
            let mut files = vec![("user", st.claude_home().join("settings.json"))];
            if !cwd.is_empty() {
                files.push(("project", Path::new(cwd).join(".claude/settings.json")));
                files.push(("local", Path::new(cwd).join(".claude/settings.local.json")))
            }
            for (source, p) in files {
                if !p.exists() {
                    continue;
                }
                let v: Value = match serde_json::from_str(&text(&p)?) {
                    Ok(v) => v,
                    Err(e) => {
                        out.push(json!({"source":source,"file":p,"event":"","matcher":"","commands":[],"error":e.to_string()}));
                        continue;
                    }
                };
                if let Some(hooks) = v["hooks"].as_object() {
                    for (event, groups) in hooks {
                        for g in arr(groups) {
                            let commands = arr(&g["hooks"])
                                .iter()
                                .filter_map(|h| {
                                    let c = s(h, "command");
                                    if !c.is_empty() {
                                        Some(c.to_owned())
                                    } else if !s(h, "type").is_empty() {
                                        Some(format!(
                                            "[{}] {}",
                                            s(h, "type"),
                                            h["prompt"]
                                                .as_str()
                                                .or(h["url"].as_str())
                                                .unwrap_or("")
                                        ))
                                    } else {
                                        None
                                    }
                                })
                                .collect::<Vec<_>>();
                            out.push(json!({"source":source,"file":p,"event":event,"matcher":s(g,"matcher"),"commands":commands}));
                        }
                    }
                }
            }
            Ok(json!(out))
        }
        _ => Err(format!("Unknown instruction channel {ch}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_paths_and_edits_are_confined_and_recoverable() {
        let d = tempfile::tempdir().unwrap();
        let st = Storage::new(
            d.path().join("data"),
            d.path().join("home"),
            d.path().into(),
        );
        let emit: Emit = std::sync::Arc::new(|_, _| {});
        let v=commands(&st,"cmd:write",&[json!({"scope":"user","kind":"command","name":"test:hello","text":"---\ndescription: Hi\n---\nHello"})],&emit).unwrap();
        assert_eq!(v["description"], "Hi");
        assert!(target(&roots(&st, "", "claude"), "user", "skill", "../escape").is_err());
        let removed = commands(&st, "cmd:delete", &[v["path"].clone()], &emit).unwrap();
        assert!(Path::new(s(&removed, "trashed")).exists());
    }
}
