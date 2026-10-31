use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-changed=../desktop/preload.js");
    println!("cargo:rerun-if-changed=../desktop/window-controls.js");
    let preload = fs::read_to_string("../desktop/preload.js").expect("native preload");
    let controls = fs::read_to_string("../desktop/window-controls.js").unwrap();
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("preload.js"),
        format!("{preload}\n{controls}"),
    )
    .unwrap();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["duet_invoke", "window_control"]),
    ))
    .unwrap();
}
