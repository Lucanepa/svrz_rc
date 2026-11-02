// Passkeys in the installed Android app. The app's web view cannot hold a
// passkey for svrz-rc.openvolley.app (its pages live on tauri.localhost), so
// the page hands the server's WebAuthn options to Android's Credential Manager
// instead (gen/android/…/PasskeyPlugin.kt) and gets the device's answer back
// as the same JSON a browser would send. Android names the caller by the app's
// signing key, and public/.well-known/assetlinks.json is what tells Google the
// app may use the site's passkeys. See src/lib/passkeys.ts for the page side.
//
// Android only. Elsewhere the commands answer "unsupported" and the page never
// calls them (passkeysPossible()).

use serde::{Deserialize, Serialize};
use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
};

/// What the page gets back when Android says no: a code it can act on
/// (`cancelled`, `exists`, `none`, `no-provider`, `unsupported`, `error`) and
/// Android's own words for the log.
#[derive(Debug, Serialize)]
pub struct PasskeyError {
  code: String,
  message: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
  response_json: String,
}

#[cfg(target_os = "android")]
struct Handle<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
async fn ask<R: Runtime>(app: &tauri::AppHandle<R>, command: &str, request_json: String) -> Result<Answer, PasskeyError> {
  use tauri::Manager;
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  struct Ask {
    request_json: String,
  }
  let handle = app.state::<Handle<R>>();
  handle
    .0
    .run_mobile_plugin_async::<Answer>(command, Ask { request_json })
    .await
    .map_err(|error| match error {
      tauri::plugin::mobile::PluginInvokeError::InvokeRejected(rejected) => PasskeyError {
        code: rejected.code.unwrap_or_else(|| "error".into()),
        message: rejected.message.unwrap_or_default(),
      },
      other => PasskeyError { code: "error".into(), message: other.to_string() },
    })
}

#[cfg(not(target_os = "android"))]
async fn ask<R: Runtime>(_app: &tauri::AppHandle<R>, _command: &str, _request_json: String) -> Result<Answer, PasskeyError> {
  Err(PasskeyError { code: "unsupported".into(), message: "passkeys are Android-only in the app".into() })
}

/// Set up a passkey: `request_json` is the server's creation options.
#[tauri::command]
async fn create<R: Runtime>(app: tauri::AppHandle<R>, request_json: String) -> Result<Answer, PasskeyError> {
  ask(&app, "create", request_json).await
}

/// Sign in: `request_json` is the server's request options.
#[tauri::command]
async fn get<R: Runtime>(app: tauri::AppHandle<R>, request_json: String) -> Result<Answer, PasskeyError> {
  ask(&app, "get", request_json).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("passkey")
    .invoke_handler(tauri::generate_handler![create, get])
    .setup(|_app, _api| {
      #[cfg(target_os = "android")]
      {
        use tauri::Manager;
        let handle = _api.register_android_plugin("app.openvolley.svrzrc", "PasskeyPlugin")?;
        _app.manage(Handle(handle));
      }
      Ok(())
    })
    .build()
}
