use super::{
    agents::Agents,
    events::{arr, s},
    process::{self, Program},
    storage::Storage,
    CoreResult,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
fn run(program: Program, args: &[&str], root: &Path, secs: u64) -> Result<String, String> {
    let mut p = program;
    p.env.extend([
        ("GH_PROMPT_DISABLED".into(), "1".into()),
        ("GH_NO_UPDATE_NOTIFIER".into(), "1".into()),
        ("GH_PAGER".into(), "".into()),
        ("NO_COLOR".into(), "1".into()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
    ]);
    process::run(
        &p,
        &args.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
        Some(root),
        None,
        Duration::from_secs(secs),
        32 * 1024 * 1024,
    )?
    .text()
}
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    run(
        process::resolve("git").ok_or("Git not found")?,
        args,
        root,
        120,
    )
    .map(|v| v.trim().into())
}
fn gh_program() -> Option<Program> {
    if let Some(p) = process::resolve("gh") {
        return Some(p);
    }
    for env in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(env) {
            for suffix in ["GitHub CLI/gh.exe", "Programs/GitHub CLI/gh.exe"] {
                let p = PathBuf::from(&base).join(suffix);
                if p.is_file() {
                    return Some(Program::new(p));
                }
            }
        }
    }
    None
}
fn gh(root: &Path, args: &[&str]) -> Result<String, String> {
    run(
        gh_program().ok_or("GitHub CLI not found; install gh and run gh auth login")?,
        args,
        root,
        60,
    )
}
fn parse(text: String) -> CoreResult {
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
fn reference(s: &str) -> Result<(), String> {
    if s.is_empty()
        || s.starts_with('-')
        || s.contains("..")
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c))
    {
        Err("Invalid branch name".into())
    } else {
        Ok(())
    }
}
fn base_ref(root: &Path, base: &str) -> Result<String, String> {
    reference(base)?;
    for r in [format!("origin/{base}"), base.into()] {
        if git(
            root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{r}^{{commit}}"),
            ],
        )
        .is_ok()
        {
            return Ok(r);
        }
    }
    Err(format!("Branch not found: {base}"))
}
fn branch(root: &Path) -> Result<String, String> {
    let b = git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if b.is_empty() || b == "HEAD" {
        Err("Checkout a branch first".into())
    } else {
        Ok(b)
    }
}
fn check(c: &Value) -> Value {
    let context =
        c["__typename"] == "StatusContext" || (c["context"].is_string() && !c["name"].is_string());
    let state = if context {
        s(c, "state")
    } else {
        s(c, "status")
    }
    .to_uppercase();
    let conclusion = if context {
        state.as_str()
    } else {
        s(c, "conclusion")
    };
    let bucket = if (context && matches!(state.as_str(), "PENDING" | "EXPECTED"))
        || (!context && !state.is_empty() && state != "COMPLETED")
    {
        "pending"
    } else if conclusion.eq_ignore_ascii_case("SUCCESS") {
        "ok"
    } else if ["NEUTRAL", "SKIPPED", "STALE"]
        .iter()
        .any(|x| conclusion.eq_ignore_ascii_case(x))
    {
        "skipped"
    } else if conclusion.is_empty() {
        "pending"
    } else {
        "failed"
    };
    json!({"name":if context{s(c,"context").to_owned()}else if !s(c,"workflowName").is_empty()&&!s(c,"name").is_empty()&&c["workflowName"]!=c["name"]{format!("{} / {}",s(c,"workflowName"),s(c,"name"))}else{c["name"].as_str().or(c["workflowName"].as_str()).unwrap_or("check").into()},"status":if bucket=="pending"{"pending"}else{"completed"},"conclusion":if conclusion.is_empty(){Value::Null}else{json!(conclusion.to_lowercase())},"url":if context{&c["targetUrl"]}else{&c["detailsUrl"]},"bucket":bucket})
}
pub fn invoke(st: &Storage, agents: &Arc<Agents>, ch: &str, args: &[Value]) -> CoreResult {
    let a = |i| args.get(i).unwrap_or(&Value::Null);
    let cwd = Path::new(a(0).as_str().unwrap_or(""));
    let root = git(cwd, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(PathBuf::from);
    if ch == "pr:status" {
        let mut out = json!({"ghInstalled":gh_program().is_some(),"authed":false,"isRepo":root.is_some(),"isGitHub":false,"branch":null,"defaultBranch":null,"upstream":null,"ahead":0,"commitsAhead":0,"repo":null});
        let Some(root) = root else { return Ok(out) };
        out["root"] = json!(root);
        out["branch"] = branch(&root).map(|b| json!(b)).unwrap_or(Value::Null);
        let url = git(&root, &["remote", "get-url", "origin"]).unwrap_or_default();
        out["isGitHub"] = json!(url.to_lowercase().contains("github"));
        let upstream = git(
            &root,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .ok();
        out["upstream"] = json!(upstream);
        if upstream.is_some() {
            out["ahead"] = json!(git(&root, &["rev-list", "--count", "@{u}..HEAD"])
                .unwrap_or_default()
                .parse::<u64>()
                .unwrap_or(0));
        }
        out["defaultBranch"] = json!(git(
            &root,
            &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]
        )
        .ok()
        .map(|v| v.trim_start_matches("origin/").to_owned()));
        if out["ghInstalled"] != true {
            return Ok(out);
        }
        out["authed"] = json!(gh(&root, &["auth", "status"]).is_ok());
        if out["authed"] != true {
            return Ok(out);
        }
        let repo = match gh(
            &root,
            &["repo", "view", "--json", "defaultBranchRef,nameWithOwner"],
        )
        .and_then(parse)
        {
            Ok(v) => v,
            Err(e) => {
                out["error"] = json!(e);
                return Ok(out);
            }
        };
        out["isGitHub"] = json!(true);
        out["repo"] = repo["nameWithOwner"].clone();
        out["defaultBranch"] = repo["defaultBranchRef"]["name"].clone();
        if let Ok(base) = base_ref(&root, s(&out, "defaultBranch")) {
            out["commitsAhead"] = json!(git(
                &root,
                &["rev-list", "--count", &format!("{base}..HEAD")]
            )
            .unwrap_or_default()
            .parse::<u64>()
            .unwrap_or(0));
        }
        if out["branch"].is_string() && out["branch"] != out["defaultBranch"] {
            match gh(&root,&["pr","view",s(&out,"branch"),"--json","number,title,url,state,isDraft,statusCheckRollup,reviewDecision,mergeable,baseRefName"]).and_then(parse){Ok(mut p)=>{p["checks"]=json!(arr(&p["statusCheckRollup"]).iter().map(check).collect::<Vec<_>>());p.as_object_mut().unwrap().remove("statusCheckRollup");out["pr"]=p},Err(e)if e.to_lowercase().contains("no pull requests")||e.to_lowercase().contains("no open pull requests")=>{},Err(e)=>out["error"]=json!(e)}
        }
        return Ok(out);
    }
    let root = root.ok_or("Not a Git repository")?;
    match ch {
        "pr:branches" => Ok(json!(git(
            &root,
            &["branch", "-r", "--format=%(refname:short)"]
        )?
        .lines()
        .filter_map(|l| l.trim().strip_prefix("origin/"))
        .filter(|s| *s != "HEAD")
        .collect::<Vec<_>>())),
        "pr:push" => {
            branch(&root)?;
            git(&root, &["push", "-u", "origin", "HEAD"])?;
            Ok(json!(true))
        }
        "pr:create" => {
            let p = a(1);
            let base = s(p, "base");
            reference(base)?;
            let title = s(p, "title").trim();
            if title.is_empty() {
                return Err("PR title is required".into());
            }
            let head = branch(&root)?;
            if head == base {
                return Err("Base and head branches must differ".into());
            }
            let temp = st
                .data
                .join("native")
                .join(format!("pr-body-{}.md", uuid::Uuid::new_v4()));
            super::storage::atomic_write(&temp, s(p, "body").as_bytes())?;
            let mut argv = vec![
                "pr",
                "create",
                "--base",
                base,
                "--head",
                &head,
                "--title",
                title,
                "--body-file",
                temp.to_str().ok_or("Invalid PR body path")?,
            ];
            if p["draft"] == true {
                argv.push("--draft")
            }
            let result = gh(&root, &argv);
            let _ = std::fs::remove_file(&temp);
            let out = result?;
            let url = out
                .split_whitespace()
                .find(|s| s.starts_with("https://") && s.contains("/pull/"))
                .unwrap_or(out.trim());
            Ok(json!({"url":url}))
        }
        "pr:draft" => {
            let base = a(1).as_str().unwrap_or("");
            let reference = base_ref(&root, base)?;
            let log = git(
                &root,
                &[
                    "log",
                    &format!("{reference}..HEAD"),
                    "--oneline",
                    "--no-decorate",
                    "-n",
                    "60",
                ],
            )?;
            if log.is_empty() {
                return Err("No commits against this base branch".into());
            }
            let stat =
                git(&root, &["diff", &format!("{reference}...HEAD"), "--stat"]).unwrap_or_default();
            let diff = git(&root, &["diff", &format!("{reference}...HEAD")]).unwrap_or_default();
            let prompt=format!("Write a GitHub PR title and concise Markdown description with Summary and Testing sections. English imperative title <=70 characters, then blank line and body. Use only evidence from the diff; do not invent tests. No AI or co-author attribution. Output plain Markdown without fences.\n\nBranch: {} -> {base}\nCommits:\n{}\nStat:\n{}\nDiff:\n{}",branch(&root)?,log.chars().take(4000).collect::<String>(),stat.chars().take(3000).collect::<String>(),diff.chars().take(12000).collect::<String>());
            let out = agents.quick(
                &prompt,
                "You write concise pull request descriptions.",
                Duration::from_secs(120),
            )?;
            let banned=regex::Regex::new(r"(?i)\b(ai|claude|anthropic|chatgpt|openai|copilot)\b|generated with|co-authored-by|🤖").unwrap();
            let lines = out
                .lines()
                .filter(|l| !l.starts_with("```") && !banned.is_match(l))
                .collect::<Vec<_>>();
            let title = lines
                .first()
                .copied()
                .unwrap_or("")
                .trim_start_matches('#')
                .trim()
                .trim_start_matches("Title:")
                .trim()
                .trim_matches('"')
                .chars()
                .take(70)
                .collect::<String>();
            let body = lines.get(1..).unwrap_or(&[]).join("\n");
            Ok(json!({"title":title,"body":body.trim()}))
        }
        "pr:failedLogs" => {
            let branch = branch(&root)?;
            let runs = parse(gh(
                &root,
                &[
                    "run",
                    "list",
                    "--branch",
                    &branch,
                    "--json",
                    "databaseId,conclusion,name,status,url,headSha",
                    "--limit",
                    "5",
                ],
            )?)?;
            let failed = arr(&runs)
                .iter()
                .find(|r| {
                    matches!(
                        s(r, "conclusion"),
                        "failure" | "timed_out" | "startup_failure"
                    )
                })
                .ok_or("No failed CI runs")?;
            let id = failed["databaseId"].to_string();
            let log = events_strip(&gh(&root, &["run", "view", &id, "--log-failed"])?);
            let truncated = log.chars().count() > 8000;
            let log = if truncated {
                log.chars()
                    .rev()
                    .take(8000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            } else {
                log
            };
            Ok(
                json!({"runId":failed["databaseId"],"name":failed["name"],"url":failed["url"],"log":log.trim(),"truncated":truncated}),
            )
        }
        _ => Err(format!("Unknown PR channel {ch}")),
    }
}
fn events_strip(s: &str) -> String {
    super::events::strip_ansi(s)
}
