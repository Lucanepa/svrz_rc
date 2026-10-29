// The notebook's clips on the computer's disk (src/lib/clipFiles.ts).
//
// After a match the coach plugs in the camera (it shows up as a drive) or its
// SD card. The page asks every few seconds for the videos on any plugged-in
// card (`camera_media`), matches them to the clips still waiting for one, and
// has the matched files copied into the app's own folder (`import_clip_file`),
// where the page plays them through the asset protocol. A 4K clip is 100-150
// MB: too much for the webview's storage, nothing for a disk.
//
// Only files under a card's DCIM folder can be copied in, only into
// <app data>/clips, and only under the clip's own id; the asset protocol's
// scope is that folder alone (tauri.conf.json).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const VIDEO_EXTS: [&str; 3] = ["mp4", "lrf", "mov"];
/// A clip lives a week; older files on a card cannot be one of them.
const RECENT: Duration = Duration::from_secs(8 * 24 * 60 * 60);
const MAX_FILES: usize = 4000;

#[derive(Serialize)]
pub struct MediaFile {
  path: String,
  name: String,
  size: u64,
  /// Epoch milliseconds: the card's file time, the end of the recording.
  modified: u64,
}

/// Where removable drives are mounted on this computer.
fn volume_roots() -> Vec<PathBuf> {
  let mut roots = Vec::new();
  #[cfg(target_os = "linux")]
  {
    let user = std::env::var("USER").unwrap_or_default();
    for base in [format!("/media/{user}"), format!("/run/media/{user}"), "/media".to_string()] {
      if let Ok(entries) = fs::read_dir(&base) {
        for e in entries.flatten() {
          let p = e.path();
          if p.is_dir() { roots.push(p); }
        }
      }
    }
  }
  #[cfg(target_os = "macos")]
  {
    if let Ok(entries) = fs::read_dir("/Volumes") {
      for e in entries.flatten() { roots.push(e.path()); }
    }
  }
  #[cfg(target_os = "windows")]
  {
    for letter in b'D'..=b'Z' {
      let p = PathBuf::from(format!("{}:\\", letter as char));
      if p.join("DCIM").is_dir() { roots.push(p); }
    }
  }
  roots
}

fn dcim_of(volume: &Path) -> Option<PathBuf> {
  fs::read_dir(volume).ok()?.flatten().map(|e| e.path()).find(|p| {
    p.is_dir() && p.file_name().and_then(|n| n.to_str()).map(|n| n.eq_ignore_ascii_case("DCIM")).unwrap_or(false)
  })
}

fn is_video(p: &Path) -> bool {
  p.extension().and_then(|e| e.to_str()).map(|e| VIDEO_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x))).unwrap_or(false)
}

fn millis(t: SystemTime) -> u64 {
  t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The recent videos on every plugged-in card: DCIM and the folders in it.
#[tauri::command]
pub async fn camera_media() -> Vec<MediaFile> {
  tauri::async_runtime::spawn_blocking(|| {
    let mut out = Vec::new();
    let now = SystemTime::now();
    for volume in volume_roots() {
      let Some(dcim) = dcim_of(&volume) else { continue };
      let mut dirs = vec![dcim.clone()];
      if let Ok(entries) = fs::read_dir(&dcim) {
        dirs.extend(entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()));
      }
      for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
          let p = e.path();
          if !is_video(&p) { continue; }
          let Ok(meta) = e.metadata() else { continue };
          if !meta.is_file() { continue; }
          let modified = meta.modified().unwrap_or(UNIX_EPOCH);
          if now.duration_since(modified).map(|age| age > RECENT).unwrap_or(false) { continue; }
          out.push(MediaFile {
            path: p.to_string_lossy().into_owned(),
            name: e.file_name().to_string_lossy().into_owned(),
            size: meta.len(),
            modified: millis(modified),
          });
          if out.len() >= MAX_FILES { return out; }
        }
      }
    }
    out
  })
  .await
  .unwrap_or_default()
}

