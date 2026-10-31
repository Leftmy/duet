use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("File is too large".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("File grew beyond size limit".into());
    }
    Ok(bytes)
}
pub fn read_json(path: &Path) -> Value {
    read_limited(path, 16 * 1024 * 1024)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}))
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".duet-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    atomic_write(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}
pub fn merge(target: &mut Value, patch: &Value) {
    if !target.is_object() {
        *target = json!({});
    }
    if let Some(map) = patch.as_object() {
        for (key, value) in map {
            target[key] = value.clone();
        }
    }
}
pub fn norm(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}
pub fn safe_relative(root: &Path, file: &str) -> Result<PathBuf, String> {
    let path = Path::new(file);
    if path.is_absolute() {
        return Err("Expected a repository-relative path".into());
    }
    if path.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::Prefix(_)
                | std::path::Component::RootDir
        )
    }) {
        return Err("Path outside repository".into());
    }
    if file.is_empty() {
        return Err("Empty path".into());
    }
    Ok(root.join(path))
}
pub struct Storage {
    pub data: PathBuf,
    pub home: PathBuf,
    pub runtime: PathBuf,
    lock: Mutex<()>,
}
impl Storage {
    pub fn new(data: PathBuf, home: PathBuf, runtime: PathBuf) -> Self {
        Self {
            data,
            home,
            runtime,
            lock: Mutex::new(()),
        }
    }
    pub fn read(&self, name: &str) -> Value {
        let _guard = self.lock.lock().unwrap();
        read_json(&self.data.join(name))
    }
    pub fn update(
        &self,
        name: &str,
        change: impl FnOnce(&mut Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        let file = self.data.join(name);
        let mut value = if file.exists() {
            serde_json::from_slice(&read_limited(&file, 16 * 1024 * 1024)?)
                .map_err(|e| format!("Cannot update invalid {name}: {e}"))?
        } else {
            json!({})
        };
        change(&mut value)?;
        write_json(&file, &value)?;
        Ok(value)
    }
    pub fn settings(&self) -> Value {
        self.read("settings.json")
    }
    pub fn ui(&self) -> Value {
        self.settings()
            .get("ui")
            .cloned()
            .unwrap_or_else(|| json!({}))
    }
    pub fn set_ui(&self, patch: &Value) -> Result<Value, String> {
        if !patch.is_object() {
            return Err("Settings must be an object".into());
        }
        Ok(self.update("settings.json", |value| {
            merge(&mut value["ui"], patch);
            Ok(())
        })?["ui"]
            .clone())
    }
    pub fn claude_home(&self) -> PathBuf {
        std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or(self.home.join(".claude"))
    }
    pub fn codex_home(&self) -> PathBuf {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or(self.home.join(".codex"))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_settings_merge_preserves_window_and_other_fields() {
        let d = tempfile::tempdir().unwrap();
        let s = Storage::new(d.path().into(), d.path().join("home"), d.path().into());
        s.update("settings.json", |v| {
            v["maximized"] = json!(true);
            Ok(())
        })
        .unwrap();
        s.set_ui(&json!({"language":"ru"})).unwrap();
        s.set_ui(&json!({"theme":"dark"})).unwrap();
        assert_eq!(s.settings()["maximized"], true);
        assert_eq!(s.ui()["language"], "ru");
        assert_eq!(s.ui()["theme"], "dark");
        assert!(safe_relative(d.path(), "../escape").is_err());
    }
}
