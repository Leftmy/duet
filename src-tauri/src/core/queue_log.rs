//! Durable unsent input. Recovery is explicit; app startup never replays model work automatically.
use super::{storage, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf, sync::Mutex};
pub struct QueueLog {
    path: PathBuf,
    db: Mutex<Option<Connection>>,
}
impl QueueLog {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            db: Mutex::new(None),
        }
    }
    fn db<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        if db.is_none() {
            std::fs::create_dir_all(self.path.parent().ok_or("Invalid queue path")?)
                .map_err(|e| e.to_string())?;
            let c = Connection::open(&self.path).map_err(|e| e.to_string())?;
            c.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA cache_size=-1024;CREATE TABLE IF NOT EXISTS queued(ticket TEXT PRIMARY KEY,owner TEXT,provider TEXT,role TEXT,created INTEGER,body TEXT);CREATE TABLE IF NOT EXISTS roles(alias TEXT PRIMARY KEY,role TEXT NOT NULL);").map_err(|e|e.to_string())?;
            *db = Some(c);
        }
        f(db.as_mut().unwrap())
    }
    pub fn role(&self, chat: &str, session: &str) -> Result<Option<String>, String> {
        self.db(|db|{
        let result:Option<String>=db.query_row("SELECT role FROM roles WHERE alias=?1 OR alias=?2 ORDER BY CASE WHEN alias=?1 THEN 0 ELSE 1 END LIMIT 1",params![format!("chat:{chat}"),format!("session:{session}")],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if result.as_deref().is_some_and(|r|!["executor","reviewer","researcher"].contains(&r)){return Err("Stored agent role is invalid".into())}Ok(result)
    })
    }
    pub fn set_role(
        &self,
        chat: &str,
        provider: &str,
        sid: &str,
        role: &str,
    ) -> Result<(), String> {
        if !["executor", "reviewer", "researcher"].contains(&role) {
            return Err("Unknown agent role".into());
        }
        self.db(|db| {
            let tx = db.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO roles(alias,role) VALUES(?1,?2)",
                params![format!("chat:{chat}"), role],
            )
            .map_err(|e| e.to_string())?;
            if !sid.is_empty() {
                tx.execute(
                    "INSERT OR REPLACE INTO roles(alias,role) VALUES(?1,?2)",
                    params![format!("session:{provider}:{sid}"), role],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })
    }
    pub fn put(
        &self,
        ticket: &str,
        owner: &str,
        provider: &str,
        role: &str,
        messages: &[Value],
    ) -> Result<(), String> {
        self.db(|db|{let count:i64=db.query_row("SELECT COUNT(*) FROM queued",[],|r|r.get(0)).map_err(|e|e.to_string())?;let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM queued WHERE ticket=?1)",[ticket],|r|r.get(0)).map_err(|e|e.to_string())?;if count>=512&&!exists{return Err("Unsent input archive is full; recover or dismiss old entries first".into())}db.execute("INSERT INTO queued(ticket,owner,provider,role,created,body) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(ticket) DO UPDATE SET body=excluded.body",params![ticket,owner,provider,role,storage::now(),json!(messages).to_string()]).map_err(|e|e.to_string())?;Ok(())})
    }
    pub fn list(&self, busy: &HashSet<String>) -> CoreResult {
        self.db(|db|{let mut q=db.prepare("SELECT ticket,owner,provider,role,created,substr(json_extract(body,'$[0].text'),1,160),json_extract(body,'$[0].cwd'),length(CAST(body AS BLOB)) FROM queued ORDER BY created LIMIT 512").map_err(|e|e.to_string())?;let rows=q.query_map([],|r|Ok(json!({"ticket":r.get::<_,String>(0)?,"owner":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?,"role":r.get::<_,String>(3)?,"at":r.get::<_,u64>(4)?,"preview":r.get::<_,Option<String>>(5)?,"cwd":r.get::<_,Option<String>>(6)?,"bytes":r.get::<_,u64>(7)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;Ok(json!(rows.into_iter().filter(|r|!busy.contains(r["owner"].as_str().unwrap_or(""))).collect::<Vec<_>>()))})
    }
    pub fn get(&self, ticket: &str, owner: &str) -> CoreResult {
        self.db(|db| {
            let row: Option<(String, String, String)> = db
                .query_row(
                    "SELECT provider,role,body FROM queued WHERE ticket=?1",
                    [ticket],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let (provider, role, body) =
                row.ok_or("Unsent input was already delivered or dismissed")?;
            let messages: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
            db.execute(
                "UPDATE queued SET owner=?2 WHERE ticket=?1",
                params![ticket, owner],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"provider":provider,"role":role,"messages":messages}))
        })
    }
    pub fn delete(&self, ticket: &str) -> Result<(), String> {
        self.db(|db| {
            db.execute("DELETE FROM queued WHERE ticket=?1", [ticket])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
    pub fn cancel_owner(&self, owner: &str) -> Result<(), String> {
        self.db(|db| {
            db.execute("DELETE FROM queued WHERE owner=?1", [owner])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
    pub fn delivered(&self, p: &Value) -> Result<(), String> {
        if let Some(ticket) = p["_recoveryTicket"].as_str() {
            self.delete(ticket)?;
        }
        let Some(ticket) = p["_dispatchTicket"].as_str() else {
            return Ok(());
        };
        self.db(|db| {
            let body: Option<String> = db
                .query_row("SELECT body FROM queued WHERE ticket=?1", [ticket], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(body) = body {
                let mut messages: Vec<Value> =
                    serde_json::from_str(&body).map_err(|e| e.to_string())?;
                messages.retain(|m| m["_queuedMessage"] != p["_queuedMessage"]);
                if messages.is_empty() {
                    db.execute("DELETE FROM queued WHERE ticket=?1", [ticket])
                        .map_err(|e| e.to_string())?;
                } else {
                    db.execute(
                        "UPDATE queued SET body=?2 WHERE ticket=?1",
                        params![ticket, json!(messages).to_string()],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_ownership_follows_task_across_provider_aliases_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.sqlite3");
        {
            let log = QueueLog::new(path.clone());
            log.set_role("scope:task", "claude", "old", "researcher")
                .unwrap();
            log.set_role("scope:task", "codex", "new", "researcher")
                .unwrap();
            log.set_role("scope:task", "codex", "new", "executor")
                .unwrap();
            assert_eq!(
                log.role("scope:task", "claude:old").unwrap().as_deref(),
                Some("executor")
            );
            log.set_role("scope:task", "codex", "new", "reviewer")
                .unwrap();
        }
        let reopened = QueueLog::new(path);
        assert_eq!(
            reopened
                .role("scope:task", "claude:old")
                .unwrap()
                .as_deref(),
            Some("reviewer")
        );
        assert_eq!(
            reopened
                .role("another-task", "codex:new")
                .unwrap()
                .as_deref(),
            Some("reviewer")
        );
        assert_eq!(reopened.role("another-task", "missing").unwrap(), None);
    }
}
