use duet_native::core::NativeCore;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::Arc,
};
fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("fixture directory"));
    let home = std::env::var_os("DUET_DRIVER_HOME")
        .map(PathBuf::from)
        .unwrap_or(root.join("home"));
    let core = NativeCore::with_paths(
        root.join("data"),
        home.clone(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .into(),
        home.join(".claude/projects"),
        Arc::new(|channel, payload| {
            if std::env::var_os("DUET_DRIVER_EVENTS").is_some() {
                println!("{}", json!({"event":channel,"payload":payload}));
            }
        }),
    );
    for line in std::io::stdin().lock().lines() {
        let result = (|| {
            let request: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            core.invoke_from(
                "main",
                request["channel"].as_str().ok_or("missing channel")?,
                request["args"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            )
        })();
        println!(
            "{}",
            match result {
                Ok(value) => json!({"result":value}),
                Err(error) => json!({"error":error}),
            }
        );
        std::io::stdout().flush().unwrap();
    }
    core.shutdown();
}
