/**
 * Where the deployment that serves this build keeps the files several playground builds share, such as Z3. A build
 * ships `deployment.json` naming its own directory; a deployment that collects shared files from several builds into
 * one place rewrites it. Without the file, as on the development server, the shared files sit beside the page.
 */
async function sharedRoot(): Promise<URL> {
  const page = new URL(document.baseURI);
  try {
    const response = await fetch(new URL("deployment.json", page), { cache: "no-cache" });
    if (!response.ok) return page;
    const { sharedRoot } = await response.json() as { sharedRoot?: unknown };
    return typeof sharedRoot === "string" ? new URL(sharedRoot, page) : page;
  }
  catch {
    return page;
  }
}

/** The Z3 this build was made with, in the deployment's shared files. */
export async function z3Location(): Promise<{ workerUrl: string; wasmUrl: string }> {
  const z3 = new URL(`${__TSPP_Z3_DIRECTORY__}/`, await sharedRoot());
  return { workerUrl: new URL("z3.worker.js", z3).href, wasmUrl: new URL("z3-built.wasm", z3).href };
}
