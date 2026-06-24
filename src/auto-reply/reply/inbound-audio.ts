import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { FinalizedMsgContext } from "../templating.js";

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeMediaType(value: string): string {
  return normalizeOptionalLowercaseString(value.split(";")[0]) ?? "";
}

export function isInboundAudioContext(
  ctx: Pick<
    FinalizedMsgContext,
    "MediaType" | "MediaTypes" | "BodyForCommands" | "CommandBody" | "RawBody" | "Body"
  >,
): boolean {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
}

export function hasInboundAudioTranscript(
  ctx: Pick<FinalizedMsgContext, "Transcript" | "MediaTranscribedIndexes" | "MediaUnderstanding">,
): boolean {
  if (hasText(ctx.Transcript)) {
    return true;
  }
  if (Array.isArray(ctx.MediaTranscribedIndexes) && ctx.MediaTranscribedIndexes.length > 0) {
    return true;
  }
  return (
    Array.isArray(ctx.MediaUnderstanding) &&
    ctx.MediaUnderstanding.some(
      (entry) => entry.kind === "audio.transcription" && hasText(entry.text),
    )
  );
}
