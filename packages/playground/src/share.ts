import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import type { ProjectFiles } from "./protocol";

/** Playground state carried in the URL hash: `#features=a,b&file=/index.tspp&files=<lz-string JSON>`. */
export interface SharedState {
  readonly files: ProjectFiles;
  readonly features: readonly string[];
  /** The file shown in the editor. */
  readonly active: string;
  /** Explicit project directories, including empty ones. Non-empty directories are also inferred from files. */
  readonly directories?: readonly string[];
}

export function encodeState(state: SharedState): string {
  const params = new URLSearchParams();
  params.set("features", state.features.join(","));
  params.set("file", state.active);
  params.set("files", compressToEncodedURIComponent(JSON.stringify(state.files)));
  if (state.directories?.length) params.set("dirs", compressToEncodedURIComponent(JSON.stringify(state.directories)));
  // URLSearchParams escapes commas and slashes; the hash reads better without that
  return params.toString().replace(/%2C/g, ",").replace(/%2F/g, "/");
}

export function decodeState(hash: string): SharedState | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const compressed = params.get("files");
  if (compressed === null) return undefined;
  let files: unknown;
  try {
    files = JSON.parse(decompressFromEncodedURIComponent(compressed) ?? "");
  }
  catch {
    return undefined;
  }
  if (!files || typeof files !== "object" || !Object.values(files).every(text => typeof text === "string")) return undefined;
  const paths = Object.keys(files);
  if (!paths.length) return undefined;
  const features = (params.get("features") ?? "").split(",").map(name => name.trim()).filter(Boolean);
  const file = params.get("file");
  let directories: string[] | undefined;
  const compressedDirectories = params.get("dirs");
  if (compressedDirectories !== null) {
    try {
      const decoded: unknown = JSON.parse(decompressFromEncodedURIComponent(compressedDirectories) ?? "");
      if (Array.isArray(decoded) && decoded.every(directory => typeof directory === "string")) directories = decoded;
    }
    catch {
      // Invalid optional directory state does not make an otherwise valid shared project unusable.
    }
  }
  const sources = paths.filter(path => /\.(tspp|ts)$/.test(path));
  if (!sources.length) return undefined;
  return { files: files as ProjectFiles, features, active: file && paths.includes(file) ? file : sources[0], directories };
}
