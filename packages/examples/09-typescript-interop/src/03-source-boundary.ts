// @ts-expect-error Ordinary TypeScript sources cannot import TS++ implementation files.
import type { UserId } from "./01-library.tspp";

export type ForbiddenSourceImport = UserId;
