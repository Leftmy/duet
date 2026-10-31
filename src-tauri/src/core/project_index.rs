use super::{process, CoreResult};
use serde_json::json;
use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    path::Path,
};
const MAX_FILES: usize = 30000;
const SKIP: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "target",
    "bin",
    "obj",
    ".idea",
    ".vs",
    ".vscode-test",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".gradle",
    "coverage",
    ".terraform",
    "vendor",
    "Pods",
    "DerivedData",
    ".angular",
    ".expo",
];
pub fn index(cwd: &str) -> CoreResult {
    let root = Path::new(cwd);
    if cwd.is_empty() || !root.is_dir() {
        return Ok(json!({"entries":[],"git":false,"truncated":false}));
    }
    let mut files = BTreeSet::new();
    let mut git = false;
    let mut truncated = false;
    if let Ok(raw) = process::text(
        "git",
        &[
            "-c",
            "core.quotepath=off",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        Some(root),
        20,
    ) {
        git = true;
        for file in raw.split('\0').filter(|s| !s.is_empty()) {
            if files.len() >= MAX_FILES {
                truncated = true;
                break;
            }
            files.insert(file.replace('\\', "/"));
        }
    } else {
        let mut queue = VecDeque::from([root.to_owned()]);
        'walk: while let Some(dir) = queue.pop_front() {
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let kind = match entry.file_type() {
                    Ok(k) => k,
                    Err(_) => continue,
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                if kind.is_dir() {
                    if !SKIP.contains(&name.as_str()) && !name.starts_with(".git") {
                        queue.push_back(entry.path());
                    }
                } else if (kind.is_file() || kind.is_symlink())
                    && name != ".DS_Store"
                    && name != "Thumbs.db"
                {
                    if let Ok(rel) = entry.path().strip_prefix(root) {
                        files.insert(rel.to_string_lossy().replace('\\', "/"));
                        if files.len() >= MAX_FILES {
                            truncated = true;
                            break 'walk;
                        }
                    }
                }
            }
        }
    }
    let mut dirs = BTreeSet::new();
    for file in &files {
        for (index, _) in file.match_indices('/') {
            dirs.insert(file[..index + 1].to_owned());
        }
    }
    Ok(
        json!({"entries":dirs.into_iter().chain(files).collect::<Vec<_>>(),"git":git,"truncated":truncated}),
    )
}
