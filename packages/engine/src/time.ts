/** Parse a relative duration or ISO timestamp into epoch nanoseconds. */
export function parseSinceNano(since: string | undefined | null): string | null {
  if (!since?.trim()) { return null; }
  const s = since.trim();

  const rel = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(s);
  if (rel) {
    const n    = parseFloat(rel[1]!);
    const unit = rel[2]!.toLowerCase();
    const offsetMs = unit === 's' ? n * 1_000
                   : unit === 'm' ? n * 60_000
                   : unit === 'h' ? n * 3_600_000
                   :                n * 86_400_000;
    return msToNanoString(Date.now() - offsetMs);
  }

  const ts = Date.parse(s);
  if (!isNaN(ts)) { return msToNanoString(ts); }

  return null;
}

/** Parse an upper time bound using the same syntax as `parseSinceNano`. */
export function parseUntilNano(until: string | undefined | null): string | null {
  return parseSinceNano(until);
}

function msToNanoString(ms: number): string {
  // Avoid floating-point precision loss.
  return Math.floor(ms).toString().padStart(13, '0') + '000000';
}
