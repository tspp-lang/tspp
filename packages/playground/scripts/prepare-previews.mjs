// Selects the preview to update and restores the other preview from the last published Pages deployment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workflow = "Deploy playground to GitHub Pages";
const publishJob = "Publish playground site";
const artifact = "playground-preview";
const branches = ["master", "dev"];
const [directory] = process.argv.slice(2);
const { GITHUB_REPOSITORY, GITHUB_EVENT_PATH, PAGES_URL } = process.env;
if (!directory || !GITHUB_REPOSITORY || !GITHUB_EVENT_PATH || !PAGES_URL) {
  throw new Error("Usage: prepare-previews.mjs <directory> (requires the GitHub Actions event and Pages URL).");
}
const repo = `repos/${GITHUB_REPOSITORY}`;
const event = JSON.parse(await fs.readFile(GITHUB_EVENT_PATH, "utf8"));
const site = new URL(PAGES_URL.replace(/\/?$/, "/"));

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function api(endpoint, ...args) {
  return JSON.parse(gh(["api", `${repo}/${endpoint}`, ...args]));
}

async function fromSite(file) {
  const response = await fetch(new URL(`preview-builds/${file}`, site), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not restore published ${file}: HTTP ${response.status}.`);
  return response;
}

async function publishedPreviews() {
  const deployments = api("deployments?environment=github-pages&per_page=100", "--paginate", "--slurp").flat();
  for (const deployment of deployments) {
    const success = api(`deployments/${deployment.id}/statuses`).find(status => status.state === "success");
    if (!success) continue;
    const jobId = /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(success.log_url)?.[1];
    if (!jobId) throw new Error("The last successful Pages deployment has no Actions job.");
    const job = api(`actions/jobs/${jobId}`);
    if (job.workflow_name !== workflow) throw new Error(`Unrecognized Pages workflow '${job.workflow_name}'.`);
    if (job.name === "deploy") return {}; // The previous workflow did not store preview archives.
    if (job.name !== publishJob) throw new Error(`Unrecognized Pages job '${job.name}'.`);
    const previews = await (await fromSite(`${job.run_id}-${job.run_attempt}.json`)).json();
    if (!previews?.master) throw new Error("The published site is missing its Master preview metadata.");
    for (const name of branches.filter(name => Object.hasOwn(previews, name))) {
      const { run, digest } = previews[name] ?? {};
      if (!Number.isSafeInteger(run) || run < 1 || !/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`Invalid metadata for published ${name} preview.`);
      }
    }
    return previews;
  }
  return {};
}

function latestTestedPush(branch) {
  return api(`actions/workflows/tspp.yml/runs?branch=${branch}&event=push&status=success&per_page=1`).workflow_runs[0];
}

function hasPreview(run) {
  return run && api(`actions/runs/${run.id}/artifacts?name=${artifact}`).artifacts.some(entry => !entry.expired);
}

const published = await publishedPreviews();
const source = event.workflow_run;
const branch = source?.name === "TSPP" ? source.head_branch : event.inputs?.preview;
const updates = {};
if (branches.includes(branch)) {
  const run = source?.name === "TSPP" ? source : latestTestedPush(branch);
  if (!run) throw new Error(`No successful TSPP push run exists for ${branch}.`);
  updates[branch] = run;
}
if (!published.master && !updates.master) {
  throw new Error("Publish Master once before updating Dev or the release list.");
}
if (!published.master) {
  const run = latestTestedPush("dev");
  if (hasPreview(run)) updates.dev = run;
}

await fs.mkdir(directory, { recursive: true });
const runs = {};
for (const name of branches) {
  const previous = published[name];
  const update = updates[name];
  const target = path.join(directory, `${name}.zip`);
  if (update && (!previous || update.run_number > previous.run)) {
    const download = path.join(directory, name);
    gh(["run", "download", String(update.id), "--repo", GITHUB_REPOSITORY, "--name", artifact, "--dir", download]);
    await fs.rename(path.join(download, `${artifact}.zip`), target);
    runs[name] = update.run_number;
    console.log(`Publishing ${name} from TSPP run #${update.run_number}.`);
  }
  else if (previous) {
    const { run, digest } = previous;
    const zip = Buffer.from(await (await fromSite(`${name}-${digest}.zip`)).arrayBuffer());
    if (createHash("sha256").update(zip).digest("hex") !== digest) throw new Error(`Published ${name} preview does not match its checksum.`);
    await fs.writeFile(target, zip);
    runs[name] = run;
    console.log(`Keeping the published ${name} from TSPP run #${run}.`);
  }
}
await fs.writeFile(path.join(directory, "runs.json"), JSON.stringify(runs) + "\n");
