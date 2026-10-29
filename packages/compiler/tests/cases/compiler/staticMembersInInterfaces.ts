// @strict: true
// @declaration: true
// @tsppFeatures: staticInterfaceMembers

interface Serializable {
    static readonly mediaType: string;
    static deserialize(text: string): this;
    serialize(): string;
}

class Good implements Serializable {
    static readonly mediaType = "application/good";

    static deserialize(_text: string): Good {
        return new Good();
    }

    serialize(): string {
        return "good";
    }
}

class MissingStatic implements Serializable {
    serialize(): string {
        return "missing";
    }
}

class WrongStatic implements Serializable {
    static readonly mediaType = 1;

    static deserialize(_text: number): WrongStatic {
        return new WrongStatic();
    }

    serialize(): string {
        return "wrong";
    }
}

class WrongStaticMethod implements Serializable {
    static readonly mediaType = "application/wrong-method";

    static deserialize(_text: number): WrongStaticMethod {
        return new WrongStaticMethod();
    }

    serialize(): string {
        return "wrong method";
    }
}

class MissingInstance implements Serializable {
    static readonly mediaType = "application/missing-instance";

    static deserialize(_text: string): MissingInstance {
        return new MissingInstance();
    }
}

interface VersionedSerializable extends Serializable {
    static fromVersion(version: number): this;
}

class GoodVersioned implements VersionedSerializable {
    static readonly mediaType = "application/versioned";

    static deserialize(_text: string): GoodVersioned {
        return new GoodVersioned();
    }

    static fromVersion(_version: number): GoodVersioned {
        return new GoodVersioned();
    }

    serialize(): string {
        return "versioned";
    }
}

class MissingInheritedStatic implements VersionedSerializable {
    static fromVersion(_version: number): MissingInheritedStatic {
        return new MissingInheritedStatic();
    }

    serialize(): string {
        return "missing inherited";
    }
}

interface MergedStaticContract {
    static first(): void;
}

interface MergedStaticContract {
    static second(): void;
}

class GoodMerged implements MergedStaticContract {
    static first(): void {}
    static second(): void {}
}

declare const serializable: Serializable;
serializable.deserialize("nope");

interface GenericStaticMethod {
    static identity<T>(value: T): T;
}

class GoodGenericStaticMethod implements GenericStaticMethod {
    static identity<T>(value: T): T {
        return value;
    }
}

interface InvalidGenericStatic<T> {
    static create(value: T): InvalidGenericStatic<T>;
}

type InvalidTypeLiteral = {
    static create(): void;
};
