// @ts-expect-error Ordinary TypeScript sources cannot import TS++ implementation files.
import type { UserId } from "./index.tspp";

export type ForbiddenSourceImport = UserId;
