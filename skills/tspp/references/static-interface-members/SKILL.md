---
name: tspp-static-interface-members
description: Declare static interface members in TS++ and troubleshoot static-side requirements on implementing classes.
---

# Static Interface Members

Enable `ts-plus-plus/plugins/static-interface-members`. Static interface members are checked only through a class's `implements` clause. Instance members retain ordinary interface checking; ordinary interface type positions do not include the static side.

```ts
interface Serializable {
    static deserialize(text: string): this;
    serialize(): string;
}
class Box implements Serializable {
    static deserialize(text: string): Box { return new Box(text); }
    constructor(private value: string) {}
    serialize(): string { return this.value; }
}
```

Check missing or incompatible static members, return types, and static requirements inherited from other interfaces. Do not treat instance objects as static constructor contracts. Consult the [plugin documentation](https://github.com/tspp-lang/tspp/blob/v0.1.2/packages/plugins/static-interface-members/README.md) and [examples](https://github.com/tspp-lang/tspp/blob/v0.1.2/packages/examples/04-static-interface-members/src/01-basics.tspp), and verify with a TS++ build.
