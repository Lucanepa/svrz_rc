fn main() {
  // The in-app passkey plugin (src/passkey.rs) declares its two commands, so
  // capabilities can allow them as passkey:allow-create / passkey:allow-get.
  tauri_build::try_build(
    tauri_build::Attributes::new().plugin(
      "passkey",
      tauri_build::InlinedPlugin::new().commands(&["create", "get"]),
    ),
  )
  .expect("failed to run tauri-build");
}
