import type { FeatureDefinition } from "./protocol";

export const features: readonly FeatureDefinition[] = [
  { id: "modern-syntax", name: "Modern syntax" },
  { id: "nominal-types", name: "Nominal and tagged-union types" },
  { id: "type-computation", name: "Type computation" },
  { id: "higher-kinded-types", name: "Higher-kinded types" },
  { id: "static-interface-members", name: "Static interface members" },
  { id: "type-system/dependent-types", name: "Dependent types" },
  { id: "formal-verification/z3", name: "Z3 formal verification", dependencies: ["nominal-types"] },
  { id: "macros", name: "Compile-time macros" },
];

export function effectiveFeatures(selected: ReadonlySet<string>): readonly string[] {
  const enabled = new Set<string>();
  const visit = (id: string): void => {
    if (enabled.has(id)) return;
    enabled.add(id);
    features.find(feature => feature.id === id)?.dependencies?.forEach(visit);
  };
  selected.forEach(visit);
  return features.map(feature => feature.id).filter(id => enabled.has(id));
}
