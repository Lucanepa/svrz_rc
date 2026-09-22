// The shell around the web app: it bundles dist-native/ and adds the three
// things the page cannot do from inside a webview — open a link in the system
// browser, update itself, and restart after an update. Everything else (the
// session, the offline cache) is the page's own work; see src/lib/native.ts.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_process::init());
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  builder
    .run(tauri::generate_context!())
    .expect("error while running the SVRZ RC app");
}
