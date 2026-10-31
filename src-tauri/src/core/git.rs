use super::{
    process::{self, Program},
    storage::{self, Storage},
    CoreResult,
};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::Path, time::Duration};

fn run(root: &Path, args: &[String], input: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut all = vec!["-c".into(), "core.quotepath=off".into()];
    all.extend_from_slice(args);
    process::run(
        &Program::new(process::which("git").ok_or("Git was not found")?),
        &all,
        Some(root),
        input,
        Duration::from_secs(120),
        64 * 1024 * 1024,
    )?
    .checked()
}
pub fn text(root: &Path, args: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&run(
        root,
        &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        None,
    )?)
    .trim()
    .to_owned())
}
fn has_head(root: &Path) -> bool {
    text(root, &["rev-parse", "--verify", "HEAD"]).is_ok()
}
fn relative(root: &Path, file: &str) -> Result<std::path::PathBuf, String> {
    let result = storage::safe_relative(root, file)?;
    if let Ok(real) = result.canonicalize() {
        let canonical = root.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(canonical) {
            return Err("Path resolves outside repository".into());
        }
    }
    Ok(result)
}
pub fn status(cwd: &str) -> CoreResult {
    let directory = Path::new(cwd);
    let root = match text(directory, &["rev-parse", "--show-toplevel"]) {
        Ok(r) => r,
        Err(_) => return Ok(json!({"isRepo":false,"files":[]})),
    };
    let dir = Path::new(&root);
    let head = has_head(dir);
    let raw = run(
        dir,
        &["status", "--porcelain=v1", "-z", "-unormal"].map(str::to_owned),
        None,
    )?;
    let num = if head {
        run(
            dir,
            &["diff", "HEAD", "--numstat", "-z"].map(str::to_owned),
            None,
        )
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    let nums = String::from_utf8_lossy(&num);
    let mut pieces = nums.split('\0');
    let mut counts = HashMap::new();
    while let Some(piece) = pieces.next() {
        let parts: Vec<_> = piece.splitn(3, '\t').collect();
        if parts.len() != 3 {
            continue;
        }
        let path = if parts[2].is_empty() {
            pieces.next();
            pieces.next().unwrap_or("")
        } else {
            parts[2]
        };
        counts.insert(path.to_owned(),json!({"add":parts[0].parse::<u64>().unwrap_or(0),"del":parts[1].parse::<u64>().unwrap_or(0),"binary":parts[0]=="-"}));
    }
    let status = String::from_utf8_lossy(&raw);
    let mut pieces = status.split('\0');
    let mut files = Vec::new();
    while let Some(piece) = pieces.next() {
        if piece.len() < 4 {
            continue;
        }
        let xy = &piece[..2];
        let file = &piece[3..];
        if xy.starts_with('R') || xy.starts_with('C') {
            pieces.next();
        }
        let untracked = xy == "??";
        let mut count = counts
            .remove(file)
            .unwrap_or_else(|| json!({"add":0,"del":0}));
        if untracked {
            if let Ok(data) = storage::read_limited(&dir.join(file), 2 * 1024 * 1024) {
                if !data.contains(&0) {
                    count["add"] = json!(String::from_utf8_lossy(&data).lines().count());
                }
            }
        }
        let mut value = json!({"path":file,"abs":dir.join(file),"status":if untracked{"new"}else if xy.contains('D'){"deleted"}else if xy.contains('A'){"added"}else if xy.starts_with('R'){"renamed"}else{"modified"},"untracked":untracked});
        storage::merge(&mut value, &count);
        files.push(value);
    }
    let branch = text(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    let sync = text(dir, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).ok();
    let numbers = sync
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .filter_map(|s| s.parse::<u64>().ok())
        .collect::<Vec<_>>();
    Ok(
        json!({"isRepo":true,"root":root,"branch":branch,"files":files,"hasHead":head,"upstream":sync.is_some(),"behind":numbers.first().copied().unwrap_or(0),"ahead":numbers.get(1).copied().unwrap_or(0)}),
    )
}
pub fn invoke(channel: &str, args: &[Value]) -> CoreResult {
    let a = |n: usize| args.get(n).unwrap_or(&Value::Null);
    let s = |n: usize| {
        a(n).as_str()
            .ok_or_else(|| format!("{channel}: expected path/string"))
    };
    if channel == "app:gitStatus" {
        return status(s(0)?);
    }
    if channel == "app:gitBranch" {
        return Ok(json!(text(
            Path::new(a(0).as_str().unwrap_or("")),
            &["rev-parse", "--abbrev-ref", "HEAD"]
        )
        .ok()));
    }
    let root = Path::new(s(0)?);
    match channel {
        "app:gitBranches" => Ok(json!(text(root, &["branch", "--format=%(refname:short)"])?
            .lines()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>())),
        "app:gitCheckout" => {
            let branch = s(1)?;
            if branch.is_empty()
                || branch.starts_with('-')
                || !branch
                    .chars()
                    .all(|c| c.is_alphanumeric() || "_./-".contains(c))
            {
                return Err("Invalid branch name".into());
            }
            if a(2).as_bool().unwrap_or(false) {
                text(root, &["switch", "-c", branch])?;
            } else {
                text(root, &["switch", branch])?;
            }
            Ok(json!(true))
        }
        "app:gitCommit" => {
            let files = a(1).as_array().ok_or("Expected file list")?;
            if files.is_empty() {
                return Err("Select files to commit".into());
            }
            let message = s(2)?.trim();
            if message.is_empty() {
                return Err("Commit message is empty".into());
            }
            let mut names = Vec::new();
            for file in files {
                let file = file.as_str().ok_or("Invalid file path")?;
                relative(root, file)?;
                names.push(file.to_owned());
            }
            let mut add = vec!["add".into(), "-A".into(), "--".into()];
            add.extend(names.clone());
            run(root, &add, None)?;
            let mut commit = vec![
                "commit".into(),
                "-m".into(),
                message.into(),
                "--only".into(),
                "--".into(),
            ];
            commit.extend(names);
            run(root, &commit, None)?;
            Ok(json!(text(root, &["log", "-1", "--format=%h %s"])?))
        }
        "app:gitPush" => {
            if text(
                root,
                &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            )
            .is_ok()
            {
                text(root, &["push"])?;
            } else {
                text(root, &["push", "-u", "origin", "HEAD"])?;
            }
            Ok(json!(true))
        }
        "app:gitPull" => {
            text(root, &["pull", "--ff-only"])?;
            Ok(json!(true))
        }
        "app:gitDiscard" => {
            let file = s(1)?;
            let path = relative(root, file)?;
            if a(2).as_bool().unwrap_or(false) {
                if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
                } else if path.exists() {
                    fs::remove_file(path).map_err(|e| e.to_string())?;
                }
            } else {
                text(
                    root,
                    &[
                        "restore",
                        "--source=HEAD",
                        "--staged",
                        "--worktree",
                        "--",
                        file,
                    ],
                )?;
            }
            Ok(json!(true))
        }
        "app:gitFileDiff" => {
            let file = s(1)?;
            let abs = relative(root, file)?;
            if a(2).as_bool().unwrap_or(false) {
                let metadata = fs::metadata(&abs).map_err(|e| e.to_string())?;
                if metadata.is_dir() {
                    return Ok(json!({"kind":"dir"}));
                }
                if metadata.len() > 512 * 1024 {
                    return Ok(json!({"kind":"too-large"}));
                }
                let bytes = storage::read_limited(&abs, 512 * 1024)?;
                if bytes.contains(&0) {
                    Ok(json!({"kind":"binary"}))
                } else {
                    Ok(json!({"kind":"new","text":String::from_utf8_lossy(&bytes)}))
                }
            } else {
                let args = if has_head(root) {
                    vec!["diff", "HEAD", "--", file]
                } else {
                    vec!["diff", "--", file]
                };
                Ok(
                    json!({"kind":"diff","text":String::from_utf8_lossy(&run(root,&args.iter().map(|v|v.to_string()).collect::<Vec<_>>(),None)?)}),
                )
            }
        }
        _ => Err(format!("Unknown Git command {channel}")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commits_branches_worktrees_and_paths_keep_the_previous_contract() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        text(&root, &["init", "-b", "main"]).unwrap();
        text(&root, &["config", "user.name", "Fixture"]).unwrap();
        text(&root, &["config", "core.autocrlf", "false"]).unwrap();
        text(&root, &["config", "commit.gpgsign", "false"]).unwrap();
        text(&root, &["config", "user.email", "fixture@example.invalid"]).unwrap();
        fs::write(root.join("file name.txt"), "old\n").unwrap();
        let p = json!(root);
        invoke(
            "app:gitCommit",
            &[p.clone(), json!(["file name.txt"]), json!("Initial")],
        )
        .unwrap();
        fs::write(root.join("file name.txt"), "new\n").unwrap();
        fs::write(root.join("Привет.txt"), "extra\n").unwrap();
        let st = status(root.to_str().unwrap()).unwrap();
        assert_eq!(st["files"].as_array().unwrap().len(), 2);
        let diff = invoke(
            "app:gitFileDiff",
            &[p.clone(), json!("file name.txt"), json!(false)],
        )
        .unwrap();
        assert!(diff["text"].as_str().unwrap().contains("+new\n"));
        assert!(relative(&root, "../escape").is_err());
        invoke(
            "app:gitDiscard",
            &[p.clone(), json!("file name.txt"), json!(false)],
        )
        .unwrap();
        invoke(
            "app:gitDiscard",
            &[p.clone(), json!("Привет.txt"), json!(true)],
        )
        .unwrap();
        invoke(
            "app:gitCheckout",
            &[p.clone(), json!("feature"), json!(true)],
        )
        .unwrap();
        assert!(invoke("app:gitBranches", &[p.clone()])
            .unwrap()
            .as_array()
            .unwrap()
            .contains(&json!("feature")));
        let st = Storage::new(
            temp.path().join("data"),
            temp.path().join("home"),
            temp.path().into(),
        );
        let wt = worktree(&st, "wt:create", &[p]).unwrap();
        let folder = Path::new(wt["path"].as_str().unwrap());
        fs::write(folder.join("file name.txt"), "worktree\n").unwrap();
        assert_eq!(
            worktree(&st, "wt:apply", &[wt["path"].clone()]).unwrap()["applied"],
            true
        );
        assert_eq!(
            fs::read_to_string(root.join("file name.txt")).unwrap(),
            "worktree\n"
        );
        worktree(&st, "wt:remove", &[wt["path"].clone()]).unwrap();
        assert!(!folder.exists());
    }
}
pub fn diff_for_message(root: &Path, files: &[Value]) -> Result<String, String> {
    let mut names = Vec::new();
    for file in files {
        let name = file.as_str().ok_or("Invalid file")?;
        relative(root, name)?;
        names.push(name.to_owned());
    }
    let mut args = vec!["diff".into(), "HEAD".into(), "--".into()];
    args.extend(names.clone());
    let mut out = String::from_utf8_lossy(&run(root, &args, None).unwrap_or_default()).into_owned();
    let mut args = vec![
        "ls-files".into(),
        "--others".into(),
        "--exclude-standard".into(),
        "--".into(),
    ];
    args.extend(names);
    for name in String::from_utf8_lossy(&run(root, &args, None).unwrap_or_default())
        .lines()
        .take(20)
    {
        if let Ok(bytes) = storage::read_limited(&relative(root, name)?, 512 * 1024) {
            out.push_str(&format!(
                "\n--- new file: {name}\n{}",
                String::from_utf8_lossy(&bytes[..bytes.len().min(3000)])
            ));
        }
    }
    Ok(out.chars().take(24000).collect())
}
pub fn worktree(storage: &Storage, channel: &str, args: &[Value]) -> CoreResult {
    let path = args.first().and_then(Value::as_str).unwrap_or("");
    let dir = Path::new(path);
    let key = storage::norm(dir);
    match channel {
        "wt:all" => Ok(storage.read("worktrees.json")),
        "wt:isRepo" => Ok(json!(!path.is_empty() && has_head(dir))),
        "wt:create" => {
            let base = text(dir, &["rev-parse", "--show-toplevel"])?;
            let commit = text(Path::new(&base), &["rev-parse", "HEAD"])?;
            let branch = text(Path::new(&base), &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
            let slug = format!(
                "{}-{}",
                storage::now(),
                &uuid::Uuid::new_v4().to_string()[..6]
            );
            let name = Path::new(&base)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .replace(
                    |c: char| !c.is_ascii_alphanumeric() && !"._-".contains(c),
                    "_",
                );
            let folder = storage
                .home
                .join(".claude-desk/worktrees")
                .join(format!("{name}-{slug}"));
            fs::create_dir_all(folder.parent().unwrap()).map_err(|e| e.to_string())?;
            let new_branch = format!("desk/{slug}");
            text(
                Path::new(&base),
                &[
                    "worktree",
                    "add",
                    "-b",
                    &new_branch,
                    &folder.to_string_lossy(),
                    &commit,
                ],
            )?;
            let entry = json!({"path":folder,"base":base,"branch":new_branch,"baseCommit":commit,"baseBranch":branch,"createdAt":storage::now()});
            storage.update("worktrees.json", |reg| {
                reg[storage::norm(&folder)] = entry.clone();
                Ok(())
            })?;
            Ok(entry)
        }
        "wt:apply" | "wt:remove" => {
            let entry = storage.read("worktrees.json")[&key].clone();
            if entry.is_null() || entry["removed"] == true {
                return Err("Not an active Duet worktree".into());
            }
            let base = Path::new(entry["base"].as_str().ok_or("Invalid worktree base")?);
            let recorded = Path::new(entry["path"].as_str().ok_or("Invalid worktree path")?);
            let work_root = storage.home.join(".claude-desk/worktrees");
            if !recorded.starts_with(&work_root) || storage::norm(recorded) != key {
                return Err("Worktree path is outside the managed directory".into());
            }
            let resolved_root = work_root.canonicalize().map_err(|e| e.to_string())?;
            let resolved = recorded.canonicalize().map_err(|e| e.to_string())?;
            if resolved == resolved_root
                || !resolved.starts_with(&resolved_root)
                || recorded
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err("Resolved worktree path is outside the managed directory".into());
            }
            if channel == "wt:remove" {
                let _ = text(
                    base,
                    &["worktree", "remove", "--force", &recorded.to_string_lossy()],
                );
                if recorded.exists() {
                    fs::remove_dir_all(recorded).map_err(|e| e.to_string())?;
                }
                let _ = text(base, &["worktree", "prune"]);
                if let Some(branch) = entry["branch"].as_str() {
                    let _ = text(base, &["branch", "-D", branch]);
                }
                storage.update("worktrees.json", |reg| {
                    reg[&key]["removed"] = json!(true);
                    Ok(())
                })?;
                return Ok(json!(true));
            }
            text(dir, &["add", "-A"])?;
            let commit = entry["baseCommit"].as_str().ok_or("Missing base commit")?;
            let patch = run(
                dir,
                &["diff", "--cached", "--binary", commit].map(str::to_owned),
                None,
            )?;
            if patch.is_empty() {
                return Ok(json!({"applied":false,"files":0}));
            }
            let list = text(dir, &["diff", "--cached", "--name-only", commit])?
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if run(
                base,
                &["apply", "--3way", "--whitespace=nowarn", "-"].map(str::to_owned),
                Some(patch.clone()),
            )
            .is_err()
            {
                run(
                    base,
                    &["apply", "--whitespace=nowarn", "-"].map(str::to_owned),
                    Some(patch),
                )?;
            }
            Ok(json!({"applied":true,"files":list.len(),"list":list}))
        }
        _ => Err("Unknown worktree command".into()),
    }
}
