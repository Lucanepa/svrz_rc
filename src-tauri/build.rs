fn main() {
  // The in-app plugins declare their commands, so capabilities can allow them
  // as passkey:allow-create, push:allow-subscribe and so on: passkeys
  // (src/passkey.rs) and phone notifications (src/push.rs).
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .plugin(
        "passkey",
        tauri_build::InlinedPlugin::new().commands(&["create", "get"]),
      )
      .plugin(
        "push",
        tauri_build::InlinedPlugin::new().commands(&["state", "subscribe", "unsubscribe", "take_open_url"]),
      ),
  )
  .expect("failed to run tauri-build");
}
