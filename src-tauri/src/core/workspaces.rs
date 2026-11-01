//! Bounded conflict previews using a private Git index; the checkout/index/branches are never changed.
use super::{
    process::{self, Program},
    storage, CoreResult,
};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};
thread_local! {static DEADLINE:Cell<Option<Instant>>=const{Cell::new(None)};}
struct Budget;
impl Drop for Budget {
    fn drop(&mut self) {
        DEADLINE.with(|b| b.set(None));
    }
}
pub fn identity(cwd: &Path) -> (String, String) {
    let dir = cwd.canonicalize().unwrap_or_else(|_| cwd.to_owned());
    for root in dir.ancestors() {
        let dot = root.join(".git");
        let git = if dot.is_dir() {
            Some(dot)
        } else {
            std::fs::read_to_string(&dot)
                .ok()
                .and_then(|s| s.trim().strip_prefix("gitdir: ").map(|s| root.join(s)))
        };
        if let Some(git) = git {
            if !git.join("HEAD").is_file() {
                continue;
            }
            let common = std::fs::read_to_string(git.join("commondir"))
                .map(|s| git.join(s.trim()))
                .unwrap_or(git);
            let common = common.canonicalize().unwrap_or(common);
            if !common.join("objects").is_dir() {
                continue;
            }
            return (storage::norm(&common), storage::norm(root));
        }
    }
    let key = storage::norm(&dir);
    (key.clone(), key)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn git(root: &Path, args: &[&str]) -> String {
        text(root, args, None).unwrap()
    }
    #[test]
    fn preview_includes_uncommitted_files_and_preserves_indexes_and_heads() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        git(&repo, &["worktree", "add", "-b", "a", a.to_str().unwrap()]);
        git(&repo, &["worktree", "add", "-b", "b", b.to_str().unwrap()]);
        assert_eq!(identity(&a).0, identity(&b).0);
        assert_ne!(identity(&a).1, identity(&b).1);
        std::fs::write(a.join("file.txt"), "a\n").unwrap();
        std::fs::write(b.join("file.txt"), "b\n").unwrap();
        std::fs::write(a.join("new.txt"), "new untracked\n").unwrap();
        git(&a, &["add", "file.txt"]);
        let status = git(&a, &["status", "--porcelain=v1"]);
        let diff = git(&a, &["diff", "--cached"]);
        let head = git(&a, &["rev-parse", "HEAD"]);
        let tasks = vec![json!({"id":"a","cwd":a}), json!({"id":"b","cwd":b})];
        let mut w = Workspaces::default();
        let first = w.forecast(&tasks, &temp.path().join("indexes")).unwrap();
        assert_eq!(first["conflicts"].as_array().unwrap().len(), 1);
        assert!(first["conflicts"][0]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "file.txt"));
        assert_eq!(git(&a, &["status", "--porcelain=v1"]), status);
        assert_eq!(git(&a, &["diff", "--cached"]), diff);
        assert_eq!(git(&a, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read_to_string(a.join("new.txt")).unwrap(),
            "new untracked\n"
        );
        assert_eq!(
            w.forecast(&tasks, &temp.path().join("indexes")).unwrap()["conflicts"],
            first["conflicts"]
        );
        std::fs::write(a.join("file.txt"), "c\n").unwrap();
        git(&a, &["add", "file.txt"]);
        let staged = w.forecast(&tasks, &temp.path().join("indexes")).unwrap();
        assert_ne!(
            staged["conflicts"][0]["aHash"],
            first["conflicts"][0]["aHash"]
        );
        std::fs::write(a.join("file.txt"), "a\n").unwrap();
        git(&a, &["add", "file.txt"]);
        std::fs::write(b.join("file.txt"), "a\n").unwrap();
        assert!(
            w.forecast(&tasks, &temp.path().join("indexes")).unwrap()["conflicts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
#[derive(Default)]
pub struct Workspaces {
    snapshots: HashMap<String, (String, String)>,
    merges: HashMap<(String, String), Value>,
}
fn run(root: &Path, args: &[&str], index: Option<&Path>) -> Result<process::Output, String> {
    let mut program = Program::new(process::which("git").ok_or("Git was not found")?);
    program.env.extend([
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
    ]);
    if let Some(index) = index {
        program.env.push((
            "GIT_INDEX_FILE".into(),
            index.to_string_lossy().into_owned(),
        ));
    }
    let timeout = DEADLINE.with(|b| {
        b.get()
            .map(|at| {
                at.saturating_duration_since(Instant::now())
                    .min(Duration::from_secs(2))
            })
            .unwrap_or(Duration::from_secs(20))
    });
    if timeout.is_zero() {
        return Err("Conflict preview time budget reached".into());
    }
    process::run(
        &program,
        &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        Some(root),
        None,
        timeout,
        2 * 1024 * 1024,
    )
}
fn text(root: &Path, args: &[&str], index: Option<&Path>) -> Result<String, String> {
    run(root, args, index)?.text().map(|s| s.trim().to_owned())
}
impl Workspaces {
    fn snapshot(&mut self, cwd: &Path, temp: &Path) -> Result<String, String> {
        let head = text(cwd, &["rev-parse", "HEAD"], None)?;
        let mut paths = run(
            cwd,
            &["ls-files", "-m", "-o", "-d", "--exclude-standard", "-z"],
            None,
        )?
        .checked()?;
        paths.extend(run(cwd, &["diff", "--name-only", "-z", "HEAD", "--"], None)?.checked()?);
        let files = String::from_utf8(paths).map_err(|_| "Non-UTF-8 paths cannot be previewed")?;
        let files: HashSet<_> = files.split('\0').filter(|s| !s.is_empty()).collect();
        if files.len() > 256 {
            return Err("More than 256 changed files; preview skipped".into());
        }
        let mut stamps = Vec::new();
        let mut bytes = 0;
        for file in files {
            let meta = std::fs::symlink_metadata(cwd.join(file)).ok();
            if let Some(m) = &meta {
                bytes += m.len();
            }
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|m| m.as_nanos())
                .unwrap_or(0);
            stamps.push(format!(
                "{file}:{modified}:{}",
                meta.map(|m| m.len()).unwrap_or(0)
            ));
        }
        if bytes > 32 * 1024 * 1024 {
            return Err("Changed source exceeds 32 MiB; preview skipped".into());
        }
        stamps.sort();
        let fingerprint = format!("{head}:{}", stamps.join("\n"));
        let key = storage::norm(cwd);
        if let Some((previous, hash)) = self.snapshots.get(&key) {
            if previous == &fingerprint {
                return Ok(hash.clone());
            }
        }
        std::fs::create_dir_all(temp).map_err(|e| e.to_string())?;
        let index = temp.join(uuid::Uuid::new_v4().to_string());
        let result = (|| {
            text(cwd, &["read-tree", "HEAD"], Some(&index))?;
            text(cwd, &["-c", "core.hooksPath=", "add", "-A"], Some(&index))?;
            let tree = text(cwd, &["write-tree"], Some(&index))?;
            text(
                cwd,
                &[
                    "-c",
                    "user.name=Duet",
                    "-c",
                    "user.email=duet@localhost",
                    "-c",
                    "commit.gpgSign=false",
                    "commit-tree",
                    &tree,
                    "-p",
                    &head,
                    "-m",
                    "Duet conflict preview",
                ],
                None,
            )
        })();
        let _ = std::fs::remove_file(&index);
        let _ = std::fs::remove_file(index.with_extension("lock"));
        let hash = result?;
        if self.snapshots.len() > 256 {
            self.snapshots.clear()
        }
        self.snapshots.insert(key, (fingerprint, hash.clone()));
        Ok(hash)
    }
    pub fn forecast(&mut self, tasks: &[Value], temp: &Path) -> CoreResult {
        DEADLINE.with(|b| b.set(Some(Instant::now() + Duration::from_secs(10))));
        let _budget = Budget;
        let mut checked = Vec::new();
        let mut warnings = Vec::new();
        let mut seen = HashSet::new();
        for task in tasks {
            let cwd = PathBuf::from(task["cwd"].as_str().unwrap_or(""));
            let (project, workspace) = identity(&cwd);
            if !seen.insert(workspace.clone()) {
                continue;
            }
            if seen.len() > 32 || checked.len() >= 12 {
                warnings.push(json!({"reason":"Workspace preview budget reached"}));
                break;
            }
            if project == workspace {
                warnings.push(json!({"threadId":task["id"],"reason":"Not a Git working tree"}));
                continue;
            }
            let cwd = PathBuf::from(&workspace);
            match self.snapshot(&cwd, temp) {
                Ok(hash) => checked.push((task, project, workspace, cwd, hash)),
                Err(error) => warnings.push(json!({"threadId":task["id"],"reason":error})),
            }
        }
        let mut pairs = 0;
        let mut conflicts = Vec::new();
        for i in 0..checked.len() {
            for j in i + 1..checked.len() {
                let (a, pa, _, cwd, ha) = &checked[i];
                let (b, pb, _, bcwd, hb) = &checked[j];
                if pa != pb || ha == hb {
                    continue;
                }
                if pairs >= 32 {
                    warnings.push(json!({"reason":"Preview pair budget reached"}));
                    break;
                }
                pairs += 1;
                let key = if ha < hb {
                    (ha.clone(), hb.clone())
                } else {
                    (hb.clone(), ha.clone())
                };
                let result = if let Some(cached) = self.merges.get(&key) {
                    cached.clone()
                } else {
                    let out = match run(
                        cwd,
                        &[
                            "merge-tree",
                            "--write-tree",
                            "--name-only",
                            "--no-messages",
                            ha,
                            hb,
                        ],
                        None,
                    ) {
                        Ok(out) => out,
                        Err(error) => {
                            warnings.push(json!({"reason":error}));
                            continue;
                        }
                    };
                    let value = if out.code == 0 {
                        json!({"clean":true})
                    } else if out.code == 1 {
                        let stdout = String::from_utf8_lossy(&out.stdout);
                        json!({"clean":false,"files":stdout.lines().skip(1).filter(|s|!s.is_empty()).take(100).collect::<Vec<_>>()})
                    } else {
                        warnings.push(json!({"a":a["id"],"b":b["id"],"reason":String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()}));
                        continue;
                    };
                    if self.merges.len() > 512 {
                        self.merges.clear()
                    }
                    self.merges.insert(key, value.clone());
                    value
                };
                if result["clean"] == false {
                    conflicts.push(json!({"a":a["id"],"b":b["id"],"aCwd":cwd,"bCwd":bcwd,"files":result["files"],"aHash":ha,"bHash":hb}));
                }
            }
        }
        Ok(
            json!({"conflicts":conflicts,"warnings":warnings,"checkedWorkspaces":checked.len(),"checkedPairs":pairs,"at":storage::now(),"partial":!warnings.is_empty()}),
        )
    }
}
