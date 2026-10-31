/// Grant audio input to the local app UI, preserving the original audio-only policy.
pub fn configure(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|native| {
        #[cfg(windows)]
        unsafe {
            use webview2_com::{
                Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler,
            };
            if let Ok(core) = native.controller().CoreWebView2() {
                let callback = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                        args.PermissionKind(&mut kind)?;
                        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                        } else if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        }
                    }
                    Ok(())
                }));
                let mut token = 0;
                let _ = core.add_PermissionRequested(&callback, &mut token);
            }
        }
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::{
                glib::prelude::Cast, PermissionRequestExt, UserMediaPermissionRequest,
                UserMediaPermissionRequestExt, WebViewExt,
            };
            native.inner().connect_permission_request(|_, request| {
                if let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() {
                    if media.is_for_audio_device() && !media.is_for_video_device() {
                        request.allow();
                    } else {
                        request.deny();
                    }
                    true
                } else {
                    false
                }
            });
        }
    });
}
