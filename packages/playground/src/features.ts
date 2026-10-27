import type { FeatureDefinition } from "./protocol";

/** Selected features plus everything they depend on, in definition order. */
export function effectiveFeatures(definitions: readonly FeatureDefinition[], selected: ReadonlySet<string>): string[] {
  const enabled = new Set<string>();
  const visit = (name: string) => {
    if (enabled.has(name)) return;
    enabled.add(name);
    definitions.find(d => d.name === name)?.dependencies.forEach(visit);
  };
  selected.forEach(visit);
  return definitions.map(d => d.name).filter(name => enabled.has(name));
}

/**
 * The feature checkbox list. A feature that is only on because a selected feature
 * depends on it is shown checked but disabled, with the features that need it.
 */
export function renderFeaturePanel(
  container: HTMLElement,
  definitions: readonly FeatureDefinition[],
  getSelected: () => ReadonlySet<string>,
  onToggle: (name: string, checked: boolean) => void,
) {
  const inputs = new Map<string, HTMLInputElement>();
  for (const definition of definitions) {
    const label = document.createElement("label");
    label.className = "feature";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.onchange = () => onToggle(definition.name, input.checked);
    const name = document.createElement("span");
    name.className = "feature-name";
    name.textContent = definition.name;
    const description = document.createElement("span");
    description.className = "feature-description";
    description.textContent = definition.initComments.join(" ");
    label.append(input, name, description);
    container.append(label);
    inputs.set(definition.name, input);
  }

  return function refresh() {
    const selected = getSelected();
    const effective = new Set(effectiveFeatures(definitions, selected));
    for (const definition of definitions) {
      const input = inputs.get(definition.name)!;
      const implied = effective.has(definition.name) && !selected.has(definition.name);
      input.checked = effective.has(definition.name);
      input.disabled = implied;
      const requiredBy = definitions.filter(d => selected.has(d.name) && effectiveFeatures(definitions, new Set([d.name])).includes(definition.name) && d.name !== definition.name);
      input.parentElement!.title = implied ? `Required by ${requiredBy.map(d => d.name).join(", ")}` : "";
      input.parentElement!.classList.toggle("implied", implied);
    }
  };
}
