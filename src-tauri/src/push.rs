// Phone notifications in the installed Android app. The app's web view has no
// service worker and no Push API, so the subscription comes from
// gen/android/…/PushPlugin.kt (UnifiedPush: a distributor app such as ntfy, or
// Google's push through Play services) and the page registers it with the API
// exactly like a browser's (src/lib/push.ts). The API's Web Push reaches it
// unchanged.
//
// Android only. Elsewhere every command answers "unsupported" and the page
// never calls them (nativePushPossible()).

use serde_json::Value;
use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
};

/// What the page gets back when Android says no: a code it can act on
/// (`denied`, `no-distributor`, `distributor-silent`, `unsupported`, `error`)
/// and a message (for `distributor-silent`: that app's name).
#[derive(Debug, serde::Serialize)]
pub struct PushError {
  code: String,
  message: String,
}

#[cfg(target_os = "android")]
struct Handle<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
async fn ask<R: Runtime>(app: &tauri::AppHandle<R>, command: &str, args: Value) -> Result<Value, PushError> {
  use tauri::Manager;
  let handle = app.state::<Handle<R>>();
  handle
    .0
    .run_mobile_plugin_async::<Value>(command, args)
    .await
    .map_err(|error| match error {
      tauri::plugin::mobile::PluginInvokeError::InvokeRejected(rejected) => PushError {
        code: rejected.code.unwrap_or_else(|| "error".into()),
        message: rejected.message.unwrap_or_default(),
      },
      other => PushError { code: "error".into(), message: other.to_string() },
    })
}

#[cfg(not(target_os = "android"))]
async fn ask<R: Runtime>(_app: &tauri::AppHandle<R>, _command: &str, _args: Value) -> Result<Value, PushError> {
  Err(PushError { code: "unsupported".into(), message: "phone notifications are Android-only in the app".into() })
}

/// `{ permission, subscription | null, distributor | null }`.
#[tauri::command]
async fn state<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Value, PushError> {
  ask(&app, "state", Value::Object(Default::default())).await
}

/// Ask for the permission, register with a push service, answer `{ subscription }`.
#[tauri::command]
async fn subscribe<R: Runtime>(app: tauri::AppHandle<R>, vapid_public_key: String) -> Result<Value, PushError> {
  ask(&app, "subscribe", serde_json::json!({ "vapidPublicKey": vapid_public_key })).await
}

#[tauri::command]
async fn unsubscribe<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Value, PushError> {
  ask(&app, "unsubscribe", Value::Object(Default::default())).await
}

/// The page a notification tap asked for (`{ url | null }`), handed over once.
#[tauri::command]
async fn take_open_url<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Value, PushError> {
  ask(&app, "takeOpenUrl", Value::Object(Default::default())).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("push")
    .invoke_handler(tauri::generate_handler![state, subscribe, unsubscribe, take_open_url])
    .setup(|_app, _api| {
      #[cfg(target_os = "android")]
      {
        use tauri::Manager;
        let handle = _api.register_android_plugin("app.openvolley.svrzrc", "PushPlugin")?;
        _app.manage(Handle(handle));
      }
      Ok(())
    })
    .build()
}
