// The installed app's side of the clips (src-tauri/src/clipfiles.rs): the
// videos on a plugged-in camera or SD card, copied into the app's own folder
// and played from there. The web app keeps its clips in IndexedDB instead
// (lib/clips.ts); a desktop folder holds 4K video a webview's storage will not.
//
// Every call goes to a command of the installed app: imported only there.

import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export type MediaFile = { path: string; name: string; size: number; modified: number };

/** The recent videos on every plugged-in card (DCIM). */
export const cameraMedia = (): Promise<MediaFile[]> => invoke<MediaFile[]>('camera_media');

/** Copies a card's video in as the clip's file; answers where it now is. */
export const importClipFile = (src: string, clipId: string, proxy: boolean): Promise<string> =>
  invoke<string>('import_clip_file', { src, clipId, proxy });

export const deleteClipFiles = (clipId: string): Promise<void> => invoke<void>('delete_clip_files', { clipId });

/** Deletes every file in the folder whose clip is not in `keep`. */
export const pruneClipFiles = (keep: string[]): Promise<number> => invoke<number>('prune_clip_files', { keep });

/** A copy in the Downloads folder; answers its path. */
export const saveClipFile = (clipId: string, fileName: string): Promise<string> =>
  invoke<string>('save_clip_file', { clipId, fileName });

/** What a <video> plays a file of the folder from. */
export const clipFileUrl = (path: string): string => convertFileSrc(path);
