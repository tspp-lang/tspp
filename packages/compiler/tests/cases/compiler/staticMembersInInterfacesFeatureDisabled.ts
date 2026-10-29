// @strict: true

interface DisabledStaticContract {
    static create(): DisabledStaticContract;
    value: string;
}

class DisabledStaticImplementation implements DisabledStaticContract {
    static create(): DisabledStaticImplementation {
        return new DisabledStaticImplementation();
    }

    value = "disabled";
}
