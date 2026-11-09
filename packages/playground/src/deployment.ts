/**
 * Where this build sits in the site that serves it. The playground site redirects its root to the latest stable release,
 * serves branch previews and releases, and keeps shared files such as Z3 at the root. Each build ships
 * `deployment.json` naming its own directory as the shared root; assembling the site rewrites it, and adds the
 * `versions.json` that lists what the site serves. Without them, as on the development server or in a release's zip
 * served on its own, the build stands alone: no other versions, and shared files beside the page.
 */
export interface Deployment {
  /** The site's root, where the shared files and `versions.json` are. */
  readonly root: URL;
  /** What the site serves, or undefined when this build stands alone. */
  readonly versions?: SiteVersions;
}

export interface SiteVersions {
  /** The stable release the site's root redirects to, or null before one is available. */
  readonly latest: string | null;
  /** The branch previews published on this site. */
  readonly branches: readonly ("master" | "dev")[];
  /** Every release the site serves, newest first. */
  readonly releases: readonly string[];
}

export const currentVersion = __TSPP_PLAYGROUND_CHANNEL__ === "release" ? __TSPP_VERSION__ : __TSPP_PLAYGROUND_CHANNEL__;

async function readJson(url: URL): Promise<unknown> {
  try {
    const response = await fetch(url, { cache: "no-cache" });
    return response.ok ? await response.json() : undefined;
  }
  catch {
    return undefined;
  }
}

function siteVersions(value: unknown): SiteVersions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { latest, branches, releases } = value as Record<string, unknown>;
  if (!Array.isArray(branches) || !Array.isArray(releases) || !releases.every(release => typeof release === "string")) return undefined;
  return {
    latest: typeof latest === "string" ? latest : null,
    branches: branches.filter(branch => branch === "master" || branch === "dev"),
    releases,
  };
}

let deployment: Promise<Deployment> | undefined;

export function findDeployment(): Promise<Deployment> {
  return deployment ??= (async () => {
    const page = new URL(document.baseURI);
    const { sharedRoot } = (await readJson(new URL("deployment.json", page)) ?? {}) as { sharedRoot?: unknown };
    const root = typeof sharedRoot === "string" ? new URL(sharedRoot, page) : page;
    return { root, versions: siteVersions(await readJson(new URL("versions.json", root))) };
  })();
}

/** The branch or release URL, independent of the version served by the site root. */
export function versionPage({ root }: Deployment, version: string): URL {
  return new URL(version === "master" || version === "dev" ? `${version}/` : `v/${version}/`, root);
}

/** The Z3 this build was made with, in the deployment's shared files. */
export async function z3Location(): Promise<{ workerUrl: string; wasmUrl: string }> {
  const z3 = new URL(`${__TSPP_Z3_DIRECTORY__}/`, (await findDeployment()).root);
  return { workerUrl: new URL("z3.worker.js", z3).href, wasmUrl: new URL("z3-built.wasm", z3).href };
}
