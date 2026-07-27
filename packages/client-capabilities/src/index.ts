import type { PublicClientCapabilities } from "@agentmesh/creatorcut-protocol";

export function buildPublicClientCapabilities(
  hostType: PublicClientCapabilities["host_type"],
  clientVersion = "0.1.0",
): PublicClientCapabilities {
  const rich = hostType === "codex";
  return {
    schema_version: "1.0",
    client_version: clientVersion,
    host_type: hostType,
    protocol_versions: ["1.0"],
    card_types: rich
      ? ["single", "multi", "text", "visual", "voice", "review"]
      : ["single", "multi", "text", "review"],
    operation_types: [
      "trim",
      "split",
      "remove_range",
      "concat",
      "set_gain",
      "add_caption",
      "set_canvas",
      "apply_lut",
      "move_clip",
      "add_clip",
      "clear_track",
      "clear_captions",
      "clear_lut",
    ],
    supports_visual_previews: rich,
    supports_voice_preview: rich,
    max_payload_bytes: 1_048_576,
  };
}
