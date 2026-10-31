use base64::Engine;
use serde_json::{json, Value};
use std::{
    io::Cursor,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;
type Output = Arc<Mutex<Option<oneshot::Sender<Result<Vec<u8>, String>>>>>;
fn finish(out: &Output, result: Result<Vec<u8>, String>) {
    if let Some(tx) = out.lock().unwrap().take() {
        let _ = tx.send(result);
    }
}

/// Capture this webview, never the desktop or surrounding chat window.
pub async fn capture(view: &tauri::Webview) -> Result<Value, String> {
    let (tx, rx) = oneshot::channel();
    let out: Output = Arc::new(Mutex::new(Some(tx)));
    #[cfg(windows)]
    {
        let callback = out.clone();
        view.with_webview(move |native| {
            use webview2_com::{
                CapturePreviewCompletedHandler,
                Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            };
            use windows::Win32::{
                System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET},
                UI::Shell::SHCreateMemStream,
            };
            let start = (|| -> windows::core::Result<()> {
                unsafe {
                    let webview = native.controller().CoreWebView2()?;
                    let stream =
                        SHCreateMemStream(None).ok_or_else(windows::core::Error::from_thread)?;
                    let saved = stream.clone();
                    let completed = callback.clone();
                    let handler = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                        let data = (|| -> windows::core::Result<Vec<u8>> {
                            status?;
                            let mut stat = STATSTG::default();
                            saved.Stat(&mut stat, STATFLAG_NONAME)?;
                            if stat.cbSize > 32 * 1024 * 1024 {
                                return Err(windows::core::Error::from_hresult(
                                    windows::core::HRESULT(0x8007000Eu32 as i32),
                                ));
                            }
                            saved.Seek(0, STREAM_SEEK_SET, None)?;
                            let mut bytes = vec![0; stat.cbSize as usize];
                            let mut read = 0;
                            saved
                                .Read(
                                    bytes.as_mut_ptr().cast(),
                                    bytes.len() as u32,
                                    Some(&mut read),
                                )
                                .ok()?;
                            bytes.truncate(read as usize);
                            Ok(bytes)
                        })();
                        finish(&completed, data.map_err(|e| e.to_string()));
                        Ok(())
                    }));
                    webview.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &handler,
                    )
                }
            })();
            if let Err(e) = start {
                finish(&callback, Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let callback = out.clone();
        view.with_webview(move |native| {
            use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
            native.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let png = result.map_err(|e| e.to_string()).and_then(|surface| {
                        let mut bytes = Vec::new();
                        surface
                            .write_to_png(&mut bytes)
                            .map_err(|e| e.to_string())?;
                        Ok(bytes)
                    });
                    finish(&callback, png);
                },
            );
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    finish(
        &out,
        Err("Capture is supported on Windows and Linux".into()),
    );
    let png = tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| "Page capture timed out")?
        .map_err(|_| "Page capture was cancelled")??;
    let image = image::load_from_memory(&png).map_err(|e| e.to_string())?;
    let image = if image.width() > 1280 {
        image.resize(1280, u32::MAX, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let width = image.width();
    let height = image.height();
    let mut encoded = Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"width":width,"height":height,"png":base64::engine::general_purpose::STANDARD.encode(encoded.into_inner())}),
    )
}