fn clips_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("clips");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A file the page may copy in: a video, inside a card's DCIM folder.
fn on_a_card(src: &Path) -> bool {
  let Ok(real) = src.canonicalize() else { return false };
  if !real.is_file() || !is_video(&real) { return false; }
  volume_roots().iter().filter_map(|v| dcim_of(v)).filter_map(|d| d.canonicalize().ok()).any(|d| real.starts_with(&d))
}

/// Copies a card's video into the app's folder as the clip's own file
/// (`<id>.mp4`, or `<id>.proxy.mp4` for DJI's small .LRF copy of it) and
/// answers where it is.
#[tauri::command]
pub async fn import_clip_file(app: AppHandle, src: String, clip_id: String, proxy: bool) -> Result<String, String> {
  if !valid_id(&clip_id) { return Err("bad clip id".into()); }
  let src = PathBuf::from(src);
  if !on_a_card(&src) { return Err("not a video on a card".into()); }
  let ext = if proxy { "proxy.mp4".to_string() } else {
    match src.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
      Some(e) if e == "mov" => "mov".to_string(),
      _ => "mp4".to_string(),
    }
  };
  let dest = clips_dir(&app)?.join(format!("{clip_id}.{ext}"));
  let to = dest.clone();
  tauri::async_runtime::spawn_blocking(move || fs::copy(&src, &to).map(|_| ()))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
  Ok(dest.to_string_lossy().into_owned())
}

fn files_of(dir: &Path, clip_id: &str) -> Vec<PathBuf> {
  let prefix = format!("{clip_id}.");
  fs::read_dir(dir).map(|it| it.flatten().map(|e| e.path()).filter(|p| {
    p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with(&prefix)).unwrap_or(false)
  }).collect()).unwrap_or_default()
}

/// The clip's files go with the clip.
#[tauri::command]
pub fn delete_clip_files(app: AppHandle, clip_id: String) -> Result<(), String> {
  if !valid_id(&clip_id) { return Err("bad clip id".into()); }
  for p in files_of(&clips_dir(&app)?, &clip_id) { let _ = fs::remove_file(p); }
  Ok(())
}

/// Every file in the folder whose clip is not in `keep` (gone with its page
/// on another run, or left by a failed copy) is deleted.
#[tauri::command]
pub fn prune_clip_files(app: AppHandle, keep: Vec<String>) -> Result<u32, String> {
  let dir = clips_dir(&app)?;
  let mut removed = 0;
  for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
    let name = e.file_name().to_string_lossy().into_owned();
    let id = name.split('.').next().unwrap_or("");
    if !keep.iter().any(|k| k == id) && fs::remove_file(e.path()).is_ok() { removed += 1; }
  }
  Ok(removed)
}

/// "Speichern": a copy of the clip's video in the Downloads folder, under the
/// name the page gives it (made safe, and never over another file).
#[tauri::command]
pub async fn save_clip_file(app: AppHandle, clip_id: String, file_name: String) -> Result<String, String> {
  if !valid_id(&clip_id) { return Err("bad clip id".into()); }
  let dir = clips_dir(&app)?;
  let src = files_of(&dir, &clip_id).into_iter()
    .find(|p| !p.to_string_lossy().ends_with(".proxy.mp4"))
    .ok_or("no video for this clip")?;
  let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
  let clean: String = file_name.chars()
    .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { ' ' } else { c })
    .collect::<String>().trim().chars().take(120).collect();
  let clean = if clean.is_empty() { format!("{clip_id}.mp4") } else { clean };
  let (stem, ext) = match clean.rsplit_once('.') { Some((s, e)) => (s.to_string(), format!(".{e}")), None => (clean.clone(), String::new()) };
  let mut dest = downloads.join(&clean);
  let mut n = 2;
  while dest.exists() { dest = downloads.join(format!("{stem} ({n}){ext}")); n += 1; }
  let to = dest.clone();
  tauri::async_runtime::spawn_blocking(move || fs::copy(&src, &to).map(|_| ()))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
  Ok(dest.to_string_lossy().into_owned())
}
