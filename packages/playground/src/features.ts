import type { FeatureDefinition } from "./protocol";

/** Selected capsules plus everything they depend on, in definition order. */
export function effectiveFeatures(definitions: readonly FeatureDefinition[], selected: ReadonlySet<string>): string[] {
  const enabled = new Set<string>();
  const visit = (id: string): void => {
    if (enabled.has(id)) return;
    enabled.add(id);
    definitions.find(definition => definition.id === id)?.dependencies.forEach(visit);
  };
  selected.forEach(visit);
  return definitions.map(definition => definition.id).filter(id => enabled.has(id));
}

export function renderFeaturePanel(
  container: HTMLElement,
  definitions: readonly FeatureDefinition[],
  getSelected: () => ReadonlySet<string>,
  onToggle: (id: string, checked: boolean) => void,
) {
  const inputs = new Map<string, HTMLInputElement>();
  for (const definition of definitions) {
    const label = document.createElement("label");
    label.className = "feature";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.onchange = () => onToggle(definition.id, input.checked);
    const name = document.createElement("span");
    name.className = "feature-name";
    name.textContent = definition.name;
    const description = document.createElement("span");
    description.className = "feature-description";
    description.textContent = definition.description ?? "Independent compiler and editor capsule.";
    label.append(input, name, description);
    container.append(label);
    inputs.set(definition.id, input);
  }

  return function refresh(): void {
    const selected = getSelected();
    const effective = new Set(effectiveFeatures(definitions, selected));
    for (const definition of definitions) {
      const input = inputs.get(definition.id)!;
      const implied = effective.has(definition.id) && !selected.has(definition.id);
      input.checked = effective.has(definition.id);
      input.disabled = implied;
      const requiredBy = definitions.filter(candidate =>
        selected.has(candidate.id)
        && candidate.id !== definition.id
        && effectiveFeatures(definitions, new Set([candidate.id])).includes(definition.id)
      );
      input.parentElement!.title = implied ? `Required by ${requiredBy.map(candidate => candidate.name).join(", ")}` : "";
      input.parentElement!.classList.toggle("implied", implied);
    }
  };
}
