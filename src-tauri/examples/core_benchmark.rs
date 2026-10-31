//! Isolated core-only search benchmark: no WebView, Node, CLI, credentials or user transcripts.
use duet_native::core::NativeCore;
use serde_json::json;
use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    sync::Arc,
    time::{Duration, Instant},
};
fn main() {
    let count = std::env::args()
        .nth(1)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20000)
        .clamp(1, 100000);
    let root = tempfile::tempdir().unwrap();
    let projects = root.path().join("transcripts/project");
    fs::create_dir_all(&projects).unwrap();
    let body = format!("Пример native-core-index-marker {}", "x".repeat(1950));
    let mut bytes = 0usize;
    for session in 0..50 {
        let mut file =
            BufWriter::new(File::create(projects.join(format!("s{session}.jsonl"))).unwrap());
        for n in (session..count).step_by(50) {
            let line=serde_json::to_vec(&json!({"type":"user","uuid":format!("m{n}"),"cwd":"/synthetic","timestamp":"2026-10-30T10:00:00Z","message":{"content":body}})).unwrap();
            file.write_all(&line).unwrap();
            file.write_all(b"\n").unwrap();
            bytes += line.len() + 1;
        }
    }
    let core = NativeCore::new(
        root.path().join("data"),
        root.path().join("transcripts"),
        Arc::new(|_, _| {}),
    );
    let started = Instant::now();
    let result = core
        .invoke(
            "search:query",
            &[json!({"q":"native-core-index-marker ПРИМЕР","limit":60})],
        )
        .unwrap();
    assert_eq!(result.as_array().unwrap().len(), count.min(60));
    println!(
        "{}",
        json!({"ready":true,"pid":std::process::id(),"fixtureMessages":count,"fixtureBytes":bytes,"results":result.as_array().unwrap().len(),"indexAndQueryMs":started.elapsed().as_millis(),"core":core.invoke("desk:native-core",&[]).unwrap()})
    );
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(5));
}
