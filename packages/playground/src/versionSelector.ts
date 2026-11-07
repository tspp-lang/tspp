import { currentVersion, findDeployment, versionPage } from "./deployment";

/** Lists the versions the site serves and opens the chosen one with the current project. Hidden outside such a site. */
export async function setupVersionSelector(select: HTMLSelectElement, hasUnsavedChanges: () => boolean): Promise<void> {
  const deployment = await findDeployment();
  const { versions } = deployment;
  if (!versions) return;
  const option = (value: string, label: string) => Object.assign(document.createElement("option"), { value, textContent: label });
  select.replaceChildren(
    option("next", "Next (master)"),
    ...versions.releases.map(release => option(release, release === versions.latest ? `${release} (latest)` : release)),
  );
  select.value = currentVersion;
  select.hidden = false;
  select.onchange = () => {
    if (hasUnsavedChanges() && !confirm("Discard all unsaved changes and open another version?")) {
      select.value = currentVersion;
      return;
    }
    // The hash carries the saved project.
    location.href = versionPage(deployment, select.value).href + location.hash;
  };
}

/**
 * The link that shares the current project on this version for good: a release's `v/<version>/` page even when this
 * is the site's root, which moves to each new release, or `next/`. A build that stands alone shares its own address.
 */
export async function pinnedShareLink(): Promise<string> {
  const deployment = await findDeployment();
  return deployment.versions ? versionPage(deployment, currentVersion).href + location.hash : location.href;
}
