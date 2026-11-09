import { currentVersion, findDeployment, versionPage } from "./deployment";

/** Lists the versions the site serves and opens the chosen one with the current project. Hidden outside such a site. */
export async function setupVersionSelector(select: HTMLSelectElement, hasUnsavedChanges: () => boolean): Promise<void> {
  const deployment = await findDeployment();
  const { versions } = deployment;
  if (!versions) return;
  const option = (value: string, label: string) => Object.assign(document.createElement("option"), { value, textContent: label });
  select.replaceChildren(
    ...versions.branches.map(branch => option(branch, branch === "dev" ? "Dev" : "Master")),
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
    location.href = versionPage(deployment, select.value).href + location.search + location.hash;
  };
}
