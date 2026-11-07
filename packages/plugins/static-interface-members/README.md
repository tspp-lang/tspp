# `ts-plus-plus/plugins/static-interface-members`

Adds static-side contracts to TS++ interfaces. A class that `implements` such
an interface must satisfy both its normal instance contract and its static
constructor contract.

```ts
interface Serializable {
  static deserialize(text: string): this;
  serialize(): string;
}
```

The plugin deliberately keeps the interface's static side out of ordinary
type positions. It is checked only by class `implements` clauses.
