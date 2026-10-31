import {
    Found,
    Missing,
    UserId,
    loadUser,
    type Lookup,
} from "@tspp/example-typescript-interop";

const id: UserId = UserId("user-1");
const found: Lookup<number> = Found(42);
const missing: Lookup<number> = Missing;
const loaded = loadUser({ id, displayName: " Ada " });

console.log(found, missing, loaded);
