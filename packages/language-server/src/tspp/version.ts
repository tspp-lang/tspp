/**
 * A released ts-plus-plus package is versioned as TS++, so it names the TypeScript version it implements separately;
 * that is the version the features offered depend on. Returns the manifest as upstream reads it, with that version.
 */
export function typeScriptManifest(manifest: unknown): { version?: string; } {
    const { version, typescriptVersion } = (manifest ?? {}) as { version?: string; typescriptVersion?: string; };
    return { version: typescriptVersion ?? version };
}
