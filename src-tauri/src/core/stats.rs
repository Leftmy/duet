use super::{
    events::{arr, s},
    jsonl,
    storage::{self, Storage},
    CoreResult,
};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::BufReader};
pub fn summary(st: &Storage, days: u64) -> CoreResult {
    let since = storage::now().saturating_sub(days.clamp(1, 3650) * 86400000);
    let mut previous: HashMap<String, Value> = HashMap::new();
    let mut turns = vec![];
    let mut limits = vec![];
    let mut bytes = 0;
    for (name, out) in [
        ("stats-turns.jsonl", &mut turns),
        ("stats-limits.jsonl", &mut limits),
    ] {
        if let Ok(f) = fs::File::open(st.data.join(name)) {
            jsonl::scan(BufReader::new(f), 1024 * 1024, |line| {
                let Ok(mut r) = serde_json::from_slice::<Value>(line) else {
                    return Ok(());
                };
                let ts = r["ts"].as_u64().unwrap_or(0);
                if name == "stats-turns.jsonl" && r["delta"] != true {
                    if r["turns"].as_u64().unwrap_or(0) == 0 && arr(&r["models"]).is_empty() {
                        return Ok(());
                    }
                    let sid = s(&r, "sessionId").to_owned();
                    let old = previous.insert(sid, r.clone()).unwrap_or(Value::Null);
                    let cost = r["cost"].as_f64().unwrap_or(0.);
                    r["cost"] = json!((cost - old["cost"].as_f64().unwrap_or(0.)).max(0.));
                    let models = arr(&r["models"])
                        .iter()
                        .map(|m| {
                            let old = arr(&old["models"])
                                .iter()
                                .find(|p| p["model"] == m["model"]);
                            let mut delta = m.clone();
                            for k in ["input", "output", "cacheRead", "cacheWrite", "cost"] {
                                delta[k] = json!((m[k].as_f64().unwrap_or(0.)
                                    - old.map(|o| o[k].as_f64().unwrap_or(0.)).unwrap_or(0.))
                                .max(0.));
                            }
                            delta
                        })
                        .collect::<Vec<_>>();
                    r["models"] = json!(models);
                    r["delta"] = json!(true);
                    if previous.len() > 100000 {
                        return Err("Usage log has too many sessions".into());
                    }
                }
                if ts >= since {
                    bytes += line.len();
                    if bytes > 32 * 1024 * 1024 {
                        return Err("Usage response is too large; select fewer days".into());
                    }
                    out.push(r);
                }
                Ok(())
            })?;
        }
    }
    Ok(json!({"turns":turns,"limits":limits}))
}
