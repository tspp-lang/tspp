import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import type { ProjectFiles } from "./protocol";

/** Playground state carried in the URL hash: `#features=a,b&file=/index.tspp&files=<lz-string JSON>`. */
export interface SharedState {
  readonly files: ProjectFiles;
  readonly features: readonly string[];
  /** The file shown in the editor. */
  readonly active: string;
}

export function encodeState(state: SharedState): string {
  const params = new URLSearchParams();
  params.set("features", state.features.join(","));
  params.set("file", state.active);
  params.set("files", compressToEncodedURIComponent(JSON.stringify(state.files)));
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
  return { files: files as ProjectFiles, features, active: file && paths.includes(file) ? file : paths[0] };
}
