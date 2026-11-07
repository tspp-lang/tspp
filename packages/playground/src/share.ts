import { deflateSync, inflateSync } from "fflate";
import type { ProjectFiles } from "./protocol";

/** Playground state carried in one URL hash: `#v2=<base64url-encoded DEFLATE JSON>`. */
export interface SharedState {
  readonly files: ProjectFiles;
  readonly features: readonly string[];
  /** The file shown in the editor. */
  readonly active: string;
  /** Files whose editor tabs are open, in display order. */
  readonly open?: readonly string[];
  /** Explicit project directories, including empty ones. Non-empty directories are also inferred from files. */
  readonly directories?: readonly string[];
}

export function encodeState(state: SharedState): string {
  const compressed = deflateSync(new TextEncoder().encode(JSON.stringify(state)));
  let binary = "";
  for (const byte of compressed) binary += String.fromCharCode(byte);
  return `v2=${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === "string");

export function decodeState(hash: string): SharedState | undefined {
  const payload = /^#?v2=([A-Za-z0-9_-]+)$/.exec(hash)?.[1];
  if (!payload) return undefined;
  let state: unknown;
  try {
    const binary = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    const compressed = Uint8Array.from(binary, char => char.charCodeAt(0));
    state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inflateSync(compressed)));
  }
  catch {
    return undefined;
  }
  if (!state || typeof state !== "object") return undefined;
  const { files, features, active: file, open, directories } = state as Record<string, unknown>;
  if (!isStringArray(features) || !files || typeof files !== "object" || Array.isArray(files)
    || !Object.values(files).every(text => typeof text === "string")) return undefined;
  const paths = Object.keys(files);
  const firstSource = paths.find(path => /\.(?:tspp|ts)$/.test(path));
  if (!firstSource) return undefined;
  const active = typeof file === "string" && Object.hasOwn(files, file) ? file : firstSource;
  const openFiles = isStringArray(open) ? open.filter(path => Object.hasOwn(files, path)) : [];
  return {
    files: files as ProjectFiles,
    features,
    active,
    open: openFiles.length ? [...new Set([...openFiles, active])] : undefined,
    directories: isStringArray(directories) ? directories : undefined,
  };
}

export function onSharedStateChange(listener: (state: SharedState) => void): void {
  window.addEventListener("hashchange", () => {
    const state = decodeState(location.hash);
    if (state) listener(state);
  });
}
