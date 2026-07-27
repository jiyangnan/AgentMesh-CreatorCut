import type {
  LocalMediaAsset,
  LocalTimelineClip,
  LocalTimelineTrack,
} from "./types.js";

export function localAssetWireRef(asset: LocalMediaAsset | string): string {
  return typeof asset === "string" ? asset : asset.asset_id;
}

export function localTrackWireRef(track: LocalTimelineTrack): string {
  return track.track_id;
}

export function localClipWireRef(clip: LocalTimelineClip): string {
  return clip.clip_id;
}
