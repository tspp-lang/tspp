const test = require("node:test");
const { expectVerification } = require("./analyze.cjs");

const player = ({ heal = "with { requires: 恢复值 > 0; }", construct = "with { requires: 初始生命值 >= 0; }", after = "" } = {}) => `class 玩家 with {
    invariant: 生命值 >= 0;
    numberModel: "mathematical-real";
} {
    private 生命值: number;

    public constructor(初始生命值: number) ${construct} {
        this.生命值 = 初始生命值;
    }

    public 受到伤害(伤害值: number) with { requires: 伤害值 >= 0; }: void {
        this.生命值 = Math.max(0, this.生命值 - 伤害值);
    }

    public 治疗(恢复值: number) ${heal}: void {
        this.生命值 += 恢复值;
    }

    public 获得生命值() with { ensures: result >= 0; }: number {
        return this.生命值;
    }

    public static 创建(): 玩家 {
        return new 玩家(100);
    }
}
${after}`;

const cases = [
  {
    name: "constructor establishes and methods preserve the invariant",
    source: player({ after: `const p = new 玩家(100);
p.治疗(5);
p.受到伤害(200);` }),
  },
  {
    name: "a method that can break the invariant",
    source: player({ heal: "" }),
    rejects: /玩家 invariant '生命值 >= 0' on exit from 治疗 could not be proved/,
  },
  {
    name: "a constructor that can break the invariant",
    source: player({ construct: "" }),
    rejects: /玩家 invariant '生命值 >= 0' after the constructor could not be proved/,
  },
  {
    name: "a call site that violates a method precondition",
    source: player({ after: `const p = new 玩家(100);\np.治疗(-5);` }),
    rejects: /玩家\.治疗 call precondition could not be proved/,
  },
  {
    name: "a call site that violates a constructor precondition",
    source: player({ after: `const p = new 玩家(-1);` }),
    rejects: /玩家\.constructor call precondition could not be proved/,
  },
  {
    name: "a verified function relies on a method postcondition",
    source: player({ after: `function 查看(p: 玩家) with { numberModel: "mathematical-real"; ensures: result >= 0; }: number {
    return p.获得生命值();
}` }),
  },
  {
    name: "a function argument violates a method precondition",
    source: player({ after: `function 施法(p: 玩家, 量: number) with { numberModel: "mathematical-real"; }: void {
    p.治疗(量);
}` }),
    rejects: /玩家\.治疗 call precondition could not be proved/,
  },
  {
    name: "an unknown receiver is reported instead of passing",
    source: player({ after: `function 施法(p: any): void { p.治疗(-5); }` }),
    rejects: /The class of the receiver of '治疗' cannot be determined/,
  },
  {
    name: "field initializers and the implicit constructor",
    source: `class Counter with { invariant: this.count >= 0n; } {
    private count: bigint = 0n;
    increment(): void { this.count += 1n; }
    current() with { ensures: result === this.count; }: bigint { return this.count; }
}`,
  },
  {
    name: "parameter properties",
    source: `class Window with { invariant: limit > 0n; } {
    constructor(private readonly limit: bigint) with { requires: limit > 0n; } {}
    size() with { ensures: result > 0n; }: bigint { return this.limit; }
}`,
  },
  {
    name: "a field the constructor never assigns",
    source: `class Counter with { invariant: this.count >= 0n; } {
    private count: bigint;
    constructor() {}
}`,
    rejects: /'count' may be unassigned here, so the invariant of 'Counter' cannot be checked/,
  },
  {
    name: "a guard that throws before any change",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    withdraw(amount: bigint): void {
        if (amount > this.balance) throw new Error("insufficient funds");
        this.balance -= amount;
    }
}`,
  },
  {
    name: "a throw after the object was changed",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    withdraw(amount: bigint): void {
        this.balance -= amount;
        if (this.balance < 0n) throw new Error("insufficient funds");
    }
}`,
    rejects: /Account invariant 'balance >= 0n' when withdraw throws could not be proved/,
  },
  {
    name: "a call made while the invariant is broken",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    reset(): void {
        this.balance = -1n;
        this.audit();
        this.balance = 0n;
    }
    audit(): void {}
}`,
    rejects: /Account invariant 'balance >= 0n' before calling Account\.audit could not be proved/,
  },
  {
    name: "a private helper whose postcondition the caller uses",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    deposit(amount: bigint) with { requires: amount >= 0n; ensures: result === this.balance; }: bigint {
        this.balance += amount;
        return this.read();
    }
    private read() with { ensures: result === this.balance; }: bigint { return this.balance; }
}`,
  },
  {
    name: "an invariant over a public field",
    source: `class Account with { invariant: balance >= 0n; } { balance: bigint = 0n; }`,
    rejects: /reads 'balance', which code outside the class can write; make the field private or readonly/,
  },
  {
    name: "this escaping its members",
    source: `function keep(value: unknown): void {}
class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    share(): void { keep(this); }
}`,
    rejects: /'this' escapes here, so the invariant of 'Account' cannot be verified/,
  },
  {
    name: "a field written by a closure",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    private drain = () => { this.balance = -1n; };
}`,
    rejects: /'balance' is written inside a function that may run at any time/,
  },
  {
    name: "a field of another instance written directly",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    spoil(other: Account): void { other.balance = -1n; }
}`,
    rejects: /'balance' of another 'Account' is written here/,
  },
  {
    name: "a static member writing an instance field",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    static spoil(other: Account): void { other.balance = -1n; }
}`,
    rejects: /'balance' of another 'Account' is written here/,
  },
  {
    name: "an unmodeled call inside a member",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    log(): void { console.log(this.balance); }
}`,
    rejects: /Account invariant 'balance >= 0n' on exit from log cannot be verified because/,
  },
  {
    name: "a setter run while the invariant is broken",
    source: `class Gauge with { invariant: level >= 0n; } {
    private level = 0n;
    set value(next: bigint) { this.level = next < 0n ? 0n : next; }
    reset(): void { this.level = -1n; this.value = 5n; }
}`,
    rejects: /Gauge invariant 'level >= 0n' on exit from reset cannot be verified because 'this\.value = 5n;'/,
  },
  {
    name: "an invariant on a derived class",
    source: `class Base {}
class Derived with { invariant: value >= 0n; } extends Base { private value: bigint = 0n; }`,
    rejects: /Class invariants are not supported on derived classes yet/,
  },
  {
    name: "a derived constructor violating the base precondition",
    source: `class Base { constructor(size: bigint) with { requires: size > 0n; } {} }
class Derived extends Base { constructor() { super(-1n); } }`,
    rejects: /Base\.constructor call precondition could not be proved/,
  },
  {
    name: "an override of a method with a contract",
    source: `class Base { run(size: bigint) with { requires: size > 0n; }: void {} }
class Derived extends Base { run(size: bigint): void {} }`,
    rejects: /Overriding 'Base\.run', which has a contract, is not supported yet/,
  },
  {
    name: "an async member of a class with an invariant",
    source: `class Account with { invariant: balance >= 0n; } {
    private balance: bigint = 0n;
    async refresh(): Promise<void> {}
}`,
    rejects: /Async and generator members can suspend while the invariant of 'Account' is broken/,
  },
  {
    name: "a number field without a number model",
    source: `class Gauge with { invariant: level >= 0; } { private level: number = 0; }`,
    rejects: /'level'.*(?:numberModel|cannot model)|numberModel/,
  },
  {
    name: "a contract on an object literal method",
    source: `const helper = { run(size: bigint) with { requires: size > 0n; }: void {} };`,
    rejects: /This contract is not verified: only top-level classes/,
  },
  {
    name: "a function property on a class",
    source: `class Account with { requires: true; } {}`,
    rejects: /The 'with' property 'requires' is not supported on a class\./,
  },
  {
    name: "a misspelled member property",
    source: `class Account { run(size: bigint) with { require: size > 0n; }: void {} }`,
    rejects: /The 'with' property 'require' is not supported on a class member\./,
  },
  {
    name: "Unicode names in function contracts",
    source: `function 加一(值: bigint) with { requires: 值 >= 0n; ensures: result > 0n; }: bigint { return 值 + 1n; }`,
  },
  {
    name: "Math.min and Math.abs",
    source: `function clamp(value: number) with { numberModel: "mathematical-real"; ensures: [result <= 10, result >= 0]; }: number {
    return Math.min(10, Math.abs(value));
}`,
  },
];

for (const item of cases) test(item.name, () => expectVerification(item));
